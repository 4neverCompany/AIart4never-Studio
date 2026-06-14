// V040-HOTFIX-002 / V080-DEV-003: degrade-guard for carousel approval
// rejects. The original 2-image floor was lifted in V080-DEV-003 — a
// 2→1 reject is now allowed and `groupApprovalPosts` collapses the
// surviving 1-sibling group into a single-card item, which posts via
// the `/api/social/post` single-image branch (igMediaUrls.length === 1).
// The floor is now 1 — only the very last image is locked behind the
// explicit "Reject carousel" path.

import { describe, it, expect } from 'vitest';
import {
  CAROUSEL_MIN_IMAGES,
  canRejectMoreInCarousel,
} from '@/lib/carousel-degrade-guard';

describe('carousel-degrade-guard', () => {
  it('exposes the carousel minimum as 1 (V080-DEV-003: 2-image floor lifted)', () => {
    expect(CAROUSEL_MIN_IMAGES).toBe(1);
  });

  it('allows reject when there is room above the minimum (3 → 2)', () => {
    expect(canRejectMoreInCarousel(3)).toBe(true);
  });

  it('allows reject for any healthy carousel above the minimum', () => {
    expect(canRejectMoreInCarousel(4)).toBe(true);
    expect(canRejectMoreInCarousel(10)).toBe(true);
  });

  it('V080-DEV-003: allows reject at 2 images — survivor collapses to a single-image post', () => {
    expect(canRejectMoreInCarousel(2)).toBe(true);
  });

  it('blocks reject at the 1-image floor — the last image must go through "Reject carousel"', () => {
    expect(canRejectMoreInCarousel(1)).toBe(false);
  });

  it('blocks reject below the floor (defensive — should not normally be reached)', () => {
    expect(canRejectMoreInCarousel(0)).toBe(false);
  });
});
