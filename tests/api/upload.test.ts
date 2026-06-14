/**
 * /api/upload contract tests.
 *
 * Covers both branches of the refactored route:
 *   1. Legacy multipart (no postId) — uguu-only, returns { url }.
 *   2. New postId-aware flow — looks up the post, uploads to uguu, and
 *      atomically transitions it to 'captioning' with hostedImageUrl
 *      stamped on the returned record. On uguu failure, transitions the
 *      post to 'failed' with reason 'image_upload_failed' and returns
 *      HTTP 502 with the failed record in the body.
 *
 * The route reads/writes through @/lib/persistence (the IDB / tauri
 * wrapper). Under jsdom + the non-Tauri fallback that wraps idb-keyval,
 * we mock idb-keyval with a Map-backed store so the migration bridge's
 * loadPostRecords / applyTransition see deterministic state. We also
 * stub globalThis.fetch to intercept the uguu upload so the tests run
 * offline.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// In-memory store backing the idb-keyval fallback that lib/persistence
// reaches in non-Tauri (jsdom) test runs. The migration bridge reads/
// writes through the same surface as production.
const store = new Map<unknown, unknown>();

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: unknown) => store.get(key)),
  set: vi.fn(async (key: unknown, value: unknown) => {
    store.set(key, value);
  }),
}));

// Imports AFTER the mock so module-init picks up the mock.
const { POST: uploadPost } = await import('@/app/api/upload/route');
const lifecycle = await import('@/lib/post-lifecycle');
const PostId = lifecycle.PostId;
const createDraftPost = lifecycle.createDraftPost;
const transition = lifecycle.transition;
const loadPostRecords = lifecycle.loadPostRecords;
type PostRecord = import('@/lib/post-lifecycle').PostRecord;
type PostIdT = import('@/lib/post-lifecycle').PostId;

const TEST_POST_ID: PostIdT = PostId('post_abc1234');

/** Seed a post in the storage layer, optionally pre-advanced. */
async function seedPost(state: PostRecord['state'] = 'image_ready'): Promise<PostRecord> {
  let post = createDraftPost({ id: TEST_POST_ID, ideaId: null });
  // Walk to the requested state via the real state machine so the
  // transition table guards the seed.
  switch (state) {
    case 'draft':
      break;
    case 'image_ready':
      post = transition(post, 'generating_image', { note: 'seed' });
      post = transition(post, 'image_ready', { note: 'seed' });
      break;
    case 'captioning':
      post = transition(post, 'generating_image', { note: 'seed' });
      post = transition(post, 'image_ready', { note: 'seed' });
      post = transition(post, 'captioning', { note: 'seed' });
      break;
    default:
      throw new Error(`seedPost: unsupported state ${state}`);
  }
  await store.set('mashup_post_records', { posts: [post] });
  return post;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  store.clear();
  // Mirror the @/lib/persistence mock surface — keep tests independent.
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Build a fake uguu success response. */
function fakeUguuSuccess(url: string): Response {
  return new Response(
    JSON.stringify({ success: true, files: [{ url, hash: 'h', filename: 'image.jpg', size: 1234 }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** Build a fake uguu failure response. */
function fakeUguuFailure(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ── Legacy path ──────────────────────────────────────────────────────────

describe('POST /api/upload — legacy multipart path (no postId)', () => {
  it('returns just the hosted URL on success', async () => {
    fetchMock.mockResolvedValueOnce(fakeUguuSuccess('https://uguu.se/files/abc.jpg'));

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' }), 'cat.jpg');

    const req = new Request('http://x/api/upload', { method: 'POST', body: form });
    const res = await uploadPost(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url?: string; post?: unknown };
    expect(body.url).toBe('https://uguu.se/files/abc.jpg');
    // No `post` field in the legacy response — callers that don't pass
    // postId get the pre-v0.9.41 contract back.
    expect(body.post).toBeUndefined();
    // No persistence side-effect on the post-lifecycle key.
    expect(store.has('mashup_post_records')).toBe(false);
  });

  it('returns 502 when uguu rejects the upload', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeUguuFailure(502, { success: false, error: 'bandwidth exceeded' }),
    );

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' }), 'cat.jpg');

    const req = new Request('http://x/api/upload', { method: 'POST', body: form });
    const res = await uploadPost(req);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/uguu/);
  });

  it('returns 400 when no file part is present', async () => {
    const form = new FormData();
    form.append('other', 'value');
    const req = new Request('http://x/api/upload', { method: 'POST', body: form });
    const res = await uploadPost(req);
    expect(res.status).toBe(400);
  });
});

// ── PostId-aware path ────────────────────────────────────────────────────

describe('POST /api/upload — postId JSON path', () => {
  it('transitions the post to captioning and stamps hostedImageUrl on success', async () => {
    await seedPost('image_ready');
    fetchMock.mockResolvedValueOnce(fakeUguuSuccess('https://uguu.se/files/xyz.jpg'));

    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64');
    const req = new Request('http://x/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ postId: TEST_POST_ID, imageBytes }),
    });

    const res = await uploadPost(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { post: PostRecord; url: string };
    expect(body.url).toBe('https://uguu.se/files/xyz.jpg');
    expect(body.post).toBeDefined();
    expect(body.post.id).toBe(TEST_POST_ID);
    expect(body.post.state).toBe('captioning');
    expect(body.post.hostedImageUrl).toBe('https://uguu.se/files/xyz.jpg');
    // The history should include the original image_ready → captioning
    // transition the route triggered.
    const lastEntry = body.post.history[body.post.history.length - 1];
    expect(lastEntry.to).toBe('captioning');
    expect(lastEntry.from).toBe('image_ready');

    // Persisted state matches the returned record.
    const persisted = await loadPostRecords();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].state).toBe('captioning');
    expect(persisted[0].hostedImageUrl).toBe('https://uguu.se/files/xyz.jpg');
  });

  it('transitions the post to failed with reason image_upload_failed when uguu rejects', async () => {
    await seedPost('image_ready');
    fetchMock.mockResolvedValueOnce(
      fakeUguuFailure(502, { success: false, description: 'bandwidth exceeded' }),
    );

    const imageBytes = Buffer.from([0xff, 0xd8]).toString('base64');
    const req = new Request('http://x/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ postId: TEST_POST_ID, imageBytes }),
    });

    const res = await uploadPost(req);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; post: PostRecord };
    expect(body.error).toMatch(/uguu/);
    expect(body.post).toBeDefined();
    expect(body.post.state).toBe('failed');
    expect(body.post.failureReason).toBe('image_upload_failed');
    expect(body.post.retryable).toBe(true);
    expect(body.post.retryCount).toBe(1);

    // Persisted.
    const persisted = await loadPostRecords();
    expect(persisted[0].state).toBe('failed');
    expect(persisted[0].failureReason).toBe('image_upload_failed');
  });

  it('returns 404 when the postId is not in the store', async () => {
    const imageBytes = Buffer.from([0xff, 0xd8]).toString('base64');
    const req = new Request('http://x/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ postId: TEST_POST_ID, imageBytes }),
    });
    const res = await uploadPost(req);
    expect(res.status).toBe(404);
  });

  it('returns 400 when postId is present but imageBytes is missing', async () => {
    await seedPost('image_ready');
    const req = new Request('http://x/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ postId: TEST_POST_ID }),
    });
    const res = await uploadPost(req);
    expect(res.status).toBe(400);
  });

  it('returns 409 when the post is not in a state that can reach captioning', async () => {
    // 'posted' is terminal — cannot transition to captioning.
    let post = createDraftPost({ id: TEST_POST_ID });
    post = transition(post, 'generating_image', { note: 'seed' });
    post = transition(post, 'image_ready', { note: 'seed' });
    post = transition(post, 'captioning', { note: 'seed' });
    post = transition(post, 'caption_ready', { note: 'seed' });
    post = transition(post, 'scheduled', { note: 'seed' });
    post = transition(post, 'posting', { note: 'seed' });
    post = transition(post, 'posted', { note: 'seed' });
    await store.set('mashup_post_records', { posts: [post] });

    const imageBytes = Buffer.from([0xff, 0xd8]).toString('base64');
    const req = new Request('http://x/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ postId: TEST_POST_ID, imageBytes }),
    });
    const res = await uploadPost(req);
    expect(res.status).toBe(409);
    // State unchanged on disk.
    const persisted = await loadPostRecords();
    expect(persisted[0].state).toBe('posted');
  });
});

describe('POST /api/upload — postId multipart path', () => {
  it('accepts postId alongside a file in multipart form-data', async () => {
    await seedPost('image_ready');
    fetchMock.mockResolvedValueOnce(fakeUguuSuccess('https://uguu.se/files/mp.jpg'));

    const form = new FormData();
    form.append('postId', TEST_POST_ID);
    form.append('file', new Blob([new Uint8Array([9, 8, 7])], { type: 'image/jpeg' }), 'pic.jpg');

    const req = new Request('http://x/api/upload', { method: 'POST', body: form });
    const res = await uploadPost(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { post: PostRecord; url: string };
    expect(body.post.state).toBe('captioning');
    expect(body.post.hostedImageUrl).toBe('https://uguu.se/files/mp.jpg');
  });
});
