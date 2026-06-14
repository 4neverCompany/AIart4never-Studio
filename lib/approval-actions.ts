import type { ScheduledPost } from '@/types/mashup';

/**
 * BUG-CRIT-012: pure helpers for the approve / reject scheduled-post
 * actions. Splitting the "what should change" computation out of the
 * React wiring fixes a critical timing bug.
 *
 * Old shape (in MashupContext.approveScheduledPost):
 *
 *   let approvedPost;
 *   updateSettings((prev) => {
 *     approvedPost = prev.scheduledPosts.find(...);   // captured INSIDE updater
 *     return { scheduledPosts: prev.scheduledPosts.map(...) };
 *   });
 *   if (approvedPost) finalizePipelineImagesForPosts([approvedPost]);
 *
 * That worked for a single click because React's "eager state update"
 * optimization invokes the functional updater synchronously WHEN THE
 * UPDATE QUEUE IS EMPTY. As soon as a second update is queued back-to-
 * back (e.g. CarouselApprovalCard fans out 3 approveScheduledPost calls
 * for a 3-image carousel), the queue is no longer empty for calls 2/3,
 * so React defers their updaters to the render phase. By then the
 * synchronous `if (approvedPost)` line has already run with
 * `approvedPost === undefined`, and finalize is silently skipped —
 * meaning images 2 and 3 stay `pipelinePending: true` (hidden from
 * Gallery, no watermark) even though their ScheduledPost.status
 * correctly flips to 'scheduled'.
 *
 * New shape: read the target post from the closure-captured `settings`
 * snapshot BEFORE `updateSettings`, and pass `toFinalize` into the
 * caller. The pure functions below are the unit-testable core.
 */

export interface ApprovalActionResult {
  /**
   * Posts to feed into finalizePipelineImagesForPosts. Empty when the
   * target post is missing or already past pending_approval (idempotent
   * double-clicks become no-ops).
   */
  toFinalize: ScheduledPost[];
  /**
   * The functional updater that produces the next scheduledPosts array.
   * Built as a function so the caller can pass it to React's setState
   * with the same `prev.status === 'pending_approval'` guard the read
   * side used — protects against late-binding races where a parallel
   * action already moved the post out of pending_approval.
   */
  nextPosts: (current: ScheduledPost[]) => ScheduledPost[];
}

function flipPostStatus(
  posts: ScheduledPost[],
  postId: string,
  to: 'scheduled' | 'rejected',
): ScheduledPost[] {
  return posts.map((p) =>
    p.id === postId && p.status === 'pending_approval'
      ? { ...p, status: to }
      : p,
  );
}

export function planApproveScheduledPost(
  posts: ReadonlyArray<ScheduledPost>,
  postId: string,
): ApprovalActionResult {
  const target = posts.find(
    (p) => p.id === postId && p.status === 'pending_approval',
  );
  return {
    toFinalize: target ? [target] : [],
    nextPosts: (current) => flipPostStatus(current, postId, 'scheduled'),
  };
}

export function planRejectScheduledPost(
  posts: ReadonlyArray<ScheduledPost>,
  postId: string,
): ApprovalActionResult {
  const target = posts.find(
    (p) => p.id === postId && p.status === 'pending_approval',
  );
  return {
    toFinalize: target ? [target] : [],
    nextPosts: (current) => flipPostStatus(current, postId, 'rejected'),
  };
}
