// V080-DEV-002: pin the Gallery rejected-only filter contract.
//
// Maurice's call: an image whose ScheduledPosts are all 'rejected'
// must be hidden from Gallery. An image with any non-rejected post
// (pending_approval / scheduled / posted / failed) stays visible —
// partial rejections of carousel siblings or multi-platform schedules
// don't pull the asset out of view. Images with no scheduledPosts at
// all (manual generates) are unaffected.
//
// These cases pin every branch of getAllRejectedImageIds so a future
// regression to the BUG-DEV-003 surface (where we silently re-broke the
// orphan path) or to the partial-reject semantics fails loudly.

import { describe, it, expect } from 'vitest';
import { getAllRejectedImageIds } from '@/lib/gallery-visibility';
import type { ScheduledPost } from '@/types/mashup';

const mkPost = (overrides: Partial<ScheduledPost> = {}): ScheduledPost => ({
  id: 'post-1',
  imageId: 'img-1',
  date: '2026-04-23',
  time: '09:00',
  platforms: ['instagram'],
  caption: 'c',
  status: 'pending_approval',
  ...overrides,
});

describe('getAllRejectedImageIds (V080-DEV-002)', () => {
  it('returns an empty Set when there are no scheduledPosts', () => {
    expect(getAllRejectedImageIds([])).toEqual(new Set());
  });

  it('flags an image whose only ScheduledPost is rejected', () => {
    const posts = [mkPost({ id: 'p1', imageId: 'img-A', status: 'rejected' })];
    expect(getAllRejectedImageIds(posts)).toEqual(new Set(['img-A']));
  });

  it('flags an image whose every ScheduledPost is rejected (multi-platform / multi-day)', () => {
    const posts = [
      mkPost({ id: 'p1', imageId: 'img-A', status: 'rejected', platforms: ['instagram'] }),
      mkPost({ id: 'p2', imageId: 'img-A', status: 'rejected', platforms: ['twitter'] }),
      mkPost({ id: 'p3', imageId: 'img-A', status: 'rejected', date: '2026-04-24' }),
    ];
    expect(getAllRejectedImageIds(posts)).toEqual(new Set(['img-A']));
  });

  it('does NOT flag an image with a mix of rejected and pending_approval posts (carousel partial reject)', () => {
    const posts = [
      mkPost({ id: 'p1', imageId: 'img-A', status: 'rejected' }),
      mkPost({ id: 'p2', imageId: 'img-A', status: 'pending_approval' }),
    ];
    expect(getAllRejectedImageIds(posts)).toEqual(new Set());
  });

  it('does NOT flag an image with a mix of rejected and scheduled posts', () => {
    const posts = [
      mkPost({ id: 'p1', imageId: 'img-A', status: 'rejected' }),
      mkPost({ id: 'p2', imageId: 'img-A', status: 'scheduled' }),
    ];
    expect(getAllRejectedImageIds(posts)).toEqual(new Set());
  });

  it('does NOT flag an image with a mix of rejected and posted posts (already shared somewhere)', () => {
    const posts = [
      mkPost({ id: 'p1', imageId: 'img-A', status: 'rejected', platforms: ['instagram'] }),
      mkPost({ id: 'p2', imageId: 'img-A', status: 'posted', platforms: ['twitter'] }),
    ];
    expect(getAllRejectedImageIds(posts)).toEqual(new Set());
  });

  it('does NOT flag an image with a failed post (failed != rejected — the user did not opt out)', () => {
    const posts = [
      mkPost({ id: 'p1', imageId: 'img-A', status: 'rejected' }),
      mkPost({ id: 'p2', imageId: 'img-A', status: 'failed' }),
    ];
    expect(getAllRejectedImageIds(posts)).toEqual(new Set());
  });

  it('flags multiple distinct rejected-only images independently', () => {
    const posts = [
      mkPost({ id: 'p1', imageId: 'img-A', status: 'rejected' }),
      mkPost({ id: 'p2', imageId: 'img-B', status: 'rejected' }),
      mkPost({ id: 'p3', imageId: 'img-B', status: 'rejected', platforms: ['twitter'] }),
      mkPost({ id: 'p4', imageId: 'img-C', status: 'pending_approval' }),
    ];
    expect(getAllRejectedImageIds(posts)).toEqual(new Set(['img-A', 'img-B']));
  });

  it('does not include images that have ZERO posts (manual generates)', () => {
    // The Set is keyed by imageIds that appear in scheduledPosts. An
    // image with no posts is never inserted, so it implicitly stays
    // visible — verified here by the Set never containing 'img-Z'.
    const posts = [mkPost({ id: 'p1', imageId: 'img-A', status: 'pending_approval' })];
    const ids = getAllRejectedImageIds(posts);
    expect(ids.has('img-Z')).toBe(false);
    expect(ids.has('img-A')).toBe(false);
  });
});
