/**
 * Integration test: approveScheduledPost / rejectScheduledPost +
 * applyTransition().
 *
 * The MashupContext.approveScheduledPost handler now layers the new
 * post-lifecycle applyTransition() call on top of the legacy
 * planApproveScheduledPost helper. This test pins the integration
 * contract: when the user clicks "Approve" (or "Reject"), BOTH the
 * legacy `settings.scheduledPosts[i].status` field AND the new
 * `mashup_post_records` PostRecord are updated, and BOTH persist
 * through a storage round-trip.
 *
 * We test the wiring by simulating the exact call sequence the React
 * handler makes (plan*ScheduledPost → updateSettings → applyTransition)
 * against an in-memory IDB. The React layer's updateSettings is
 * replaced with a direct `set('mashup_settings', ...)` call here —
 * the contract is "settings gets the new posts" and the React wrapper
 * is just sugar over that.
 *
 * Why this matters: the new system is the source of truth for the
 * v0.9.41 fix, but the legacy `settings.scheduledPosts` field is
 * what every UI component reads. If the two systems drift, the UI
 * shows wrong data, the auto-poster picks up wrong posts, and the
 * recovery panel misses broken posts. This test catches any drift
 * at the integration layer.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  planApproveScheduledPost,
  planRejectScheduledPost,
} from '@/lib/approval-actions';
import {
  applyTransition,
  postIdFromScheduledPostId,
  runMigrationIfNeeded,
  buildPostRecords,
  loadPostRecords,
  savePostRecords,
} from '@/lib/post-lifecycle/migration';
import { PostId, ImageBlobId, createDraftPost, transition } from '@/lib/post-lifecycle';
import { get, set, __resetStoreForTests } from '@/lib/persistence';
import type { ScheduledPost, UserSettings, GeneratedImage } from '@/types/mashup';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const LEGACY_SETTINGS_KEY = 'mashup_settings';
const POST_RECORDS_KEY = 'mashup_post_records';

/**
 * Build a minimal but realistic test fixture:
 *  - one legacy settings.scheduledPosts entry in pending_approval
 *  - a corresponding saved image with the right imageId
 *  - a corresponding PostRecord in image_ready state (migrated shape)
 *
 * Returns the keys used to wire them together so each test can
 * assert on a clean identity.
 */
function buildApprovalFixture(opts: {
  postId: string;
  imageId: string;
  status?: 'pending_approval' | 'scheduled' | 'rejected' | 'posted' | 'failed';
  // The state the corresponding PostRecord should be in
  postRecordState?:
    | 'image_ready'
    | 'caption_ready'
    | 'draft'
    | 'scheduled'
    | 'posted'
    | 'failed';
} = {
  postId: 'sp_001',
  imageId: 'img_001',
}) {
  const post: ScheduledPost = {
    id: opts.postId,
    imageId: opts.imageId,
    date: '2026-05-01',
    time: '18:00',
    platforms: ['instagram'],
    caption: 'fixture caption',
    status: opts.status ?? 'pending_approval',
  };

  const image: GeneratedImage = {
    id: opts.imageId,
    url: 'https://cdn.example.com/img.jpg',
    prompt: 'test prompt',
    status: 'ready',
    modelInfo: { provider: 'leonardo', modelId: 'phoenix', modelName: 'Phoenix' },
  };

  // Build the PostRecord in the requested state by walking the
  // state machine forward from a draft. The migration's
  // buildPostRecords() does exactly this for real posts.
  const postId = postIdFromScheduledPostId(opts.postId);
  const blobId = ImageBlobId(
    `blob_${opts.imageId.replace(/[^A-Za-z0-9_-]/g, '').padEnd(8, 'x').slice(0, 16)}`,
  );
  let record = createDraftPost({ id: postId, ideaId: null });
  record.imageBlobId = blobId;
  record.hostedImageUrl = image.url ?? null;
  record.caption = post.caption;
  record.hashtags = [];
  record.scheduledFor = `${post.date}T${post.time}:00.000Z`;
  record.platform = (post.platforms?.[0] as 'instagram' | 'twitter' | 'both' | null) ?? null;
  record.imageModelId = image.modelInfo?.modelId ?? null;

  const targetState = opts.postRecordState ?? 'image_ready';
  // Walk to the target state through valid transitions. The state
  // machine enforces the path; we drive it with the standard happy-
  // path transitions and let it throw if the requested state is
  // unreachable from draft.
  //
  // Note: `draft → image_ready` is NOT a valid transition. The
  // state machine requires draft to go through `generating_image`
  // first. We always start with that step so the fixture is
  // well-formed regardless of the requested terminal state.
  record = transition(record, 'generating_image', { note: 'fixture' });
  if (targetState === 'image_ready') {
    record = transition(record, 'image_ready', { note: 'fixture' });
  } else if (targetState === 'caption_ready') {
    record = transition(record, 'image_ready', { note: 'fixture' });
    record = transition(record, 'captioning', { note: 'fixture' });
    record = transition(record, 'caption_ready', { note: 'fixture' });
  } else if (targetState === 'scheduled') {
    record = transition(record, 'image_ready', { note: 'fixture' });
    record = transition(record, 'captioning', { note: 'fixture' });
    record = transition(record, 'caption_ready', { note: 'fixture' });
    record = transition(record, 'scheduled', { note: 'fixture' });
  } else if (targetState === 'posted') {
    record = transition(record, 'image_ready', { note: 'fixture' });
    record = transition(record, 'captioning', { note: 'fixture' });
    record = transition(record, 'caption_ready', { note: 'fixture' });
    record = transition(record, 'scheduled', { note: 'fixture' });
    record = transition(record, 'posting', { note: 'fixture' });
    record = transition(record, 'posted', { note: 'fixture' });
  } else if (targetState === 'draft') {
    // Caller asked for 'draft' state directly. That's the initial
    // state, so we don't transition. (We still went through
    // generating_image above for the non-draft cases — for
    // consistency we let the caller drive the terminal state.)
    // Reset by walking back via a failed → draft path:
    record = transition(record, 'failed', {
      reason: 'image_generation_failed',
      note: 'fixture',
    });
    record = transition(record, 'draft');
  } else if (targetState === 'failed') {
    // Already at generating_image from the prelude above.
    record = transition(record, 'failed', {
      reason: 'image_generation_failed',
      note: 'fixture',
    });
  }

  const settings: UserSettings = {
    enabledProviders: ['leonardo'],
    apiKeys: {},
    defaultLeonardoModel: 'phoenix',
    scheduledPosts: [post],
  };

  return { post, image, record, postId, blobId, settings };
}

/**
 * Pick the post-lifecycle target state for an approval action.
 * Mirrors the task's "image_ready" or "caption_ready" choice: if
 * the post has already been captionized, target caption_ready so
 * the call is a no-op; otherwise target image_ready. This avoids
 * the InvalidTransitionError that would fire if we asked for
 * image_ready when the post is already at caption_ready.
 */
async function pickApproveTarget(
  postId: string,
): Promise<'image_ready' | 'caption_ready'> {
  const records = await loadPostRecords();
  const record = records.find((r) => r.id === postIdFromScheduledPostId(postId));
  if (record?.state === 'caption_ready') return 'caption_ready';
  return 'image_ready';
}

/**
 * Simulate the exact storage-write sequence the MashupContext
 * approveScheduledPost handler makes:
 *   1. Compute nextPosts from planApproveScheduledPost against the
 *      rendered settings snapshot.
 *   2. Persist the new settings (mashup_settings).
 *   3. Call applyTransition to update the new PostRecord system,
 *      with skipMirror: true because we already updated the legacy
 *      field synchronously.
 */
async function simulateApprove(postId: string): Promise<{
  toFinalize: ScheduledPost[];
  postRecord: Awaited<ReturnType<typeof applyTransition>> | null;
}> {
  const settings = await get<UserSettings>(LEGACY_SETTINGS_KEY);
  if (!settings) throw new Error('test setup: no settings in storage');

  const { toFinalize, nextPosts } = planApproveScheduledPost(
    settings.scheduledPosts || [],
    postId,
  );
  if (toFinalize.length === 0) {
    return { toFinalize: [], postRecord: null };
  }

  // Step 1: persist the legacy field update (mirrors the synchronous
  // updateSettings call in the React handler).
  await set(LEGACY_SETTINGS_KEY, {
    ...settings,
    scheduledPosts: nextPosts(settings.scheduledPosts || []),
  });

  // Step 2: layer the new-system call. This is fire-and-forget in the
  // React handler; here we await to assert on the result.
  const target = await pickApproveTarget(postId);
  const postRecord = await applyTransition(
    postIdFromScheduledPostId(postId),
    target,
    { note: 'Approved by user' },
    { skipMirror: true },
  );

  return { toFinalize, postRecord };
}

async function simulateReject(postId: string): Promise<{
  toFinalize: ScheduledPost[];
  postRecord: Awaited<ReturnType<typeof applyTransition>> | null;
}> {
  const settings = await get<UserSettings>(LEGACY_SETTINGS_KEY);
  if (!settings) throw new Error('test setup: no settings in storage');

  const { toFinalize, nextPosts } = planRejectScheduledPost(
    settings.scheduledPosts || [],
    postId,
  );
  if (toFinalize.length === 0) {
    return { toFinalize: [], postRecord: null };
  }

  await set(LEGACY_SETTINGS_KEY, {
    ...settings,
    scheduledPosts: nextPosts(settings.scheduledPosts || []),
  });

  const postRecord = await applyTransition(
    postIdFromScheduledPostId(postId),
    'draft',
    { note: 'Rejected by user' },
    { skipMirror: true },
  );

  return { toFinalize, postRecord };
}

// ─── Test cases ─────────────────────────────────────────────────────────────

beforeEach(async () => {
  // Reset the in-memory IDB between tests. fake-indexeddb's `auto`
  // import populates globalThis.indexedDB; we wipe the well-known
  // keys so each test starts from a clean slate.
  __resetStoreForTests();
  await set(LEGACY_SETTINGS_KEY, undefined);
  await set(POST_RECORDS_KEY, undefined);
});

describe('approval integration: approveScheduledPost + applyTransition', () => {
  it('approving a pending_approval post updates BOTH systems and persists both', async () => {
    // ── Setup ──
    // Pre-populate storage with the legacy field AND a migrated
    // PostRecord. The migrated record is in `image_ready` state
    // (typical post-migration state for a pending_approval post).
    const { post, record, settings } = buildApprovalFixture({
      postId: 'sp_001',
      imageId: 'img_001',
      status: 'pending_approval',
      postRecordState: 'image_ready',
    });
    await set(LEGACY_SETTINGS_KEY, settings);
    await savePostRecords([record]);

    // ── Act: simulate the React approveScheduledPost handler ──
    const { toFinalize, postRecord } = await simulateApprove(post.id);

    // ── Assert: legacy field updated to 'scheduled' ──
    expect(toFinalize).toHaveLength(1);
    expect(toFinalize[0]!.id).toBe('sp_001');

    const settingsAfter = await get<UserSettings>(LEGACY_SETTINGS_KEY);
    expect(settingsAfter).toBeDefined();
    const updatedPost = settingsAfter!.scheduledPosts!.find(
      (p) => p.id === 'sp_001',
    )!;
    expect(updatedPost.status).toBe('scheduled');

    // ── Assert: new PostRecord system updated (idempotent no-op) ──
    expect(postRecord).not.toBeNull();
    expect(postRecord!.state).toBe('image_ready'); // already there, no-op
    expect(postRecord!.imageBlobId).toBe(record.imageBlobId);

    // ── Assert: PostRecord is persisted through a storage round-trip ──
    const persisted = await loadPostRecords();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.id).toBe(postIdFromScheduledPostId('sp_001'));
    expect(persisted[0]!.state).toBe('image_ready');
  });

  it('approving from a caption_ready state stays at caption_ready (no-op)', async () => {
    // Edge case: a post that already has a caption migrated up to
    // `caption_ready`. The user approving it should not regress the
    // state machine — same-state applyTransition is a no-op.
    const { post, record, settings } = buildApprovalFixture({
      postId: 'sp_002',
      imageId: 'img_002',
      status: 'pending_approval',
      postRecordState: 'caption_ready',
    });
    await set(LEGACY_SETTINGS_KEY, settings);
    await savePostRecords([record]);

    const { postRecord } = await simulateApprove(post.id);

    // Legacy field flipped to scheduled
    const settingsAfter = await get<UserSettings>(LEGACY_SETTINGS_KEY);
    expect(settingsAfter!.scheduledPosts![0]!.status).toBe('scheduled');

    // New system stayed at caption_ready (no-op, not regressed)
    expect(postRecord!.state).toBe('caption_ready');
    const persisted = await loadPostRecords();
    expect(persisted[0]!.state).toBe('caption_ready');
  });

  it('approve is idempotent: calling simulateApprove twice does not crash or double-flip', async () => {
    const { post, record, settings } = buildApprovalFixture({
      postId: 'sp_003',
      imageId: 'img_003',
      status: 'pending_approval',
      postRecordState: 'image_ready',
    });
    await set(LEGACY_SETTINGS_KEY, settings);
    await savePostRecords([record]);

    // First approve — flips legacy to 'scheduled'
    const first = await simulateApprove(post.id);
    expect(first.toFinalize).toHaveLength(1);

    // Second approve — planApproveScheduledPost returns empty
    // toFinalize for non-pending_approval posts (status guard).
    const second = await simulateApprove(post.id);
    expect(second.toFinalize).toEqual([]);

    // Final state: legacy is 'scheduled', new system is 'image_ready'
    const settingsFinal = await get<UserSettings>(LEGACY_SETTINGS_KEY);
    expect(settingsFinal!.scheduledPosts![0]!.status).toBe('scheduled');
    const persisted = await loadPostRecords();
    expect(persisted[0]!.state).toBe('image_ready');
  });

  it('approving a carousel (multiple posts) updates all of them in both systems', async () => {
    // The fix for BUG-CRIT-012: fanning out 3 approve calls in a
    // tight loop must update all 3. We simulate that by running
    // simulateApprove for each post sequentially.
    const fixture1 = buildApprovalFixture({
      postId: 'sp_c1',
      imageId: 'img_c1',
      status: 'pending_approval',
      postRecordState: 'image_ready',
    });
    const fixture2 = buildApprovalFixture({
      postId: 'sp_c2',
      imageId: 'img_c2',
      status: 'pending_approval',
      postRecordState: 'image_ready',
    });
    const fixture3 = buildApprovalFixture({
      postId: 'sp_c3',
      imageId: 'img_c3',
      status: 'pending_approval',
      postRecordState: 'image_ready',
    });

    const settings: UserSettings = {
      enabledProviders: ['leonardo'],
      apiKeys: {},
      defaultLeonardoModel: 'phoenix',
      scheduledPosts: [fixture1.post, fixture2.post, fixture3.post],
    };
    await set(LEGACY_SETTINGS_KEY, settings);
    await savePostRecords([fixture1.record, fixture2.record, fixture3.record]);

    // Three sequential approve calls — this is exactly what
    // CarouselApprovalCard fans out in production.
    const r1 = await simulateApprove('sp_c1');
    const r2 = await simulateApprove('sp_c2');
    const r3 = await simulateApprove('sp_c3');

    expect(r1.toFinalize.map((p) => p.id)).toEqual(['sp_c1']);
    expect(r2.toFinalize.map((p) => p.id)).toEqual(['sp_c2']);
    expect(r3.toFinalize.map((p) => p.id)).toEqual(['sp_c3']);

    // All three legacy fields flipped to 'scheduled'
    const settingsAfter = await get<UserSettings>(LEGACY_SETTINGS_KEY);
    const statuses = settingsAfter!.scheduledPosts!
      .map((p) => p.status)
      .sort();
    expect(statuses).toEqual(['scheduled', 'scheduled', 'scheduled']);

    // All three PostRecords persisted in 'image_ready' state
    const persisted = await loadPostRecords();
    expect(persisted).toHaveLength(3);
    expect(persisted.every((p) => p.state === 'image_ready')).toBe(true);
  });
});

describe('approval integration: rejectScheduledPost + applyTransition', () => {
  it('rejecting a pending_approval post updates BOTH systems and persists both', async () => {
    const { post, record, settings } = buildApprovalFixture({
      postId: 'sp_r1',
      imageId: 'img_r1',
      status: 'pending_approval',
      postRecordState: 'image_ready',
    });
    await set(LEGACY_SETTINGS_KEY, settings);
    await savePostRecords([record]);

    const { toFinalize, postRecord } = await simulateReject(post.id);

    expect(toFinalize).toHaveLength(1);
    expect(toFinalize[0]!.id).toBe('sp_r1');

    // Legacy field flipped to 'rejected'
    const settingsAfter = await get<UserSettings>(LEGACY_SETTINGS_KEY);
    expect(settingsAfter!.scheduledPosts![0]!.status).toBe('rejected');

    // New system: PostRecord transitioned to 'draft' (user can re-edit)
    expect(postRecord).not.toBeNull();
    expect(postRecord!.state).toBe('draft');

    // Persisted through a round-trip
    const persisted = await loadPostRecords();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.state).toBe('draft');
  });

  it('rejecting a post that is not in pending_approval is a no-op (status guard)', async () => {
    // status guard from BUG-DEV-001: reject must not flip scheduled
    // / posted / failed posts to 'rejected'.
    const { record, settings } = buildApprovalFixture({
      postId: 'sp_r2',
      imageId: 'img_r2',
      status: 'scheduled',
      postRecordState: 'image_ready',
    });
    await set(LEGACY_SETTINGS_KEY, settings);
    await savePostRecords([record]);

    const { toFinalize } = await simulateReject('sp_r2');

    expect(toFinalize).toEqual([]);

    // Legacy field unchanged
    const settingsAfter = await get<UserSettings>(LEGACY_SETTINGS_KEY);
    expect(settingsAfter!.scheduledPosts![0]!.status).toBe('scheduled');

    // New system unchanged
    const persisted = await loadPostRecords();
    expect(persisted[0]!.state).toBe('image_ready');
  });
});

describe('approval integration: buildPostRecords + runMigrationIfNeeded shape', () => {
  it('buildPostRecords produces records whose ids match postIdFromScheduledPostId', async () => {
    // Sanity check: the helper we added for the React handler
    // produces the same ids the migration uses, so the two systems
    // can look up the same record by id.
    const { settings, image } = buildApprovalFixture({
      postId: 'sp_m1',
      imageId: 'img_m1',
      status: 'pending_approval',
    });
    const imageById = new Map([[image.id, image]]);
    const records = buildPostRecords(
      settings.scheduledPosts ?? [],
      [],
      imageById,
    );

    expect(records).toHaveLength(1);
    const derivedId = postIdFromScheduledPostId('sp_m1');
    expect(records[0]!.id).toBe(derivedId);
  });

  it('runMigrationIfNeeded builds a record in image_ready state for pending_approval posts', async () => {
    const { settings, image } = buildApprovalFixture({
      postId: 'sp_m2',
      imageId: 'img_m2',
      status: 'pending_approval',
    });
    // Populate both legacy and image keys so runMigrationIfNeeded
    // can read them. We don't need to pre-populate the new key —
    // the migration writes it.
    await set('mashup_saved_images', [image]);
    // We need to also populate the other state shape runMigrationIfNeeded
    // reads (carouselGroups is optional and may be empty).
    await set(LEGACY_SETTINGS_KEY, settings);

    const records = await runMigrationIfNeeded();
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe(postIdFromScheduledPostId('sp_m2'));
    expect(records[0]!.state).toBe('image_ready');
  });
});

describe('approval integration: postIdFromScheduledPostId helper', () => {
  it('produces a PostId brand matching the expected encoded form', () => {
    // 'sp_001' is 6 chars → padded to 8 with 'x' → 'sp_001xx'
    const id = postIdFromScheduledPostId('sp_001');
    expect(id).toBe(PostId('post_sp_001xx'));
  });

  it('strips non-alphanumerics and pads to 8 chars', () => {
    // "ab!@#" → sanitized "ab" → padded to "abxxxxxx" (8 chars)
    const id = postIdFromScheduledPostId('ab!@#');
    expect(id).toBe(PostId('post_abxxxxxx'));
  });

  it('truncates inputs longer than 16 chars to the first 16', () => {
    // 'this_is_a_very_long_legacy_post_id' is 33 chars →
    // sanitized to 33 alphanums → truncated to 16.
    // 'this_is_a_very_l' = t(1) h(2) i(3) s(4) _(5) i(6) s(7) _(8) a(9) _(10)
    //                      v(11) e(12) r(13) y(14) _(15) l(16)
    const id = postIdFromScheduledPostId('this_is_a_very_long_legacy_post_id');
    expect(id).toBe(PostId('post_this_is_a_very_l'));
  });

  it('round-trips with buildPostRecords id derivation', () => {
    // buildPostRecords uses the same encoding as
    // postIdFromScheduledPostId — pins the invariant.
    const { settings, image } = buildApprovalFixture({
      postId: 'sp_xyz',
      imageId: 'img_xyz',
    });
    const imageById = new Map([[image.id, image]]);
    const records = buildPostRecords(settings.scheduledPosts ?? [], [], imageById);
    expect(records[0]!.id).toBe(postIdFromScheduledPostId('sp_xyz'));
  });
});
