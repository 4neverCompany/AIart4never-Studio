import type { ScheduledPost } from '@/types/mashup';

/**
 * BUG-CRIT-011: single source of truth for "may this content be posted
 * right now?". The auto-poster's snapshot loop (MainContent.tsx) and
 * the manual Post Now buttons (postImageNow / postCarouselNow) both
 * funnel through this so a rejected pipeline post can never reach the
 * social API — neither via background scheduling nor via a user click.
 *
 * Block conditions: status === 'rejected' (user explicitly disapproved
 * in the approval queue) OR status === 'pending_approval' (pipeline
 * post still awaiting approval). Anything else — 'scheduled', 'posted',
 * 'failed', or no scheduled record at all — is allowed (Post Now is
 * the standard manual flow for un-scheduled images, and 'failed' is
 * the legitimate retry path).
 */
export interface PostingBlock {
  reason: 'rejected' | 'pending_approval';
  message: string;
  postId: string;
}

function classifyBlock(post: ScheduledPost): PostingBlock | null {
  if (post.status === 'rejected') {
    return {
      reason: 'rejected',
      message: 'Cannot post: this content was rejected in the approval queue.',
      postId: post.id,
    };
  }
  if (post.status === 'pending_approval') {
    return {
      reason: 'pending_approval',
      message: 'Cannot post: this content is awaiting approval.',
      postId: post.id,
    };
  }
  return null;
}

/**
 * Walks every ScheduledPost that references any of the given image
 * ids. Returns the first block found, or null if every match is
 * postable. Pass a single id for `postImageNow`; pass the carousel's
 * full image set for `postCarouselNow` — a single rejected sibling
 * blocks the whole carousel.
 */
export function findPostingBlock(
  imageIds: ReadonlyArray<string>,
  scheduledPosts: ReadonlyArray<ScheduledPost> | undefined,
): PostingBlock | null {
  if (!scheduledPosts || scheduledPosts.length === 0) return null;
  const imageIdSet = new Set(imageIds);
  for (const post of scheduledPosts) {
    if (!imageIdSet.has(post.imageId)) continue;
    const block = classifyBlock(post);
    if (block) return block;
  }
  return null;
}

/**
 * Live re-check used by the auto-poster between snapshot iteration and
 * the actual fetch. Closes the race where a user rejects a post in the
 * 60-second window between the worker reading its snapshot and looping
 * down to that post's index.
 */
export function isStillScheduled(
  postId: string,
  liveScheduledPosts: ReadonlyArray<ScheduledPost> | undefined,
): boolean {
  if (!liveScheduledPosts) return false;
  const live = liveScheduledPosts.find((p) => p.id === postId);
  return live?.status === 'scheduled';
}
