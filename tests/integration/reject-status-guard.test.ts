// V050-009 BUG-DEV-001: pin the status guard on rejectScheduledPost
// and bulkRejectScheduledPosts. Mirrors the inline logic at
// components/MashupContext.tsx:207-216 (singular) and :238-249 (bulk).
//
// Bug: pre-fix, both reject paths flipped any matched post id to
// 'rejected' regardless of current status — which means a stale UI
// reference (or a bulk action containing already-acted-upon ids) would
// silently turn a 'scheduled' / 'posted' / 'failed' post into
// 'rejected', pulling it out of the auto-poster's view forever with
// no recovery path. The mirror approve paths at lines 200-203 and
// 226-229 already had the guard.
//
// Fix: both reject paths now require `p.status === 'pending_approval'`
// before flipping to 'rejected'. Status-correct (pending) posts are
// rejected as before; everything else is left alone.

import { describe, it, expect } from 'vitest';
import type { ScheduledPost } from '@/types/mashup';

// Mirror of components/MashupContext.tsx:209-215 (singular reject).
function rejectScheduledPost(
  posts: ScheduledPost[],
  postId: string,
): ScheduledPost[] {
  return posts.map((p) =>
    p.id === postId && p.status === 'pending_approval'
      ? { ...p, status: 'rejected' as const }
      : p,
  );
}

// Mirror of components/MashupContext.tsx:240-247 (bulk reject).
function bulkRejectScheduledPosts(
  posts: ScheduledPost[],
  postIds: string[],
): ScheduledPost[] {
  if (postIds.length === 0) return posts;
  const idSet = new Set(postIds);
  return posts.map((p) =>
    idSet.has(p.id) && p.status === 'pending_approval'
      ? { ...p, status: 'rejected' as const }
      : p,
  );
}

const mkPost = (overrides: Partial<ScheduledPost> = {}): ScheduledPost => ({
  id: 'post-1',
  imageId: 'img-1',
  date: '2026-04-25',
  time: '18:00',
  platforms: ['instagram'],
  caption: 'cap',
  status: 'pending_approval',
  ...overrides,
});

describe('V050-009 BUG-DEV-001 — reject status guard', () => {
  describe('rejectScheduledPost (singular)', () => {
    it('rejects a pending_approval post', () => {
      const posts = [mkPost({ id: 'a', status: 'pending_approval' })];
      const next = rejectScheduledPost(posts, 'a');
      expect(next[0]!.status).toBe('rejected');
    });

    it('does NOT reject a scheduled post (auto-poster would lose track)', () => {
      const posts = [mkPost({ id: 'a', status: 'scheduled' })];
      const next = rejectScheduledPost(posts, 'a');
      expect(next[0]!.status).toBe('scheduled');
    });

    it('does NOT reject a posted post', () => {
      const posts = [mkPost({ id: 'a', status: 'posted' })];
      const next = rejectScheduledPost(posts, 'a');
      expect(next[0]!.status).toBe('posted');
    });

    it('does NOT reject a failed post (user might retry it)', () => {
      const posts = [mkPost({ id: 'a', status: 'failed' })];
      const next = rejectScheduledPost(posts, 'a');
      expect(next[0]!.status).toBe('failed');
    });

    it('does NOT touch a post whose id does not match', () => {
      const posts = [mkPost({ id: 'a', status: 'pending_approval' })];
      const next = rejectScheduledPost(posts, 'b');
      expect(next[0]!.status).toBe('pending_approval');
    });
  });

  describe('bulkRejectScheduledPosts', () => {
    it('rejects only the pending_approval posts in the id set', () => {
      const posts = [
        mkPost({ id: 'a', status: 'pending_approval' }),
        mkPost({ id: 'b', status: 'scheduled' }),
        mkPost({ id: 'c', status: 'pending_approval' }),
        mkPost({ id: 'd', status: 'posted' }),
      ];
      const next = bulkRejectScheduledPosts(posts, ['a', 'b', 'c', 'd']);
      const byId = Object.fromEntries(next.map((p) => [p.id, p.status]));
      expect(byId).toEqual({
        a: 'rejected',
        b: 'scheduled',
        c: 'rejected',
        d: 'posted',
      });
    });

    it('returns the same array when the id set is empty (no-op)', () => {
      const posts = [mkPost({ id: 'a', status: 'pending_approval' })];
      const next = bulkRejectScheduledPosts(posts, []);
      expect(next).toBe(posts);
    });

    it('leaves untargeted pending_approval posts alone', () => {
      const posts = [
        mkPost({ id: 'a', status: 'pending_approval' }),
        mkPost({ id: 'b', status: 'pending_approval' }),
      ];
      const next = bulkRejectScheduledPosts(posts, ['a']);
      expect(next.find((p) => p.id === 'a')!.status).toBe('rejected');
      expect(next.find((p) => p.id === 'b')!.status).toBe('pending_approval');
    });
  });
});
