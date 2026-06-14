// V040-009: per-platform aspect lookup tests.

import { describe, it, expect } from 'vitest';
import { PLATFORM_ASPECT, getAspectFor } from '@/lib/platform-aspect';

describe('PLATFORM_ASPECT', () => {
  it('maps every PostPlatform to a tailwind aspect class + label', () => {
    for (const p of ['instagram', 'pinterest', 'twitter', 'discord'] as const) {
      const a = PLATFORM_ASPECT[p];
      expect(a.className).toMatch(/^aspect-/);
      expect(a.ratio).toMatch(/^\d+:\d+$/);
      expect(a.note.length).toBeGreaterThan(0);
    }
  });

  it('uses the documented platform-native ratios', () => {
    expect(PLATFORM_ASPECT.instagram.ratio).toBe('1:1');
    expect(PLATFORM_ASPECT.pinterest.ratio).toBe('2:3');
    expect(PLATFORM_ASPECT.twitter.ratio).toBe('16:9');
    expect(PLATFORM_ASPECT.discord.ratio).toBe('1:1');
  });

  it('exposes readable two-character shortLabels for the AspectPreview tab strip (V040-HOTFIX-005)', () => {
    expect(PLATFORM_ASPECT.instagram.shortLabel).toBe('IG');
    expect(PLATFORM_ASPECT.pinterest.shortLabel).toBe('PN');
    expect(PLATFORM_ASPECT.twitter.shortLabel).toBe('TW');
    expect(PLATFORM_ASPECT.discord.shortLabel).toBe('DC');
  });
});

describe('getAspectFor', () => {
  it('returns the platform aspect when given a known platform', () => {
    expect(getAspectFor('pinterest').ratio).toBe('2:3');
    expect(getAspectFor('twitter').className).toBe('aspect-video');
  });

  it('falls back to a 1:1 square preview for null/undefined', () => {
    expect(getAspectFor(null).ratio).toBe('1:1');
    expect(getAspectFor(undefined).className).toBe('aspect-square');
  });

  it('returns a non-empty shortLabel even on the null fallback (defensive against UI rendering "")', () => {
    expect(getAspectFor(null).shortLabel.length).toBeGreaterThan(0);
    expect(getAspectFor(undefined).shortLabel.length).toBeGreaterThan(0);
  });
});
