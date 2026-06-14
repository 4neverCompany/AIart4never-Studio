/**
 * V082-POST-READY-SORT — Post Ready grid ordering.
 *
 * The grid used to render in whatever order `computeCarouselView`
 * emitted (max savedAt across siblings, newest first). Users asked for
 * a sort toggle with three options:
 *   savedAt   — when the item landed in Post Ready (default, newest first)
 *   scheduled — soonest scheduled post first; unscheduled sink to the end
 *   created   — when the image was generated, parsed from `img-<ts>-…`
 *
 * Sorting happens AFTER `computeCarouselView` so its internal grouping
 * logic (explicit carousel groups, 5-minute auto-window) stays intact.
 */

import type { ScheduledPost } from '@/types/mashup';
import type { PostItem } from './carouselView';

export type PostReadySortKey = 'savedAt' | 'scheduled' | 'created';

function imagesOf(item: PostItem) {
  return item.kind === 'carousel' ? item.images : [item.img];
}

export function getPostItemSortKey(
  item: PostItem,
  sort: PostReadySortKey,
  scheduledPosts: readonly ScheduledPost[],
): number {
  const imgs = imagesOf(item);
  if (sort === 'savedAt') {
    return Math.max(0, ...imgs.map((i) => i.savedAt ?? 0));
  }
  if (sort === 'created') {
    let latest = 0;
    for (const img of imgs) {
      const m = img.id.match(/^img-(\d+)/);
      if (!m) continue;
      const ts = Number(m[1]);
      if (Number.isFinite(ts) && ts > latest) latest = ts;
    }
    return latest;
  }
  // scheduled — soonest first; unscheduled items return Infinity so they
  // sink to the bottom under ascending sort.
  let soonest = Number.POSITIVE_INFINITY;
  for (const img of imgs) {
    const post = scheduledPosts.find(
      (p) =>
        p.imageId === img.id &&
        p.status !== 'posted' &&
        p.status !== 'rejected' &&
        p.status !== 'failed',
    );
    if (!post) continue;
    const ts = new Date(`${post.date}T${post.time}`).getTime();
    if (Number.isFinite(ts) && ts < soonest) soonest = ts;
  }
  return soonest;
}

export function sortPostItems(
  items: readonly PostItem[],
  sort: PostReadySortKey,
  scheduledPosts: readonly ScheduledPost[],
): PostItem[] {
  const next = [...items];
  if (sort === 'scheduled') {
    next.sort(
      (a, b) =>
        getPostItemSortKey(a, sort, scheduledPosts) -
        getPostItemSortKey(b, sort, scheduledPosts),
    );
  } else {
    next.sort(
      (a, b) =>
        getPostItemSortKey(b, sort, scheduledPosts) -
        getPostItemSortKey(a, sort, scheduledPosts),
    );
  }
  return next;
}
