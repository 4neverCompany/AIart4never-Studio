// V080-DEV-002: Gallery visibility for rejected pipeline images.
//
// Maurice's call: rejected pipeline assets must NOT appear in Gallery.
// This *narrows* the BUG-DEV-003 surface — that fix released
// pipelinePending=false on reject so the image stopped being orphaned;
// this fix layers a Gallery-side filter on top so the released image
// is still visible to delete-paths / debug surfaces but hidden from the
// user-facing grid.
//
// An image is "rejected-only" iff it has at least one ScheduledPost AND
// every one of those posts is status='rejected'. A single still-active
// sibling (pending_approval / scheduled / posted / failed) keeps the
// image visible — partial rejections of carousel siblings or
// multi-platform schedules don't trigger the Gallery filter.
//
// Images with NO ScheduledPosts at all (manually-generated assets that
// were never scheduled) are unaffected — they remain visible.
//
// Pure function: takes the canonical posts array, returns the imageId
// Set the Gallery filter should hide. Cheap O(N) over scheduledPosts.

import type { ScheduledPost } from '@/types/mashup';

export function getAllRejectedImageIds(
  scheduledPosts: ReadonlyArray<ScheduledPost>,
): Set<string> {
  const postsByImage = new Map<string, ScheduledPost[]>();
  for (const p of scheduledPosts) {
    const arr = postsByImage.get(p.imageId);
    if (arr) arr.push(p);
    else postsByImage.set(p.imageId, [p]);
  }
  const rejected = new Set<string>();
  for (const [imageId, posts] of postsByImage) {
    if (posts.length > 0 && posts.every((p) => p.status === 'rejected')) {
      rejected.add(imageId);
    }
  }
  return rejected;
}
