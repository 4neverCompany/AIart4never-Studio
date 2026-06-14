// V050-005: pure transformation behind inline caption editing.
// Given the current scheduledPosts + carouselGroups, the ids being
// edited, and the new caption, returns the next snapshots.
//
// Group rule: a CarouselGroup's caption is rewritten only when every
// post belonging to that group is in the edited set. Editing a partial
// subset of a carousel rewrites only the targeted posts and leaves the
// group caption alone — partial edits shouldn't surprise the user by
// stomping the shared field.

import type { CarouselGroup, ScheduledPost } from '@/types/mashup';

export interface CaptionEditResult {
  scheduledPosts: ScheduledPost[];
  carouselGroups: CarouselGroup[];
}

export function applyCaptionEdit(
  posts: ScheduledPost[],
  groups: CarouselGroup[],
  postIds: string[],
  caption: string,
): CaptionEditResult {
  if (postIds.length === 0) {
    return { scheduledPosts: posts, carouselGroups: groups };
  }
  const idSet = new Set(postIds);
  const nextPosts = posts.map((p) =>
    idSet.has(p.id) ? { ...p, caption } : p,
  );

  const targetPosts = posts.filter((p) => idSet.has(p.id));
  const touchedGroupIds = new Set(
    targetPosts.map((p) => p.carouselGroupId).filter((g): g is string => !!g),
  );

  const nextGroups = groups.map((g) => {
    if (!touchedGroupIds.has(g.id)) return g;
    const groupPostIds = posts
      .filter((p) => p.carouselGroupId === g.id)
      .map((p) => p.id);
    if (groupPostIds.length === 0) return g;
    const allEdited = groupPostIds.every((id) => idSet.has(id));
    return allEdited ? { ...g, caption } : g;
  });

  return { scheduledPosts: nextPosts, carouselGroups: nextGroups };
}
