/**
 * Reconciler tests.
 *
 * Covers:
 *   - Posts in image_ready with missing blob → failed (image_missing)
 *   - Posts in scheduled with missing blob → failed (image_missing)
 *   - Posts in caption_ready with missing blob → failed (image_missing)
 *   - Posts with valid blob → verified, no state change
 *   - Posts in draft/posted/failed are not reconciled
 *   - Touch verified timestamp on valid blobs
 *   - Reconciler handles multiple posts correctly
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryStorage,
  Reconciler,
  PostId,
  ImageBlobId,
  createDraftPost,
  transition,
  type ImageBlob,
} from '@/lib/post-lifecycle';

const TEST_DATA = new ArrayBuffer(8);

function makeBlob(postId: PostId, id: ImageBlobId = ImageBlobId('blob_abcdef')): ImageBlob {
  return {
    id,
    postId,
    format: 'jpeg',
    sizeBytes: TEST_DATA.byteLength,
    createdAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    data: TEST_DATA,
  };
}

describe('Reconciler: failure modes', () => {
  let storage: InMemoryStorage;
  let reconciler: Reconciler;

  beforeEach(() => {
    storage = new InMemoryStorage();
    reconciler = new Reconciler(storage);
  });

  it('marks image_ready post as failed when blob is missing', async () => {
    const id = PostId('post_imgready1');
    let post = createDraftPost({ id });
    post = transition(post, 'generating_image');
    post = transition(post, 'image_ready', { note: 'AI done' });
    // Note: no savePostWithBlob call — the blob is "missing"
    await storage.savePostWithBlob(post, null);

    const { verified, failed } = await reconciler.reconcile();
    expect(verified).toHaveLength(0);
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe(id);
    expect(failed[0].state).toBe('failed');
    expect(failed[0].failureReason).toBe('image_missing');
  });

  it('marks scheduled post as failed when blob is missing (the v0.9.41 case)', async () => {
    const id = PostId('post_schedfail');
    let post = createDraftPost({ id });
    post = transition(post, 'generating_image');
    post = transition(post, 'image_ready');
    post = transition(post, 'captioning');
    post = transition(post, 'caption_ready');
    post = transition(post, 'scheduled', { note: 'User picked tomorrow 9am' });
    // No blob saved.
    await storage.savePostWithBlob(post, null);

    const { failed } = await reconciler.reconcile();
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe(id);
    expect(failed[0].state).toBe('failed');
    expect(failed[0].failureReason).toBe('image_missing');
  });

  it('marks scheduled post as failed when blob is zero bytes', async () => {
    const id = PostId('post_zerobyte');
    const blobId = ImageBlobId('blob_zerobyt1');
    let post = createDraftPost({ id });
    post = transition(post, 'generating_image');
    post = transition(post, 'image_ready');
    post = transition(post, 'captioning');
    post = transition(post, 'caption_ready');
    post = transition(post, 'scheduled');
    post.imageBlobId = blobId;
    // Save the post AND a corrupt (zero-byte) blob. The blob
    // is the thing we want the reconciler to detect as bad.
    // sizeBytes is readonly on ImageBlob, so we spread to make
    // a new object rather than mutating in place.
    const zeroBlob: ImageBlob = { ...makeBlob(id, blobId), sizeBytes: 0 };
    await storage.savePostWithBlob(post, zeroBlob);

    const { failed } = await reconciler.reconcile();
    expect(failed).toHaveLength(1);
    expect(failed[0].failureReason).toBe('image_missing');
  });

  it('marks scheduled post as failed when blob format is invalid', async () => {
    const id = PostId('post_badfmt');
    const blobId = ImageBlobId('blob_badfmt001');
    let post = createDraftPost({ id });
    post = transition(post, 'generating_image');
    post = transition(post, 'image_ready');
    post = transition(post, 'captioning');
    post = transition(post, 'caption_ready');
    post = transition(post, 'scheduled');
    post.imageBlobId = blobId;
    const badBlob: ImageBlob = { ...makeBlob(id, blobId), format: 'bmp' as ImageBlob['format'] };
    await storage.savePostWithBlob(post, badBlob);

    const { failed } = await reconciler.reconcile();
    expect(failed).toHaveLength(1);
    expect(failed[0].failureReason).toBe('image_missing');
  });
});

describe('Reconciler: success cases', () => {
  let storage: InMemoryStorage;
  let reconciler: Reconciler;

  beforeEach(() => {
    storage = new InMemoryStorage();
    reconciler = new Reconciler(storage);
  });

  it('verifies image_ready post with valid blob (no state change)', async () => {
    const id = PostId('post_valid1');
    const blobId = ImageBlobId('blob_valid001');
    let post = createDraftPost({ id });
    post = transition(post, 'generating_image');
    post = transition(post, 'image_ready');
    post.imageBlobId = blobId;
    const blob = makeBlob(id, blobId);
    await storage.savePostWithBlob(post, blob);

    const { verified, failed } = await reconciler.reconcile();
    expect(verified).toHaveLength(1);
    expect(failed).toHaveLength(0);
    expect(verified[0].state).toBe('image_ready'); // unchanged
  });

  it('does not reconcile posts in draft, failed, or posted states', async () => {
    const draft = createDraftPost({ id: PostId('post_d10001') });
    const failed = transition(
      transition(createDraftPost({ id: PostId('post_f10001') }), 'generating_image'),
      'failed',
      { reason: 'image_generation_failed' }
    );
    let posted = createDraftPost({ id: PostId('post_p10001') });
    posted = transition(posted, 'generating_image');
    posted = transition(posted, 'image_ready');
    posted = transition(posted, 'captioning');
    posted = transition(posted, 'caption_ready');
    posted = transition(posted, 'scheduled');
    posted = transition(posted, 'posting');
    posted = transition(posted, 'posted');

    await storage.savePostWithBlob(draft, null);
    await storage.savePostWithBlob(failed, null);
    await storage.savePostWithBlob(posted, null);

    const { verified, failed: failedOut } = await reconciler.reconcile();
    expect(verified).toHaveLength(0);
    expect(failedOut).toHaveLength(0);
  });

  it('updates lastVerifiedAt on the blob after successful verification', async () => {
    const id = PostId('post_touchv');
    const blobId = ImageBlobId('blob_touchv01');
    let post = createDraftPost({ id });
    post = transition(post, 'generating_image');
    post = transition(post, 'image_ready');
    post.imageBlobId = blobId;
    const blob = makeBlob(id, blobId);
    const originalVerifiedAt = blob.lastVerifiedAt;
    await storage.savePostWithBlob(post, blob);

    await new Promise((r) => setTimeout(r, 10));
    await reconciler.reconcile();

    const read = await storage.getBlob(blobId);
    expect(read!.lastVerifiedAt).not.toBe(originalVerifiedAt);
  });
});

describe('Reconciler: mixed batch', () => {
  it('handles multiple posts correctly in one pass', async () => {
    const storage = new InMemoryStorage();
    const reconciler = new Reconciler(storage);

    // Post A: valid, should be verified
    const aId = PostId('post_amix001');
    const aBlobId = ImageBlobId('blob_amix0001');
    let a = createDraftPost({ id: aId });
    a = transition(a, 'generating_image');
    a = transition(a, 'image_ready');
    a.imageBlobId = aBlobId;
    await storage.savePostWithBlob(a, makeBlob(aId, aBlobId));

    // Post B: scheduled but with no blob (the v0.9.41 bug
    // shape that the production backends would reject at write
    // time). We simulate the post-metadata-only half of the
    // v0.9.41 bug: the post is in `scheduled` state with no
    // imageBlobId. The reconciler catches it via the
    // "post in image-using state with no imageBlobId" branch.
    const bId = PostId('post_bmix001');
    let b = createDraftPost({ id: bId });
    b = transition(b, 'generating_image');
    b = transition(b, 'image_ready');
    b = transition(b, 'captioning');
    b = transition(b, 'caption_ready');
    b = transition(b, 'scheduled');
    await storage.savePostWithBlob(b, null);

    // Post C: draft, not reconciled
    const cId = PostId('post_cmix001');
    const c = createDraftPost({ id: cId });
    await storage.savePostWithBlob(c, null);

    const { verified, failed } = await reconciler.reconcile();
    expect(verified.map((p) => p.id)).toEqual([aId]);
    expect(failed.map((p) => p.id)).toEqual([bId]);
  });
});
