// BUG-DEV-003: pin the finalize-on-reject contract for both reject
// paths in components/MashupContext.tsx (singular at lines 219-235,
// bulk at lines 250-271). Mirrors the logic that captures the actually-
// rejected posts inside the updateSettings callback and forwards them
// to finalizePipelineImagesForPosts.
//
// Bug (pre-fix): rejecting a pipeline-generated ScheduledPost flipped
// status to 'rejected' but never cleared the underlying GeneratedImage's
// `pipelinePending: true`. Gallery filters out pipelinePending images,
// so the asset became a permanent orphan — invisible in Gallery,
// invisible in any other UI surface, occupying IDB quota forever.
//
// Fix (Option B from the V050-009 design call): both reject paths now
// call finalizePipelineImagesForPosts on the rejected posts, mirroring
// the approve flow. The image lands in Gallery (watermarked); the
// ScheduledPost stays 'rejected' so the auto-poster ignores it. Reject
// means "don't post this", not "delete this asset".

import { describe, it, expect } from 'vitest';
import type { GeneratedImage, ScheduledPost } from '@/types/mashup';
import { collectFinalizeTargets } from '@/lib/pipeline-finalize';

// Mirror of components/MashupContext.tsx:219-235 (singular reject —
// returns next-state posts AND the post that should be finalized).
function rejectScheduledPost(
  posts: ScheduledPost[],
  postId: string,
): { nextPosts: ScheduledPost[]; toFinalize: ScheduledPost[] } {
  const rejectedPost = posts.find(
    (p) => p.id === postId && p.status === 'pending_approval',
  );
  const nextPosts = posts.map((p) =>
    p.id === postId && p.status === 'pending_approval'
      ? { ...p, status: 'rejected' as const }
      : p,
  );
  return { nextPosts, toFinalize: rejectedPost ? [rejectedPost] : [] };
}

// Mirror of components/MashupContext.tsx:250-271 (bulk reject).
function bulkRejectScheduledPosts(
  posts: ScheduledPost[],
  postIds: string[],
): { nextPosts: ScheduledPost[]; toFinalize: ScheduledPost[] } {
  if (postIds.length === 0) return { nextPosts: posts, toFinalize: [] };
  const idSet = new Set(postIds);
  const toFinalize = posts.filter(
    (p) => idSet.has(p.id) && p.status === 'pending_approval',
  );
  const nextPosts = posts.map((p) =>
    idSet.has(p.id) && p.status === 'pending_approval'
      ? { ...p, status: 'rejected' as const }
      : p,
  );
  return { nextPosts, toFinalize };
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

const mkImage = (overrides: Partial<GeneratedImage> = {}): GeneratedImage => ({
  id: 'img-1',
  prompt: 'p',
  url: 'https://example.test/x.png',
  pipelinePending: true,
  ...overrides,
});

describe('BUG-DEV-003 — finalize on reject', () => {
  describe('singular rejectScheduledPost', () => {
    it('forwards the rejected post to finalize', () => {
      const post = mkPost({ id: 'a', status: 'pending_approval' });
      const { nextPosts, toFinalize } = rejectScheduledPost([post], 'a');
      expect(nextPosts[0]!.status).toBe('rejected');
      expect(toFinalize).toHaveLength(1);
      expect(toFinalize[0]!.id).toBe('a');
    });

    it('does not finalize a non-pending post (status guard from BUG-DEV-001)', () => {
      const post = mkPost({ id: 'a', status: 'scheduled' });
      const { nextPosts, toFinalize } = rejectScheduledPost([post], 'a');
      expect(nextPosts[0]!.status).toBe('scheduled');
      expect(toFinalize).toEqual([]);
    });

    it('does not finalize when the id does not match', () => {
      const post = mkPost({ id: 'a', status: 'pending_approval' });
      const { toFinalize } = rejectScheduledPost([post], 'b');
      expect(toFinalize).toEqual([]);
    });

    it('finalizing the rejected post surfaces the underlying pipelinePending image', () => {
      const post = mkPost({ id: 'a', imageId: 'img-1', status: 'pending_approval' });
      const images = [mkImage({ id: 'img-1', pipelinePending: true })];
      const { toFinalize } = rejectScheduledPost([post], 'a');
      const targets = toFinalize.flatMap((p) => collectFinalizeTargets(p, images));
      expect(targets).toHaveLength(1);
      expect(targets[0]!.id).toBe('img-1');
      expect(targets[0]!.pipelinePending).toBe(true);
    });

    it('finalizing a carousel rejection surfaces all carousel siblings', () => {
      const post = mkPost({
        id: 'a',
        imageId: 'img-1',
        carouselGroupId: 'c1',
        status: 'pending_approval',
      });
      const images = [
        mkImage({ id: 'img-1', carouselGroupId: 'c1', pipelinePending: true }),
        mkImage({ id: 'img-2', carouselGroupId: 'c1', pipelinePending: true }),
        mkImage({ id: 'img-3', carouselGroupId: 'c1', pipelinePending: true }),
        mkImage({ id: 'img-99', pipelinePending: true }), // unrelated
      ];
      const { toFinalize } = rejectScheduledPost([post], 'a');
      const targets = toFinalize.flatMap((p) => collectFinalizeTargets(p, images));
      const ids = targets.map((t) => t.id).sort();
      expect(ids).toEqual(['img-1', 'img-2', 'img-3']);
    });
  });

  describe('bulk bulkRejectScheduledPosts', () => {
    it('forwards only the pending_approval posts to finalize', () => {
      const posts = [
        mkPost({ id: 'a', status: 'pending_approval' }),
        mkPost({ id: 'b', status: 'scheduled' }),
        mkPost({ id: 'c', status: 'pending_approval' }),
        mkPost({ id: 'd', status: 'posted' }),
      ];
      const { nextPosts, toFinalize } = bulkRejectScheduledPosts(posts, ['a', 'b', 'c', 'd']);
      const finalIds = toFinalize.map((p) => p.id).sort();
      expect(finalIds).toEqual(['a', 'c']);
      // Status updates: only a, c → rejected; b, d untouched.
      const byId = Object.fromEntries(nextPosts.map((p) => [p.id, p.status]));
      expect(byId).toEqual({ a: 'rejected', b: 'scheduled', c: 'rejected', d: 'posted' });
    });

    it('empty id set returns no-op (no posts to finalize)', () => {
      const posts = [mkPost({ id: 'a', status: 'pending_approval' })];
      const { nextPosts, toFinalize } = bulkRejectScheduledPosts(posts, []);
      expect(nextPosts).toBe(posts);
      expect(toFinalize).toEqual([]);
    });

    it('multiple carousel rejections collect all unique sibling images', () => {
      const posts = [
        mkPost({ id: 'pa', imageId: 'img-a1', carouselGroupId: 'cA', status: 'pending_approval' }),
        mkPost({ id: 'pb', imageId: 'img-b1', carouselGroupId: 'cB', status: 'pending_approval' }),
      ];
      const images = [
        mkImage({ id: 'img-a1', carouselGroupId: 'cA', pipelinePending: true }),
        mkImage({ id: 'img-a2', carouselGroupId: 'cA', pipelinePending: true }),
        mkImage({ id: 'img-b1', carouselGroupId: 'cB', pipelinePending: true }),
        mkImage({ id: 'img-b2', carouselGroupId: 'cB', pipelinePending: true }),
      ];
      const { toFinalize } = bulkRejectScheduledPosts(posts, ['pa', 'pb']);
      const targets = toFinalize.flatMap((p) => collectFinalizeTargets(p, images));
      const ids = targets.map((t) => t.id).sort();
      expect(ids).toEqual(['img-a1', 'img-a2', 'img-b1', 'img-b2']);
    });
  });

  describe('idempotence — re-rejecting an already-rejected post is a no-op', () => {
    it('singular: re-reject after first reject returns toFinalize=[]', () => {
      const post = mkPost({ id: 'a', status: 'pending_approval' });
      const first = rejectScheduledPost([post], 'a');
      expect(first.toFinalize).toHaveLength(1);
      // Second reject sees status='rejected', so the status guard skips it.
      const second = rejectScheduledPost(first.nextPosts, 'a');
      expect(second.toFinalize).toEqual([]);
    });

    it('bulk: re-reject after first bulk-reject returns toFinalize=[]', () => {
      const posts = [
        mkPost({ id: 'a', status: 'pending_approval' }),
        mkPost({ id: 'b', status: 'pending_approval' }),
      ];
      const first = bulkRejectScheduledPosts(posts, ['a', 'b']);
      expect(first.toFinalize).toHaveLength(2);
      const second = bulkRejectScheduledPosts(first.nextPosts, ['a', 'b']);
      expect(second.toFinalize).toEqual([]);
    });
  });
});
