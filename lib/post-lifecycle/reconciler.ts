/**
 * The reconciler.
 *
 * Runs on app startup (and optionally on a periodic timer for
 * long-running sessions). Walks through every post in `image_ready`
 * or `scheduled` state and verifies the referenced image blob is
 * present. If not, transitions the post to `failed` with
 * `image_missing` reason.
 *
 * This is the component that prevents the v0.9.41 bug from recurring.
 * The scheduler is GUARANTEED to only ever see posts in `scheduled`
 * state whose image blob has been verified.
 *
 * If you change the reconciler logic, update the contract tests in
 * tests/post-lifecycle/reconciler.test.ts and the v0.9.41 regression
 * test in tests/post-lifecycle/failure-modes.test.ts.
 */

import { transition } from './state-machine';
import type {
  PostRecord,
  PostState,
  PostId,
} from './types';
import type { PostLifecycleStorage } from './persistence';

const RECONCILE_STATES: ReadonlySet<PostState> = new Set([
  'image_ready',
  'captioning',
  'caption_ready',
  'scheduled',
]);

export interface ReconcileResult {
  /** Posts that passed reconciliation and remain in their current state. */
  readonly verified: readonly PostRecord[];
  /** Posts that were transitioned to `failed` with `image_missing` reason. */
  readonly failed: readonly PostRecord[];
  /** Posts that need re-promotion (e.g. user re-uploaded an image). */
  readonly recovered: readonly PostRecord[];
}

export class Reconciler {
  constructor(private readonly storage: PostLifecycleStorage) {}

  /**
   * Run a single reconciliation pass.
   *
   * For every post in a state that requires a verified image:
   *   1. If imageBlobId is null → mark failed (image_missing)
   *   2. If the blob lookup returns null → mark failed (image_missing)
   *   3. If the blob's size is 0 or its format is invalid → mark failed
   *   4. Otherwise → touch lastVerifiedAt and leave the post alone
   */
  async reconcile(): Promise<ReconcileResult> {
    const allPosts = await this.storage.listPosts();
    const toReconcile = allPosts.filter((p) => RECONCILE_STATES.has(p.state));

    const verified: PostRecord[] = [];
    const failed: PostRecord[] = [];
    const recovered: PostRecord[] = [];

    for (const post of toReconcile) {
      const outcome = await this.checkOne(post);
      switch (outcome.kind) {
        case 'verified':
          verified.push(outcome.post);
          break;
        case 'failed':
          failed.push(outcome.post);
          break;
        case 'recovered':
          recovered.push(outcome.post);
          break;
      }
    }

    return { verified, failed, recovered };
  }

  /**
   * Check a single post. Used by the reconciler and by callers who
   * need to verify a post's image before doing something with it
   * (e.g. the scheduler).
   */
  async checkOne(
    post: PostRecord
  ): Promise<
    | { kind: 'verified'; post: PostRecord }
    | { kind: 'failed'; post: PostRecord }
    | { kind: 'recovered'; post: PostRecord }
  > {
    // Drafts, failed, and posted posts don't need verification.
    if (!RECONCILE_STATES.has(post.state)) {
      return { kind: 'verified', post };
    }

    if (!post.imageBlobId) {
      const failed = transition(post, 'failed', {
        reason: 'image_missing',
        note: `Post in ${post.state} had no imageBlobId at reconciliation time`,
        reconciler: true,
      });
      // Clear the dangling reference: the post had no imageBlobId
      // to begin with, so there is nothing to keep pointing at.
      failed.imageBlobId = null;
      await this.storage.savePostWithBlob(failed, null);
      return { kind: 'failed', post: failed };
    }

    const blob = await this.storage.getBlob(post.imageBlobId);
    if (!blob) {
      const failed = transition(post, 'failed', {
        reason: 'image_missing',
        note: `Image blob ${post.imageBlobId} not found at reconciliation time`,
        reconciler: true,
      });
      // Clear the dangling reference: the blob the post was
      // pointing at is gone.
      failed.imageBlobId = null;
      await this.storage.savePostWithBlob(failed, null);
      return { kind: 'failed', post: failed };
    }

    if (blob.sizeBytes === 0) {
      const failed = transition(post, 'failed', {
        reason: 'image_missing',
        note: `Image blob ${post.imageBlobId} has zero bytes`,
        reconciler: true,
      });
      // Clear the dangling reference: the blob is corrupt, so
      // the post should not continue to point at it.
      failed.imageBlobId = null;
      await this.storage.savePostWithBlob(failed, null);
      return { kind: 'failed', post: failed };
    }

    if (!['jpeg', 'png', 'webp'].includes(blob.format)) {
      const failed = transition(post, 'failed', {
        reason: 'image_missing',
        note: `Image blob ${post.imageBlobId} has invalid format: ${blob.format}`,
        reconciler: true,
      });
      // Clear the dangling reference: the blob is the wrong
      // format, so the post should not continue to point at it.
      failed.imageBlobId = null;
      await this.storage.savePostWithBlob(failed, null);
      return { kind: 'failed', post: failed };
    }

    // Verified. Touch the blob's lastVerifiedAt.
    await this.storage.touchBlobVerifiedAt(blob.id);
    return { kind: 'verified', post };
  }
}
