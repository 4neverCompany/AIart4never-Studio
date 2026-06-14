// V040-009: per-platform native crop aspect ratios for the
// Post Ready preview. These are the *feed* aspect ratios each
// platform crops to when an image is uploaded without a custom
// crop — matching what the user will actually see in their feed
// after posting.

import type { PostPlatform } from '@/types/mashup';

export interface PlatformAspect {
  /** Tailwind aspect-* utility class (e.g. "aspect-square"). */
  className: string;
  /** Human-readable ratio label (e.g. "1:1", "4:5"). */
  ratio: string;
  /** Short note describing how the platform uses this aspect. */
  note: string;
  /**
   * Two-character platform abbreviation for the AspectPreview tab strip
   * (V040-HOTFIX-005). The previous `p.slice(0, 2)` rendered "in/pi/tw/di"
   * — readable for nobody. These match the conventional short forms
   * users already see on the Pipeline panel platform pills.
   */
  shortLabel: string;
}

/**
 * Defaults reflect each platform's *primary* feed crop:
 * - Instagram: 1:1 square — feed default. (Reels/4:5 are out of scope here.)
 * - Pinterest: 2:3 portrait — the recommended pin aspect; anything taller
 *   than 2:3 gets center-cropped, anything wider gets letterboxed.
 * - Twitter/X: 16:9 — single-image in-feed crop. (Wider images get the
 *   center band; the full image still appears on click.)
 * - Discord: 1:1 — webhooks render with no crop, but Discord's embed
 *   thumbnail in cluttered channels squares the image. 1:1 is the
 *   safest "first impression" preview.
 */
export const PLATFORM_ASPECT: Record<PostPlatform, PlatformAspect> = {
  instagram: {
    className: 'aspect-square',
    ratio: '1:1',
    note: 'Feed default — square crop',
    shortLabel: 'IG',
  },
  pinterest: {
    className: 'aspect-[2/3]',
    ratio: '2:3',
    note: 'Recommended pin — portrait crop',
    shortLabel: 'PN',
  },
  twitter: {
    className: 'aspect-video',
    ratio: '16:9',
    note: 'In-feed single image — landscape crop',
    shortLabel: 'TW',
  },
  discord: {
    className: 'aspect-square',
    ratio: '1:1',
    note: 'Embed thumbnail — square preview',
    shortLabel: 'DC',
  },
};

/** Safe lookup that falls back to a square preview when a platform
 *  isn't recognized (e.g., a future channel that hasn't been mapped
 *  yet — better to show *something* than throw). */
export function getAspectFor(platform: PostPlatform | null | undefined): PlatformAspect {
  if (!platform) {
    return { className: 'aspect-square', ratio: '1:1', note: 'No platform selected', shortLabel: '—' };
  }
  return (
    PLATFORM_ASPECT[platform] ??
    { className: 'aspect-square', ratio: '1:1', note: '', shortLabel: '?' }
  );
}
