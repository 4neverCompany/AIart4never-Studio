// V040-DES-003: pure, read-only grouping for the approval queue. Splits
// pending_approval posts into single-card items and carousel groups by
// ScheduledPost.carouselGroupId. Singletons (group of 1) fall back to
// singles so the UI never renders a "carousel of one."
//
// No mutations, no context methods, no schema changes — this helper
// only reads an existing post array.

import type { ScheduledPost } from '@/types/mashup';

export type ApprovalFeedItem =
  | { kind: 'single'; post: ScheduledPost }
  | { kind: 'carousel'; groupId: string; posts: ScheduledPost[] };

export function groupApprovalPosts(posts: readonly ScheduledPost[]): ApprovalFeedItem[] {
  const byGroup = new Map<string, ScheduledPost[]>();
  const singles: ScheduledPost[] = [];

  for (const p of posts) {
    if (!p.carouselGroupId) {
      singles.push(p);
      continue;
    }
    const arr = byGroup.get(p.carouselGroupId);
    if (arr) arr.push(p);
    else byGroup.set(p.carouselGroupId, [p]);
  }

  const items: ApprovalFeedItem[] = [];
  for (const [groupId, groupPosts] of byGroup) {
    if (groupPosts.length <= 1) {
      for (const p of groupPosts) singles.push(p);
      continue;
    }
    items.push({ kind: 'carousel', groupId, posts: groupPosts });
  }
  for (const p of singles) items.push({ kind: 'single', post: p });
  return items;
}
