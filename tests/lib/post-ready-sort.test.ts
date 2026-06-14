// V082-POST-READY-SORT — pins the sort helper so the three options
// (savedAt / scheduled / created) each order items as documented and
// do not collide with the computeCarouselView grouping invariants.

import { describe, it, expect } from 'vitest';
import type { GeneratedImage, ScheduledPost } from '@/types/mashup';
import type { PostItem } from '@/lib/carouselView';
import { sortPostItems } from '@/lib/post-ready-sort';

const mkImg = (overrides: Partial<GeneratedImage>): GeneratedImage => ({
  id: 'img-1',
  prompt: 'p',
  ...overrides,
});

const single = (img: GeneratedImage): PostItem => ({ kind: 'single', img });
const carousel = (id: string, images: GeneratedImage[]): PostItem => ({
  kind: 'carousel',
  id,
  images,
});

describe('sortPostItems', () => {
  describe('savedAt (default — newest first)', () => {
    it('orders singles by savedAt descending', () => {
      const a = single(mkImg({ id: 'img-1000-a', savedAt: 100 }));
      const b = single(mkImg({ id: 'img-2000-b', savedAt: 300 }));
      const c = single(mkImg({ id: 'img-3000-c', savedAt: 200 }));
      const out = sortPostItems([a, b, c], 'savedAt', []);
      expect(out.map((i) => (i.kind === 'single' ? i.img.id : ''))).toEqual([
        'img-2000-b',
        'img-3000-c',
        'img-1000-a',
      ]);
    });

    it('uses max savedAt across carousel images', () => {
      const cx = carousel('auto-x', [
        mkImg({ id: 'img-1-a', savedAt: 50 }),
        mkImg({ id: 'img-1-b', savedAt: 400 }),
      ]);
      const s = single(mkImg({ id: 'img-2', savedAt: 200 }));
      const out = sortPostItems([s, cx], 'savedAt', []);
      expect(out[0]).toBe(cx);
      expect(out[1]).toBe(s);
    });
  });

  describe('scheduled — soonest first, unscheduled last', () => {
    const posts: ScheduledPost[] = [
      { id: 'p1', imageId: 'img-A', date: '2026-05-10', time: '12:00', platforms: ['instagram'], caption: '', status: 'scheduled' },
      { id: 'p2', imageId: 'img-B', date: '2026-05-05', time: '12:00', platforms: ['instagram'], caption: '', status: 'scheduled' },
    ];

    it('ascending by scheduled time', () => {
      const a = single(mkImg({ id: 'img-A', savedAt: 1 }));
      const b = single(mkImg({ id: 'img-B', savedAt: 2 }));
      const out = sortPostItems([a, b], 'scheduled', posts);
      expect(out[0]).toBe(b);
      expect(out[1]).toBe(a);
    });

    it('pushes unscheduled items to the end', () => {
      const unscheduled = single(mkImg({ id: 'img-Z', savedAt: 999 }));
      const a = single(mkImg({ id: 'img-A', savedAt: 1 }));
      const out = sortPostItems([unscheduled, a], 'scheduled', posts);
      expect(out[0]).toBe(a);
      expect(out[1]).toBe(unscheduled);
    });

    it('ignores posted or rejected schedules', () => {
      const ghostPosts: ScheduledPost[] = [
        { id: 'p1', imageId: 'img-A', date: '2026-05-10', time: '12:00', platforms: ['instagram'], caption: '', status: 'posted' },
        { id: 'p2', imageId: 'img-A', date: '2026-05-20', time: '12:00', platforms: ['instagram'], caption: '', status: 'rejected' },
      ];
      const a = single(mkImg({ id: 'img-A', savedAt: 1 }));
      const b = single(mkImg({ id: 'img-B', savedAt: 2 }));
      const out = sortPostItems([a, b], 'scheduled', ghostPosts);
      // Both are effectively unscheduled; relative order preserved (stable sort).
      expect(out[0]).toBe(a);
      expect(out[1]).toBe(b);
    });
  });

  describe('created — parse timestamp from img id', () => {
    it('orders by `img-<timestamp>-…` descending', () => {
      const a = single(mkImg({ id: 'img-1000000000-a', savedAt: 500 }));
      const b = single(mkImg({ id: 'img-3000000000-b', savedAt: 100 }));
      const c = single(mkImg({ id: 'img-2000000000-c', savedAt: 300 }));
      const out = sortPostItems([a, b, c], 'created', []);
      expect(out.map((i) => (i.kind === 'single' ? i.img.id : ''))).toEqual([
        'img-3000000000-b',
        'img-2000000000-c',
        'img-1000000000-a',
      ]);
    });

    it('falls back to 0 for ids that do not match the timestamped pattern', () => {
      const legacy = single(mkImg({ id: 'legacy-uuid', savedAt: 999 }));
      const fresh = single(mkImg({ id: 'img-5000000000-x', savedAt: 1 }));
      const out = sortPostItems([legacy, fresh], 'created', []);
      expect(out[0]).toBe(fresh);
      expect(out[1]).toBe(legacy);
    });
  });
});
