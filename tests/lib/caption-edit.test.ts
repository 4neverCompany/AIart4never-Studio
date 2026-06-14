import { describe, expect, it } from 'vitest';
import { applyCaptionEdit } from '@/lib/caption-edit';
import type { CarouselGroup, ScheduledPost } from '@/types/mashup';

const post = (id: string, caption = 'old', carouselGroupId?: string): ScheduledPost => ({
  id,
  imageId: `img-${id}`,
  date: '2026-04-19',
  time: '09:00',
  platforms: ['instagram'],
  caption,
  status: 'pending_approval',
  ...(carouselGroupId ? { carouselGroupId } : {}),
});

const group = (id: string, imageIds: string[], caption = 'old-group'): CarouselGroup => ({
  id,
  imageIds,
  caption,
});

describe('applyCaptionEdit', () => {
  it('returns inputs unchanged when postIds is empty', () => {
    const posts = [post('p1')];
    const groups = [group('g1', ['img-p1'])];
    const result = applyCaptionEdit(posts, groups, [], 'new');
    expect(result.scheduledPosts).toBe(posts);
    expect(result.carouselGroups).toBe(groups);
  });

  it('rewrites the targeted single post and leaves siblings alone', () => {
    const posts = [post('p1', 'a'), post('p2', 'b'), post('p3', 'c')];
    const result = applyCaptionEdit(posts, [], ['p2'], 'NEW');
    expect(result.scheduledPosts.map((p) => p.caption)).toEqual(['a', 'NEW', 'c']);
  });

  it('rewrites multiple targeted posts in one pass', () => {
    const posts = [post('p1', 'a'), post('p2', 'b'), post('p3', 'c')];
    const result = applyCaptionEdit(posts, [], ['p1', 'p3'], 'NEW');
    expect(result.scheduledPosts.map((p) => p.caption)).toEqual(['NEW', 'b', 'NEW']);
  });

  it('rewrites a CarouselGroup caption when every sibling post is in the edit set', () => {
    const posts = [
      post('p1', 'a', 'g1'),
      post('p2', 'a', 'g1'),
      post('p3', 'a', 'g1'),
    ];
    const groups = [group('g1', ['img-p1', 'img-p2', 'img-p3'], 'old-group')];
    const result = applyCaptionEdit(posts, groups, ['p1', 'p2', 'p3'], 'NEW');
    expect(result.carouselGroups[0]!.caption).toBe('NEW');
    expect(result.scheduledPosts.every((p) => p.caption === 'NEW')).toBe(true);
  });

  it('leaves CarouselGroup caption alone when only a subset is edited', () => {
    const posts = [
      post('p1', 'a', 'g1'),
      post('p2', 'a', 'g1'),
      post('p3', 'a', 'g1'),
    ];
    const groups = [group('g1', ['img-p1', 'img-p2', 'img-p3'], 'KEEP')];
    const result = applyCaptionEdit(posts, groups, ['p1', 'p2'], 'NEW');
    expect(result.carouselGroups[0]!.caption).toBe('KEEP');
    expect(result.scheduledPosts.map((p) => p.caption)).toEqual(['NEW', 'NEW', 'a']);
  });

  it('leaves untouched groups untouched', () => {
    const posts = [
      post('p1', 'a', 'g1'),
      post('p2', 'b', 'g2'),
    ];
    const groups = [
      group('g1', ['img-p1'], 'KEEP-G1'),
      group('g2', ['img-p2'], 'OLD-G2'),
    ];
    const result = applyCaptionEdit(posts, groups, ['p2'], 'NEW');
    expect(result.carouselGroups[0]!.caption).toBe('KEEP-G1');
    expect(result.carouselGroups[1]!.caption).toBe('NEW');
  });

  it('handles a post with carouselGroupId pointing to a group that has no current posts', () => {
    // Edge case: an orphaned carouselGroupId reference. Should not blow up
    // and should not invent a group caption.
    const posts = [post('p1', 'a', 'ghost-group')];
    const groups = [group('g1', ['img-elsewhere'], 'KEEP')];
    const result = applyCaptionEdit(posts, groups, ['p1'], 'NEW');
    expect(result.scheduledPosts[0]!.caption).toBe('NEW');
    expect(result.carouselGroups[0]!.caption).toBe('KEEP');
  });

  it('writes the same string when called with an empty caption (clear case)', () => {
    const posts = [post('p1', 'old')];
    const result = applyCaptionEdit(posts, [], ['p1'], '');
    expect(result.scheduledPosts[0]!.caption).toBe('');
  });
});
