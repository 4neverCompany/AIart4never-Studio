// TEST-001: extracted from components/MainContent.tsx so the carousel
// grouping logic is unit-testable without spinning up React + the
// MashupContext closure. The wrapper inside MainContent now just
// supplies `settings.carouselGroups` to this pure function.
//
// Behavior is unchanged from the original closure (BUG-001 + WARN-1
// invariants live with the call sites that fan captions to siblings —
// see fanCaptionToGroup in MainContent.tsx).

import type { CarouselGroup, GeneratedImage } from '@/types/mashup';

/** 5-minute window for auto-grouping same-prompt batches. */
export const CAROUSEL_AUTO_WINDOW_MS = 5 * 60 * 1000;

export type PostItem =
  | { kind: 'single'; img: GeneratedImage }
  | { kind: 'carousel'; id: string; images: GeneratedImage[]; group?: CarouselGroup };

/**
 * Group post-ready images into singles + carousels. Explicit groups
 * (from `settings.carouselGroups`) take precedence: every imageId in
 * the group is consumed first. Remaining images are auto-grouped when
 * 2+ share the same prompt and were saved within
 * CAROUSEL_AUTO_WINDOW_MS of the anchor.
 *
 * Output is sorted newest-first by max savedAt within each item, so
 * the most recently saved post-ready content surfaces at the top of
 * the Post Ready / Captioning views.
 */
export function computeCarouselView(
  ready: GeneratedImage[],
  explicitGroups: readonly CarouselGroup[] = [],
): PostItem[] {
  const items: PostItem[] = [];
  const handled = new Set<string>();

  for (const g of explicitGroups) {
    const imgs = g.imageIds
      .map((id) => ready.find((i) => i.id === id))
      .filter((i): i is GeneratedImage => !!i);
    if (imgs.length === 0) continue;
    items.push({ kind: 'carousel', id: g.id, images: imgs, group: g });
    for (const i of imgs) handled.add(i.id);
  }

  const remaining = ready.filter((i) => !handled.has(i.id));
  remaining.sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
  for (let i = 0; i < remaining.length; i++) {
    if (handled.has(remaining[i].id)) continue;
    const anchor = remaining[i];
    const siblings = [anchor];
    for (let j = i + 1; j < remaining.length; j++) {
      const cand = remaining[j];
      if (handled.has(cand.id)) continue;
      if (
        cand.prompt === anchor.prompt &&
        Math.abs((cand.savedAt || 0) - (anchor.savedAt || 0)) <= CAROUSEL_AUTO_WINDOW_MS
      ) {
        siblings.push(cand);
      }
    }
    if (siblings.length > 1) {
      items.push({
        kind: 'carousel',
        id: `auto-${anchor.id}`,
        images: siblings,
      });
      for (const s of siblings) handled.add(s.id);
    } else {
      items.push({ kind: 'single', img: anchor });
      handled.add(anchor.id);
    }
  }

  items.sort((a, b) => {
    const aT = a.kind === 'single' ? a.img.savedAt || 0 : Math.max(...a.images.map((i) => i.savedAt || 0));
    const bT = b.kind === 'single' ? b.img.savedAt || 0 : Math.max(...b.images.map((i) => i.savedAt || 0));
    return bT - aT;
  });
  return items;
}
