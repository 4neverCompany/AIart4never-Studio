/**
 * V1.7.0-PRE-PROD-FIX: helpers for keeping `settings.pipelinePlatforms`
 * (the user-visible toggle) and the per-post `ScheduledPost.platforms`
 * (a snapshot taken at scheduling time) in sync.
 *
 * Background: every scheduled post carries its own `platforms` array,
 * frozen at the moment the post was approved. The PipelineTab's
 * platform toggle (`pipelinePlatforms`) ONLY controls which platforms
 * NEW pipeline posts go to — toggling Pinterest off does NOT remove
 * Pinterest from posts that were already scheduled with Pinterest
 * enabled. As a result:
 *
 *   - The PostReadyCard's platform pill keeps showing "Pinterest" for
 *     old posts even after the user disabled Pinterest.
 *   - The auto-poster continues to send old posts to Pinterest
 *     because `post.platforms.includes('pinterest')` is still true.
 *   - The weekly scheduler (usePipelineDaemon) keeps using
 *     Pinterest-capable slots.
 *
 * Maurice's bug-report on 2026-06-11:
 *
 *   "Pinterest disable im Pipeline tab führt jetzt nicht mehr zur
 *    Deaktivieren und korrekten Ausblendung der Pill im PostReady
 *    tab. Scheduled Post versuchen jetzt weiterhin auf Instagram
 *    und Pinterest zu posten obwohl deaktiviert."
 *
 * The fix has two halves:
 *
 *   1. `applyPlatformToggleToExistingPosts` — the confirm-dialog path
 *      in PipelineTab. Counts affected posts, asks the user whether
 *      they want to also remove the platform from existing scheduled
 *      posts, and (on confirm) returns the new `scheduledPosts` array
 *      for the caller to commit.
 *
 *   2. `filterPlatformsBySetting` — a defensive filter applied at the
 *      actual post site (in components/MainContent.tsx's
 *      /api/social/post caller). Even if a post's `platforms` array
 *      somehow still contains a now-disabled platform, the auto-poster
 *      never sends to it. This is the "safety net" the user explicitly
 *      asked for ("ein erneutes Rescheduling mit deaktivierten
 *      Pinterest hat nicht geholfen").
 *
 * Both helpers are pure (no React, no Tauri) so they can be unit
 * tested.
 */
import type { ScheduledPost } from '@/types/mashup';

/**
 * Count how many scheduled posts would be affected by removing a
 * platform from their `platforms` array. Returns the count by
 * status so the UI can show "2 scheduled, 1 pending_approval, 0
 * posted" to the user in the confirm dialog.
 */
export interface AffectedCounts {
  scheduled: number;
  pending_approval: number;
  posted: number;
  failed: number;
  rejected: number;
  /** Total posts that currently include the platform. */
  total: number;
}

export function countAffectedPosts(
  posts: ReadonlyArray<ScheduledPost>,
  platform: string,
): AffectedCounts {
  const counts: AffectedCounts = {
    scheduled: 0,
    pending_approval: 0,
    posted: 0,
    failed: 0,
    rejected: 0,
    total: 0,
  };
  for (const p of posts) {
    if (!p.platforms || !p.platforms.includes(platform as ScheduledPost['platforms'][number])) continue;
    counts.total++;
    if (p.status === 'pending_approval') counts.pending_approval++;
    else if (p.status === 'posted') counts.posted++;
    else if (p.status === 'failed') counts.failed++;
    else if (p.status === 'rejected') counts.rejected++;
    else counts.scheduled++; // undefined / 'scheduled' / no-status
  }
  return counts;
}

/**
 * Return a new `scheduledPosts` array with `platform` removed from
 * every post that has it. The original array is NOT mutated.
 *
 * Idempotent: posts that don't have the platform are returned
 * unchanged. Posts that would be left with an empty `platforms`
 * array are NOT removed — the caller (the auto-poster) already
 * filters those out via the existing findPostingBlock guard, and
 * dropping them would lose the user's caption/hashtag work.
 */
export function applyPlatformToggleToExistingPosts(
  posts: ReadonlyArray<ScheduledPost>,
  platform: string,
): ScheduledPost[] {
  return posts.map((p) => {
    if (!p.platforms || !p.platforms.includes(platform as ScheduledPost['platforms'][number])) {
      return p;
    }
    const next = p.platforms.filter((x) => x !== platform);
    return { ...p, platforms: next };
  });
}

/**
 * Defensive filter for the auto-poster. Even if a post's `platforms`
 * array still references a now-disabled platform, the auto-poster
 * will only send to the intersection of (post.platforms) and
 * (settings.pipelinePlatforms). Returns the post unchanged if the
 * intersection is empty, or with a pruned `platforms` array.
 */
export function filterPlatformsBySetting(
  posts: ReadonlyArray<ScheduledPost>,
  enabledPlatforms: ReadonlyArray<string>,
): ScheduledPost[] {
  const enabled = new Set(enabledPlatforms);
  return posts.map((p) => {
    if (!p.platforms) return p;
    const next = p.platforms.filter((x) => enabled.has(x));
    // If the post is still alive (not terminal) and would be left with
    // zero platforms, leave platforms as-is. The findPostingBlock
    // guard in lib/post-approval-gate.ts will refuse to post it
    // anyway; the empty list here just makes that intent obvious.
    if (next.length === 0) return p;
    return { ...p, platforms: next };
  });
}
