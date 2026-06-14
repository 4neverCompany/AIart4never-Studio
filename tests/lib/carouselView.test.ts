import { describe, it, expect } from 'vitest';
import {
  CAROUSEL_AUTO_WINDOW_MS,
  computeCarouselView,
  type PostItem,
} from '@/lib/carouselView';
import type { CarouselGroup, GeneratedImage } from '@/types/mashup';

// ── Fixture helpers ─────────────────────────────────────────────────────────
// Tests build images by overriding only the fields the case cares about;
// everything else takes a known-good default so the test reads as a diff
// against the baseline.

const baseTime = 1_700_000_000_000; // arbitrary epoch ms anchor

function makeImage(overrides: Partial<GeneratedImage> & { id: string }): GeneratedImage {
  return {
    prompt: 'default-prompt',
    savedAt: baseTime,
    isPostReady: true,
    ...overrides,
  };
}

function makeGroup(id: string, imageIds: string[]): CarouselGroup {
  return { id, imageIds };
}

// Convenience: assert a PostItem is a carousel and return it narrowed.
function asCarousel(item: PostItem): Extract<PostItem, { kind: 'carousel' }> {
  if (item.kind !== 'carousel') throw new Error(`expected carousel, got ${item.kind}`);
  return item;
}
function asSingle(item: PostItem): Extract<PostItem, { kind: 'single' }> {
  if (item.kind !== 'single') throw new Error(`expected single, got ${item.kind}`);
  return item;
}

// ── Cases ───────────────────────────────────────────────────────────────────

describe('computeCarouselView', () => {
  it('returns empty array for empty input', () => {
    expect(computeCarouselView([], [])).toEqual([]);
  });

  it('treats a single image as a single PostItem', () => {
    const img = makeImage({ id: 'a' });
    const result = computeCarouselView([img]);
    expect(result).toHaveLength(1);
    expect(asSingle(result[0]).img.id).toBe('a');
  });

  describe('explicit groups', () => {
    it('promotes imageIds in an explicit group to a carousel even when prompts differ', () => {
      // Auto-grouping requires same prompt; explicit groups bypass that.
      const a = makeImage({ id: 'a', prompt: 'alpha', savedAt: baseTime });
      const b = makeImage({ id: 'b', prompt: 'beta',  savedAt: baseTime + 1000 });
      const c = makeImage({ id: 'c', prompt: 'gamma', savedAt: baseTime + 2000 });
      const group = makeGroup('grp-1', ['a', 'b', 'c']);

      const result = computeCarouselView([a, b, c], [group]);
      expect(result).toHaveLength(1);
      const carousel = asCarousel(result[0]);
      expect(carousel.id).toBe('grp-1');
      expect(carousel.images.map((i) => i.id)).toEqual(['a', 'b', 'c']);
      expect(carousel.group).toEqual(group);
    });

    it('skips an explicit group whose imageIds do not exist in `ready`', () => {
      // Real-world: image was deleted but the group still references its id.
      const a = makeImage({ id: 'a' });
      const orphanGroup = makeGroup('grp-orphan', ['ghost-1', 'ghost-2']);

      const result = computeCarouselView([a], [orphanGroup]);
      expect(result).toHaveLength(1);
      expect(asSingle(result[0]).img.id).toBe('a');
    });

    it('partially-resolves an explicit group when only some imageIds exist', () => {
      const a = makeImage({ id: 'a' });
      const b = makeImage({ id: 'b' });
      const partial = makeGroup('grp-partial', ['a', 'ghost', 'b']);

      const result = computeCarouselView([a, b], [partial]);
      expect(result).toHaveLength(1);
      expect(asCarousel(result[0]).images.map((i) => i.id)).toEqual(['a', 'b']);
    });

    it('does not double-count an image present in both an explicit group and an auto-eligible batch', () => {
      // a + b share a prompt and would auto-group, but `a` is locked into
      // an explicit group with `c`. `b` should fall back to a single, NOT
      // pair with `a` again.
      const a = makeImage({ id: 'a', prompt: 'shared', savedAt: baseTime });
      const b = makeImage({ id: 'b', prompt: 'shared', savedAt: baseTime + 1000 });
      const c = makeImage({ id: 'c', prompt: 'other',  savedAt: baseTime + 2000 });
      const explicit = makeGroup('grp-explicit', ['a', 'c']);

      const result = computeCarouselView([a, b, c], [explicit]);
      expect(result).toHaveLength(2);

      const explicitItem = result.find((r) => r.kind === 'carousel') as Extract<PostItem, { kind: 'carousel' }>;
      const singleItem = result.find((r) => r.kind === 'single') as Extract<PostItem, { kind: 'single' }>;
      expect(explicitItem.images.map((i) => i.id).sort()).toEqual(['a', 'c']);
      expect(singleItem.img.id).toBe('b');
    });
  });

  describe('auto-grouping window', () => {
    it('groups same-prompt images saved within the window', () => {
      const a = makeImage({ id: 'a', prompt: 'p', savedAt: baseTime });
      const b = makeImage({ id: 'b', prompt: 'p', savedAt: baseTime + 1000 });
      const c = makeImage({ id: 'c', prompt: 'p', savedAt: baseTime + 60_000 });

      const result = computeCarouselView([a, b, c]);
      expect(result).toHaveLength(1);
      const carousel = asCarousel(result[0]);
      expect(carousel.id).toBe('auto-a'); // anchor is the earliest savedAt
      expect(carousel.images.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    });

    it('does NOT group same-prompt images saved outside the window', () => {
      const a = makeImage({ id: 'a', prompt: 'p', savedAt: baseTime });
      const b = makeImage({
        id: 'b',
        prompt: 'p',
        savedAt: baseTime + CAROUSEL_AUTO_WINDOW_MS + 1, // 1ms past window
      });

      const result = computeCarouselView([a, b]);
      expect(result).toHaveLength(2);
      expect(result.every((r) => r.kind === 'single')).toBe(true);
    });

    it('groups when exactly at the window boundary (inclusive)', () => {
      const a = makeImage({ id: 'a', prompt: 'p', savedAt: baseTime });
      const b = makeImage({ id: 'b', prompt: 'p', savedAt: baseTime + CAROUSEL_AUTO_WINDOW_MS });

      const result = computeCarouselView([a, b]);
      expect(result).toHaveLength(1);
      expect(asCarousel(result[0]).images.map((i) => i.id)).toEqual(['a', 'b']);
    });

    it('does not cross-pollinate prompts even within the window', () => {
      const a = makeImage({ id: 'a', prompt: 'alpha', savedAt: baseTime });
      const b = makeImage({ id: 'b', prompt: 'beta',  savedAt: baseTime + 1000 });

      const result = computeCarouselView([a, b]);
      expect(result).toHaveLength(2);
      expect(result.every((r) => r.kind === 'single')).toBe(true);
    });

    it('keeps images with missing savedAt at epoch 0 — same-prompt pairs still group', () => {
      const a = makeImage({ id: 'a', prompt: 'p', savedAt: undefined });
      const b = makeImage({ id: 'b', prompt: 'p', savedAt: undefined });

      const result = computeCarouselView([a, b]);
      expect(result).toHaveLength(1);
      expect(asCarousel(result[0]).images.map((i) => i.id).sort()).toEqual(['a', 'b']);
    });
  });

  describe('mixed batches', () => {
    it('produces explicit + auto + singles in one pass', () => {
      // Explicit group: x + y
      // Auto group:    p1 + p2 (same prompt, in-window)
      // Single:        s (different prompt)
      const x = makeImage({ id: 'x', prompt: 'manual', savedAt: baseTime });
      const y = makeImage({ id: 'y', prompt: 'manual', savedAt: baseTime + 1000 });
      const p1 = makeImage({ id: 'p1', prompt: 'auto', savedAt: baseTime + 10_000 });
      const p2 = makeImage({ id: 'p2', prompt: 'auto', savedAt: baseTime + 11_000 });
      const s = makeImage({ id: 's', prompt: 'lonely', savedAt: baseTime + 20_000 });
      const explicit = makeGroup('grp-manual', ['x', 'y']);

      const result = computeCarouselView([x, y, p1, p2, s], [explicit]);
      expect(result).toHaveLength(3);

      const carousels = result.filter((r) => r.kind === 'carousel');
      const singles = result.filter((r) => r.kind === 'single');
      expect(carousels).toHaveLength(2);
      expect(singles).toHaveLength(1);

      const explicitC = carousels.find((c) => asCarousel(c).id === 'grp-manual')!;
      const autoC = carousels.find((c) => asCarousel(c).id === 'auto-p1')!;
      expect(asCarousel(explicitC).images.map((i) => i.id)).toEqual(['x', 'y']);
      expect(asCarousel(autoC).images.map((i) => i.id)).toEqual(['p1', 'p2']);
      expect(asSingle(singles[0]).img.id).toBe('s');
    });

    it('orders output newest-first by max savedAt within each item', () => {
      // Single posted last → should be first.
      // Auto carousel in the middle.
      // Explicit carousel oldest → should be last.
      const oldExplicitA = makeImage({ id: 'oldA', prompt: '_', savedAt: baseTime });
      const oldExplicitB = makeImage({ id: 'oldB', prompt: '_', savedAt: baseTime + 1000 });
      const midAuto1 = makeImage({ id: 'mid1', prompt: 'auto', savedAt: baseTime + 100_000 });
      const midAuto2 = makeImage({ id: 'mid2', prompt: 'auto', savedAt: baseTime + 101_000 });
      const newSingle = makeImage({ id: 'new', prompt: 'lonely', savedAt: baseTime + 1_000_000 });
      const explicit = makeGroup('explicit', ['oldA', 'oldB']);

      const result = computeCarouselView(
        [newSingle, oldExplicitA, oldExplicitB, midAuto1, midAuto2],
        [explicit],
      );

      expect(result).toHaveLength(3);
      // newest first
      expect(asSingle(result[0]).img.id).toBe('new');
      expect(asCarousel(result[1]).id).toBe('auto-mid1');
      expect(asCarousel(result[2]).id).toBe('explicit');
    });
  });
});
