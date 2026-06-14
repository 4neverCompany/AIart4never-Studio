/**
 * Migration: bridge from the existing `useImages` / `useSettings` flat
 * IDB layout to the new post-lifecycle state machine.
 *
 * The current code stores:
 *   - settings.scheduledPosts[]: ScheduledPost[] (flat list)
 *   - settings.carouselGroups[]: CarouselGroup[]
 *   - savedImages: GeneratedImage[] (each with .imageId, .url, etc.)
 *
 * The new state machine wants a single `PostRecord` per post with:
 *   - state: 'draft' | 'image_ready' | 'caption_ready' | 'scheduled' | 'posted' | 'failed' | ...
 *   - imageBlobId: ImageBlobId (the actual image data)
 *   - hostedImageUrl: string (the uguu URL)
 *   - caption, hashtags, scheduledFor, platform
 *
 * Strategy: PARALLEL COEXISTENCE, not a hard cutover.
 *
 * 1. Add a NEW storage key `mashup_post_records` that holds the new
 *    PostRecord[] list. Don't touch the existing settings.scheduledPosts.
 * 2. On first load, run a one-time migration that reads the existing
 *    scheduledPosts + savedImages, builds a PostRecord for each, and
 *    writes them to the new key. Sets a migration flag.
 * 3. The new post-lifecycle code reads/writes only the new key. The old
 *    fields stay where they are for back-compat and rollback.
 * 4. When a post transitions to 'posted' (success) via the new code,
 *    we ALSO update the old settings.scheduledPosts to keep the
 *    PipelinePanel and approval flows in sync — they read the old
 *    format.
 *
 * This means: the new system is opt-in, but once a post has any
 * state-machine interaction, both systems stay in sync. There's no
 * "two systems" — there's one source of truth (PostRecord) and a
 * mirror for legacy UI.
 *
 * Why parallel coexistence: the user already has 16 API routes and
 * 3 hooks (useImages, useSettings, usePipeline) that read the old
 * format. Cutting them all over in one PR is a 2-week refactor.
 * Parallel coexistence ships the v0.9.41 fix TODAY, with the cutover
 * as a follow-up sprint.
 */

import {
  type PostRecord,
  type PostId,
  type ImageBlobId,
  PostId as makePostId,
  ImageBlobId as makeImageBlobId,
} from './types';
import { createDraftPost, transition } from './state-machine';
import { get, set } from '@/lib/persistence';
import type { GeneratedImage, ScheduledPost, UserSettings, CarouselGroup } from '@/types/mashup';

const POST_RECORDS_KEY = 'mashup_post_records';
const MIGRATION_FLAG_KEY = '__post_records_migrated_v1';

interface PersistedState {
  posts: PostRecord[];
}

const emptyState: PersistedState = { posts: [] };

/**
 * Derive a PostRecord `PostId` from a legacy ScheduledPost.id.
 *
 * Mirrors the encoding used by `buildPostRecords` so the React approval
 * handlers can compute the same id and look the record up after
 * migration. Encoded as `post_<sanitized>` where the sanitized tail is
 * the ScheduledPost.id with non-alphanumeric chars stripped, padded to
 * at least 8 chars, then truncated to 16. This is a one-way mapping —
 * we never need to invert it, and a stable hash of the legacy id is
 * good enough for join purposes (the PostRecord's own `ideaId` and
 * `imageBlobId` are the canonical foreign keys, this id is just a
 * stable lookup key).
 *
 * Throws if the resulting id fails the `PostId` brand check (which
 * means a legacy post id that sanitizes to fewer than 6 alphanum
 * chars — caller's bug).
 */
export function postIdFromScheduledPostId(scheduledPostId: string): PostId {
  return makePostId(
    `post_${scheduledPostId
      .replace(/[^A-Za-z0-9_-]/g, '')
      .padEnd(8, 'x')
      .slice(0, 16)}`,
  );
}

/**
 * Read the current PostRecord[] from storage. Returns empty array
 * on first run.
 */
export async function loadPostRecords(): Promise<PostRecord[]> {
  const v = await get<PersistedState>(POST_RECORDS_KEY);
  return v?.posts ?? [];
}

/**
 * Write the full PostRecord[] to storage. The atomic write contract
 * from PostLifecycleStorage is what we want here; for the
 * v0.9.41-prevention work, this is a one-shot write that either
 * commits fully or rolls back fully.
 *
 * For the persistence layer's transactional guarantee, use the
 * `savePostWithBlob` from the state-machine persistence module
 * when you have a blob to write alongside. For PostRecord-only
 * updates (state transitions, caption edits, etc.), this function
 * is the entry point.
 */
export async function savePostRecords(posts: PostRecord[]): Promise<void> {
  await set(POST_RECORDS_KEY, { posts });
}

/**
 * Run the one-time migration from the old settings.scheduledPosts +
 * settings.carouselGroups + savedImages shape to the new PostRecord[]
 * shape. Idempotent: the migration flag prevents re-runs.
 *
 * Idempotency check: if the flag is set, return existing records
 * without rebuilding. If not set:
 *   1. Read settings (synchronously from the existing IDB key)
 *   2. Build PostRecord[] for every scheduled post
 *   3. Write the new key
 *   4. Set the flag
 *   5. Return the new records
 */
export async function runMigrationIfNeeded(): Promise<PostRecord[]> {
  const existing = await loadPostRecords();
  const flag = await get(MIGRATION_FLAG_KEY);
  if (flag) return existing;

  const settings = await get<UserSettings>('mashup_settings');
  if (!settings) {
    // No settings yet — mark migrated so we don't loop on every load.
    await set(MIGRATION_FLAG_KEY, { at: new Date().toISOString() });
    return [];
  }

  const images = await get<GeneratedImage[]>('mashup_saved_images');
  const imageById = new Map((images ?? []).map((i) => [i.id, i]));

  const records = buildPostRecords(
    settings.scheduledPosts ?? [],
    settings.carouselGroups ?? [],
    imageById,
  );

  await savePostRecords(records);
  await set(MIGRATION_FLAG_KEY, { at: new Date().toISOString() });
  return records;
}

/**
 * Build PostRecord[] from the legacy settings.scheduledPosts +
 * carouselGroups shape. Pure function — testable.
 *
 * For each scheduled post, derive a state from its status:
 *   - 'pending_approval' → 'image_ready' (it's ready, just needs approval)
 *   - 'scheduled'         → 'scheduled'
 *   - 'posted'            → 'posted'
 *   - 'failed'            → 'failed' (with reason)
 *   - 'rejected'          → 'draft' (user can edit + re-approve)
 */
export function buildPostRecords(
  scheduledPosts: readonly ScheduledPost[],
  carouselGroups: readonly CarouselGroup[],
  imageById: ReadonlyMap<string, GeneratedImage>,
): PostRecord[] {
  const now = new Date().toISOString();
  const records: PostRecord[] = [];

  for (const post of scheduledPosts) {
    const image = imageById.get(post.imageId);
    const postId = makePostId(`post_${post.id.replace(/[^A-Za-z0-9_-]/g, '').padEnd(8, 'x').slice(0, 16)}`);

    // Skip if the post references an image we don't have — this is
    // the v0.9.41 shape (post exists, image missing). The reconciler
    // will catch this on the next run and transition it to 'failed'
    // with reason 'image_missing'. For now, build a 'failed' record
    // with the appropriate reason so the UI shows it correctly.
    if (!image) {
      let draft = createDraftPost({ id: postId, ideaId: post.sourceIdeaId ?? null });
      draft = transition(draft, 'failed', {
        reason: 'image_missing',
        note: `Migration: image ${post.imageId} not found at migration time`,
      });
      records.push(draft);
      continue;
    }

    let record = createDraftPost({ id: postId, ideaId: post.sourceIdeaId ?? null });
    // Walk through the lifecycle to set state. The transition()
    // function enforces the state graph; we just need to feed it the
    // right starting post-state.
    record.imageBlobId = image.id ? makeImageBlobId(`blob_${image.id.replace(/[^A-Za-z0-9_-]/g, '').padEnd(8, 'x').slice(0, 16)}`) : null;
    record.hostedImageUrl = image.url ?? null;
    record.caption = post.caption;
    record.hashtags = []; // post.caption may contain hashtags; this is the structured list
    record.scheduledFor = post.date && post.time ? `${post.date}T${post.time}:00.000Z` : null;
    record.platform = (post.platforms?.[0] as 'instagram' | 'twitter' | 'both' | null) ?? null;
    record.imageModelId = image.modelInfo?.modelId ?? null;

    // Walk to the right state based on the post's status field.
    // The state machine enforces the graph: draft can only go to
    // generating_image (not directly to image_ready), so every
    // branch must walk through generating_image first.
    if (post.status === 'pending_approval') {
      record = transition(record, 'generating_image', { note: 'Migrated' });
      record = transition(record, 'image_ready', { note: 'Migrated from pending_approval' });
    } else if (post.status === 'scheduled') {
      record = transition(record, 'generating_image', { note: 'Migrated' });
      record = transition(record, 'image_ready', { note: 'Migrated' });
      record = transition(record, 'captioning', { note: 'Caption migrated' });
      record = transition(record, 'caption_ready', { note: 'Caption migrated' });
      record = transition(record, 'scheduled', { note: 'Migrated from scheduled' });
    } else if (post.status === 'posted') {
      record = transition(record, 'generating_image', { note: 'Migrated' });
      record = transition(record, 'image_ready', { note: 'Migrated' });
      record = transition(record, 'captioning', { note: 'Caption migrated' });
      record = transition(record, 'caption_ready', { note: 'Caption migrated' });
      record = transition(record, 'scheduled', { note: 'Migrated' });
      record = transition(record, 'posting', { note: 'Migrated' });
      record = transition(record, 'posted', { note: 'Migrated from posted' });
    } else if (post.status === 'rejected') {
      // Rejected posts go back to draft for the user to re-edit.
      // (Failed posts that the user marked rejected.)
    }
    // 'failed' or undefined → leave in 'draft' (or 'failed' if we
    // could derive a reason; we don't have one from the legacy
    // shape, so draft is the safe choice)

    records.push(record);
  }

  // Stash a metadata record for the carousel groups (so we can
  // reconstruct them if needed). We don't have a typed CarouselGroup
  // field on PostRecord; the carouselGroupId on each post is the
  // join key.
  void carouselGroups; // currently unused at the PostRecord level

  return records;
}

/**
 * Sync a PostRecord back to the legacy settings.scheduledPosts shape.
 * Called after a state transition so the PipelinePanel and approval
 * flows keep working.
 */
export function syncLegacyScheduledPost(
  record: PostRecord,
  originalPost: ScheduledPost,
): ScheduledPost {
  let status: ScheduledPost['status'];
  switch (record.state) {
    case 'draft':
    case 'generating_image':
    case 'image_ready':
    case 'captioning':
    case 'caption_ready':
      status = 'pending_approval';
      break;
    case 'scheduled':
      status = 'scheduled';
      break;
    case 'posting':
    case 'posted':
      status = 'posted';
      break;
    case 'failed':
      status = 'failed';
      break;
    default:
      status = originalPost.status;
  }

  return {
    ...originalPost,
    status,
    caption: record.caption ?? originalPost.caption,
  };
}

/**
 * Apply a state transition to a PostRecord and persist the result.
 * Also mirrors the change to the legacy settings.scheduledPosts
 * field so the rest of the app keeps working.
 *
 * @returns the updated PostRecord
 */
export interface ApplyTransitionOptions {
  /**
   * Skip the legacy mirror-back. Set this when the caller has
   * already updated the legacy `settings.scheduledPosts` field
   * synchronously (e.g. MashupContext.approveScheduledPost flips
   * the legacy status to 'scheduled' before the async
   * applyTransition call resolves). Without this flag the mirror
   * would overwrite that synchronous write with whatever the new
   * state maps to in syncLegacyScheduledPost — 'image_ready' /
   * 'caption_ready' both map to 'pending_approval', undoing the
   * approve action.
   */
  skipMirror?: boolean;
}

export async function applyTransition(
  postId: PostId,
  to: PostRecord['state'],
  opts: Parameters<typeof transition>[2] = {},
  applyOpts: ApplyTransitionOptions = {},
): Promise<PostRecord> {
  const posts = await loadPostRecords();
  const idx = posts.findIndex((p) => p.id === postId);
  if (idx < 0) throw new Error(`Post ${postId} not found`);

  const current = posts[idx];

  // Idempotent: if the post is already in the target state, the call
  // is a no-op. Approval actions are idempotent at the approval-action
  // level (planApproveScheduledPost returns empty toFinalize for posts
  // that aren't pending_approval), so the new system mirrors that.
  // Throwing InvalidTransitionError on a double-click would be hostile
  // UX — a user mashing "Approve" should not crash the app. We return
  // the current record unchanged and skip the mirror-back (the React
  // handler has already done the legacy field update synchronously).
  if (current.state === to) {
    return current;
  }

  const next = transition(current, to, opts);
  posts[idx] = next;
  await savePostRecords(posts);

  // Mirror to the legacy field. Find the corresponding scheduled post
  // by imageId (the legacy key) and update its status.
  // Note: this is a read-modify-write of the settings; if it fails,
  // the new state is preserved (we just lost the legacy mirror).
  // Acceptable for v0.9.41 prevention — the new system is the
  // source of truth; the legacy mirror is a UX courtesy for the
  // not-yet-migrated PipelinePanel.
  //
  // skipMirror is set by callers that have already updated the
  // legacy field synchronously (e.g. MashupContext.approveScheduledPost
  // runs `updateSettings` to flip the legacy status, then awaits this
  // call). The mirror would otherwise overwrite the synchronous
  // write with `syncLegacyScheduledPost`'s naive state→status mapping.
  if (!applyOpts.skipMirror && next.imageBlobId) {
    try {
      const settings = await get<UserSettings>('mashup_settings');
      if (settings?.scheduledPosts) {
        const updated = settings.scheduledPosts.map((sp) => {
          // Match by imageId → blobId is "blob_<id>", so the
          // imageId from the post ID is the key
          const imageIdMatch = `blob_${sp.imageId.replace(/[^A-Za-z0-9_-]/g, '').padEnd(8, 'x').slice(0, 16)}`;
          if (imageIdMatch === next.imageBlobId) {
            return syncLegacyScheduledPost(next, sp);
          }
          return sp;
        });
        await set('mashup_settings', { ...settings, scheduledPosts: updated });
      }
    } catch (e) {
      // Best-effort — the new system is the source of truth.
      console.warn('[applyTransition] legacy mirror failed', e);
    }
  }

  return next;
}
