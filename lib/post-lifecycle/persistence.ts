/**
 * Post-lifecycle persistence layer.
 *
 * Defines the storage interface and the atomicity contract.
 * Reference implementations live in ./storage/.
 *
 * The atomicity contract on `savePostWithBlob` is the single most
 * important guarantee in this whole module. It is what prevents the
 * v0.9.41 bug.
 */

import {
  type PostRecord,
  type PostState,
  type ImageBlob,
  type PostId,
  type ImageBlobId,
  AtomicityViolationError,
} from './types';

export interface PostLifecycleStorage {
  /**
   * Atomically save a post record and (optionally) an image blob.
   *
   * ATOMICITY CONTRACT:
   *   After this call returns, EITHER:
   *     (a) both `post` and `blob` (if non-null) are visible to
   *         subsequent `getPost` and `getBlob` calls, OR
   *     (b) NEITHER is visible — both writes are rolled back.
   *
   * It is NEVER the case that:
   *     (c) `post` is visible but `blob` is not (or vice versa).
   *
   * Storage backends MUST enforce this. IndexedDB transactions and
   * SQLite transactions give this for free. Key-value stores
   * (tauri-plugin-store, plain idb-keyval without transactions) do
   * NOT — they require the implementation to coordinate.
   *
   * @throws AtomicityViolationError if the implementation cannot
   *         guarantee the contract (e.g. partial write detected).
   */
  savePostWithBlob(post: PostRecord, blob: ImageBlob | null): Promise<void>;

  getPost(id: PostId): Promise<PostRecord | null>;
  getBlob(id: ImageBlobId): Promise<ImageBlob | null>;

  listPosts(): Promise<PostRecord[]>;
  listPostsByState(state: PostState): Promise<PostRecord[]>;

  /**
   * Delete a post and (if it has one) its image blob, atomically.
   * Used when the user discards a draft or permanently deletes a post.
   */
  deletePost(id: PostId): Promise<void>;

  /**
   * Touch only the image blob's lastVerifiedAt. Used by the reconciler
   * to mark a blob as confirmed-present without rewriting the post.
   * No atomicity needed — this is a single-field update on the blob.
   */
  touchBlobVerifiedAt(id: ImageBlobId): Promise<void>;
}

/**
 * Reference: in-memory storage for tests. NOT for production.
 * Atomicity is trivially guaranteed because everything is in the same
 * process and JS execution is single-threaded per microtask.
 */
export class InMemoryStorage implements PostLifecycleStorage {
  private posts = new Map<PostId, PostRecord>();
  private blobs = new Map<ImageBlobId, ImageBlob>();

  async savePostWithBlob(post: PostRecord, blob: ImageBlob | null): Promise<void> {
    // Simulate the case where the implementation could verify atomicity.
    // In a real backend (IndexedDB, SQLite) this is enforced by the
    // transaction itself. In-memory has no failure mode, but the
    // shape is right.
    if (post.imageBlobId && !blob) {
      throw new AtomicityViolationError(
        'post has imageBlobId but no blob was provided'
      );
    }
    if (blob && blob.postId !== post.id) {
      throw new AtomicityViolationError(
        `blob.postId (${blob.postId}) does not match post.id (${post.id})`
      );
    }
    this.posts.set(post.id, post);
    if (blob) this.blobs.set(blob.id, blob);
  }

  async getPost(id: PostId): Promise<PostRecord | null> {
    return this.posts.get(id) ?? null;
  }

  async getBlob(id: ImageBlobId): Promise<ImageBlob | null> {
    return this.blobs.get(id) ?? null;
  }

  async listPosts(): Promise<PostRecord[]> {
    return Array.from(this.posts.values());
  }

  async listPostsByState(state: PostState): Promise<PostRecord[]> {
    return Array.from(this.posts.values()).filter((p) => p.state === state);
  }

  async deletePost(id: PostId): Promise<void> {
    const post = this.posts.get(id);
    if (post?.imageBlobId) this.blobs.delete(post.imageBlobId);
    this.posts.delete(id);
  }

  async touchBlobVerifiedAt(id: ImageBlobId): Promise<void> {
    const blob = this.blobs.get(id);
    if (blob) {
      this.blobs.set(id, { ...blob, lastVerifiedAt: new Date().toISOString() });
    }
  }
}
