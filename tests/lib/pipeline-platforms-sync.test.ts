/**
 * V1.7.0-PRE-PROD-FIX: tests for the platform-toggle sync helpers.
 *
 * These helpers close the gap between `settings.pipelinePlatforms`
 * (the user-visible toggle) and the per-post `ScheduledPost.platforms`
 * snapshot that the auto-poster reads. See
 * `lib/pipeline-platforms-sync.ts` for the contract.
 */
import { describe, it, expect } from 'vitest';
import {
  countAffectedPosts,
  applyPlatformToggleToExistingPosts,
  filterPlatformsBySetting,
  type AffectedCounts,
} from '@/lib/pipeline-platforms-sync';
import type { ScheduledPost } from '@/types/mashup';

function post(
  id: string,
  platforms: ScheduledPost['platforms'],
  status: ScheduledPost['status'] = 'scheduled',
): ScheduledPost {
  return {
    id,
    imageId: `img-${id}`,
    date: '2026-06-15',
    time: '10:00',
    caption: 'test',
    platforms,
    status,
  };
}

describe('countAffectedPosts', () => {
  it('returns 0 counts when no posts have the platform', () => {
    const posts = [post('1', ['instagram']), post('2', ['twitter'])];
    const c = countAffectedPosts(posts, 'pinterest');
    expect(c).toEqual({
      scheduled: 0,
      pending_approval: 0,
      posted: 0,
      failed: 0,
      rejected: 0,
      total: 0,
    } as AffectedCounts);
  });

  it('buckets posts by status correctly', () => {
    const posts = [
      post('1', ['instagram', 'pinterest']),
      post('2', ['pinterest'], 'pending_approval'),
      post('3', ['pinterest'], 'posted'),
      post('4', ['pinterest'], 'failed'),
      post('5', ['pinterest'], 'rejected'),
      post('6', ['pinterest']), // default = scheduled
    ];
    const c = countAffectedPosts(posts, 'pinterest');
    expect(c.scheduled).toBe(2); // 1 + 6
    expect(c.pending_approval).toBe(1);
    expect(c.posted).toBe(1);
    expect(c.failed).toBe(1);
    expect(c.rejected).toBe(1);
    expect(c.total).toBe(6);
  });

  it('handles posts with no platforms array (defensive)', () => {
    const posts = [
      // Cast through unknown to simulate legacy data.
      { ...post('1', ['instagram']), platforms: undefined } as unknown as ScheduledPost,
    ];
    const c = countAffectedPosts(posts, 'pinterest');
    expect(c.total).toBe(0);
  });
});

describe('applyPlatformToggleToExistingPosts', () => {
  it('removes the platform from every post that has it', () => {
    const posts = [
      post('1', ['instagram', 'pinterest']),
      post('2', ['pinterest'], 'pending_approval'),
      post('3', ['instagram']),
    ];
    const next = applyPlatformToggleToExistingPosts(posts, 'pinterest');
    expect(next[0].platforms).toEqual(['instagram']);
    expect(next[1].platforms).toEqual([]);
    expect(next[2].platforms).toEqual(['instagram']);
  });

  it('does NOT mutate the input array', () => {
    const posts = [post('1', ['instagram', 'pinterest'])];
    const snapshot = JSON.parse(JSON.stringify(posts));
    applyPlatformToggleToExistingPosts(posts, 'pinterest');
    expect(posts).toEqual(snapshot);
  });

  it('is idempotent: removing a platform that is not there is a no-op', () => {
    const posts = [post('1', ['instagram'])];
    const next = applyPlatformToggleToExistingPosts(posts, 'pinterest');
    expect(next[0].platforms).toEqual(['instagram']);
    // The helper maps every post so callers always get a fresh
    // array; identity comparison should NOT be used to detect change.
    // Functional equality (deep equal) is the contract.
    expect(next[0].platforms).toEqual(posts[0].platforms);
  });

  it('returns a post with empty platforms array (does not drop the post)', () => {
    // The user explicitly scheduled this post with only Pinterest. We
    // don't want to silently lose the user's caption/hashtag work;
    // the auto-poster's findPostingBlock guard will refuse to post it.
    const posts = [post('1', ['pinterest'])];
    const next = applyPlatformToggleToExistingPosts(posts, 'pinterest');
    expect(next[0].platforms).toEqual([]);
    expect(next[0].caption).toBe('test');
  });
});

describe('filterPlatformsBySetting — defensive filter at the post site', () => {
  it('drops platforms that are no longer enabled in the setting', () => {
    const posts = [
      post('1', ['instagram', 'pinterest']),
      post('2', ['pinterest', 'twitter']),
    ];
    const next = filterPlatformsBySetting(posts, ['instagram', 'twitter']);
    expect(next[0].platforms).toEqual(['instagram']);
    expect(next[1].platforms).toEqual(['twitter']);
  });

  it('leaves a post unchanged when the intersection is non-empty', () => {
    // Both platforms are still enabled — the filter is a no-op.
    const posts = [post('1', ['instagram', 'pinterest'])];
    const next = filterPlatformsBySetting(posts, ['instagram', 'pinterest']);
    expect(next[0].platforms).toEqual(['instagram', 'pinterest']);
  });

  it('leaves a post unchanged when the intersection would be empty (does not strip to [])', () => {
    // If the only remaining platform is now disabled, we keep the
    // post's platforms array as-is. The auto-poster's
    // findPostingBlock guard in lib/post-approval-gate.ts will refuse
    // to post it; stripping to [] here would be a silent no-op that
    // confuses the user ("did I just delete my post?").
    const posts = [post('1', ['pinterest'])];
    const next = filterPlatformsBySetting(posts, ['instagram']);
    expect(next[0].platforms).toEqual(['pinterest']);
  });

  it('passes through posts that have all their platforms still enabled', () => {
    const posts = [post('1', ['instagram'])];
    const next = filterPlatformsBySetting(posts, ['instagram', 'pinterest']);
    expect(next[0].platforms).toEqual(['instagram']);
  });
});
