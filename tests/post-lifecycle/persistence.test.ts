/**
 * Persistence layer tests.
 *
 * Covers:
 *   - InMemoryStorage.savePostWithBlob is atomic
 *   - Round-trip: write, then read
 *   - listPostsByState filters correctly
 *   - deletePost removes both post and its blob
 *   - touchBlobVerifiedAt updates only the timestamp
 *
 * The InMemoryStorage is used as a reference implementation. The
 * production backends (IndexedDB and Tauri SQLite) are tested
 * separately in their own files.
 */

import { describe, it, expect } from 'vitest';
import {
  InMemoryStorage,
  PostId,
  ImageBlobId,
  createDraftPost,
  transition,
  AtomicityViolationError,
  type ImageBlob,
} from '@/lib/post-lifecycle';

const TEST_BLOB_DATA = new ArrayBuffer(8);

function makeBlob(postId: PostId, id: ImageBlobId = ImageBlobId('blob_abcdef')): ImageBlob {
  return {
    id,
    postId,
    format: 'jpeg',
    sizeBytes: TEST_BLOB_DATA.byteLength,
    createdAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    data: TEST_BLOB_DATA,
  };
}

describe('InMemoryStorage: savePostWithBlob atomicity', () => {
  it('rejects a post with imageBlobId but no blob', async () => {
    const storage = new InMemoryStorage();
    const post = createDraftPost({ id: PostId('post_abcdef') });
    post.imageBlobId = ImageBlobId('blob_xyz123');
    // Force state for test — see comment above.
    post.state = 'image_ready';

    await expect(
      storage.savePostWithBlob(post, null)
    ).rejects.toThrow(AtomicityViolationError);
  });

  it('rejects a blob whose postId does not match the post', async () => {
    const storage = new InMemoryStorage();
    const post = createDraftPost({ id: PostId('post_abcdef') });
    const blob = makeBlob(PostId('post_other1'), ImageBlobId('blob_xyz123'));

    await expect(
      storage.savePostWithBlob(post, blob)
    ).rejects.toThrow(AtomicityViolationError);
  });

  it('writes both post and blob atomically', async () => {
    const storage = new InMemoryStorage();
    const id = PostId('post_abcdef');
    const blobId = ImageBlobId('blob_xyz123');
    const post = createDraftPost({ id });
    post.imageBlobId = blobId;
    post.state = 'image_ready';
    const blob = makeBlob(id, blobId);

    await storage.savePostWithBlob(post, blob);

    const readPost = await storage.getPost(id);
    const readBlob = await storage.getBlob(blobId);
    expect(readPost).not.toBeNull();
    expect(readBlob).not.toBeNull();
    expect(readPost!.imageBlobId).toBe(blobId);
  });
});

describe('InMemoryStorage: round-trip', () => {
  it('preserves all PostRecord fields through write + read', async () => {
    const storage = new InMemoryStorage();
    const id = PostId('post_roundtrip');
    let post = createDraftPost({ id, ideaId: 'idea_42' });
    post = transition(post, 'generating_image');
    post = transition(post, 'image_ready', { note: 'AI done' });
    post.caption = 'Test caption';
    post.hashtags = ['#mashup', '#ai'];

    await storage.savePostWithBlob(post, null);

    const read = await storage.getPost(id);
    expect(read).toEqual(post);
  });
});

describe('InMemoryStorage: listPostsByState', () => {
  it('returns only posts in the requested state', async () => {
    const storage = new InMemoryStorage();
    const p1 = createDraftPost({ id: PostId('post_draft01') });
    const p2 = createDraftPost({ id: PostId('post_draft02') });
    const p3 = transition(createDraftPost({ id: PostId('post_imgrd001') }), 'generating_image');

    await storage.savePostWithBlob(p1, null);
    await storage.savePostWithBlob(p2, null);
    await storage.savePostWithBlob(p3, null);

    const drafts = await storage.listPostsByState('draft');
    expect(drafts.map((p) => p.id).sort()).toEqual([
      PostId('post_draft01'),
      PostId('post_draft02'),
    ]);

    const generating = await storage.listPostsByState('generating_image');
    expect(generating.map((p) => p.id)).toEqual([PostId('post_imgrd001')]);
  });
});

describe('InMemoryStorage: deletePost', () => {
  it('removes both the post and its image blob', async () => {
    const storage = new InMemoryStorage();
    const id = PostId('post_delete01');
    const blobId = ImageBlobId('blob_delete01');
    const post = createDraftPost({ id });
    post.imageBlobId = blobId;
    post.state = 'image_ready';
    const blob = makeBlob(id, blobId);

    await storage.savePostWithBlob(post, blob);
    await storage.deletePost(id);

    expect(await storage.getPost(id)).toBeNull();
    expect(await storage.getBlob(blobId)).toBeNull();
  });
});

describe('InMemoryStorage: touchBlobVerifiedAt', () => {
  it('updates only the lastVerifiedAt field', async () => {
    const storage = new InMemoryStorage();
    const id = PostId('post_touch001');
    const blobId = ImageBlobId('blob_touch001');
    const blob = makeBlob(id, blobId);
    const originalVerifiedAt = blob.lastVerifiedAt;
    const originalSize = blob.sizeBytes;

    await storage.savePostWithBlob(createDraftPost({ id }), blob);

    // Wait a moment so the timestamp is observably different
    await new Promise((r) => setTimeout(r, 10));
    await storage.touchBlobVerifiedAt(blobId);

    const read = await storage.getBlob(blobId);
    expect(read!.lastVerifiedAt).not.toBe(originalVerifiedAt);
    expect(read!.sizeBytes).toBe(originalSize);
  });
});
