import { describe, it, expect } from 'vitest';
import {
  PLATFORM_GROUPS,
  PLATFORM_OWNED_KEYS,
  DESKTOP_CONFIG_KEYS,
  isPlatformEnabled,
  platformEnabledDefault,
} from '@/lib/desktop-config-keys';

// V060-002 / V1.9.2 (#47b): pins the platform-toggle contract used by the
// Desktop tab.
//   - All four platforms (incl. Instagram since #47b) have an explicit enable
//     flag persisted to config.json. Empty / absent flag falls back to
//     "on if any creds exist" so existing setups don't get hidden on
//     first load after the redesign.
//   - PLATFORM_OWNED_KEYS contains every field key + every enable key,
//     so DesktopSettingsPanel knows to skip them in the generic flat
//     loop and only render them inside the platform group.
describe('PLATFORM_GROUPS', () => {
  it('declares the four supported platforms in the expected order', () => {
    expect(PLATFORM_GROUPS.map((g) => g.id)).toEqual([
      'instagram',
      'twitter',
      'pinterest',
      'discord',
    ]);
  });

  it('marks Instagram as toggleable with an enable flag (V1.9.2 #47b)', () => {
    const ig = PLATFORM_GROUPS.find((g) => g.id === 'instagram')!;
    expect(ig.alwaysOn).toBe(false);
    expect(ig.enabledKey).toBe('INSTAGRAM_ENABLED');
  });

  it('every non-core platform has a non-null enabledKey', () => {
    for (const g of PLATFORM_GROUPS) {
      if (!g.alwaysOn) {
        expect(g.enabledKey).not.toBeNull();
        expect(typeof g.enabledKey).toBe('string');
      }
    }
  });

  it('every fieldKey and enabledKey is registered in DESKTOP_CONFIG_KEYS', () => {
    const declared = new Set(DESKTOP_CONFIG_KEYS.map((m) => m.key));
    for (const g of PLATFORM_GROUPS) {
      for (const k of g.fieldKeys) expect(declared.has(k)).toBe(true);
      if (g.enabledKey) expect(declared.has(g.enabledKey)).toBe(true);
    }
  });

  it('PLATFORM_OWNED_KEYS covers every platform field + enable flag', () => {
    for (const g of PLATFORM_GROUPS) {
      for (const k of g.fieldKeys) expect(PLATFORM_OWNED_KEYS.has(k)).toBe(true);
      if (g.enabledKey) expect(PLATFORM_OWNED_KEYS.has(g.enabledKey)).toBe(true);
    }
  });
});

describe('isPlatformEnabled / platformEnabledDefault', () => {
  const twitter = PLATFORM_GROUPS.find((g) => g.id === 'twitter')!;
  const instagram = PLATFORM_GROUPS.find((g) => g.id === 'instagram')!;

  it('Instagram defaults ON when creds exist, OFF when none (toggleable since #47b)', () => {
    // No creds, no flag → off (consistent with the other platforms).
    expect(isPlatformEnabled(instagram, {})).toBe(false);
    // Creds present → default-on (graceful migration — existing setups stay on).
    expect(isPlatformEnabled(instagram, { INSTAGRAM_ACCESS_TOKEN: 'tok' })).toBe(true);
    // Explicit '1' / '0' override the default either way.
    expect(isPlatformEnabled(instagram, { INSTAGRAM_ENABLED: '1' })).toBe(true);
    expect(isPlatformEnabled(instagram, { INSTAGRAM_ACCESS_TOKEN: 'tok', INSTAGRAM_ENABLED: '0' })).toBe(false);
  });

  it('Twitter defaults to OFF when no creds exist and no flag is set', () => {
    expect(platformEnabledDefault(twitter, {})).toBe(false);
    expect(isPlatformEnabled(twitter, {})).toBe(false);
  });

  it('Twitter defaults to ON when any field already has a value (graceful migration)', () => {
    const values = { TWITTER_APP_KEY: 'k' };
    expect(platformEnabledDefault(twitter, values)).toBe(true);
    expect(isPlatformEnabled(twitter, values)).toBe(true);
  });

  it("explicit '1' enables Twitter even when no creds exist yet", () => {
    expect(isPlatformEnabled(twitter, { TWITTER_ENABLED: '1' })).toBe(true);
  });

  it("explicit '0' disables Twitter even when creds are stored on disk", () => {
    const values = { TWITTER_APP_KEY: 'k', TWITTER_ENABLED: '0' };
    expect(isPlatformEnabled(twitter, values)).toBe(false);
  });

  it('whitespace-only field value does not trigger the default-on migration', () => {
    expect(platformEnabledDefault(twitter, { TWITTER_APP_KEY: '   ' })).toBe(false);
  });
});
