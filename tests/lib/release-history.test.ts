// V083-UPDATE-UI — pins the release-history data source contract so the
// Updates UI in DesktopSettingsPanel can trust the shape and ordering
// of entries without defensive branches.

import { describe, it, expect } from 'vitest';
import {
  RELEASE_HISTORY,
  recentReleases,
  releaseByVersion,
} from '@/lib/release-history';

describe('RELEASE_HISTORY shape', () => {
  it('has at least one release', () => {
    expect(RELEASE_HISTORY.length).toBeGreaterThan(0);
  });

  it('every entry has a semver-ish version, ISO date, and at least one highlight', () => {
    for (const r of RELEASE_HISTORY) {
      expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.highlights.length).toBeGreaterThan(0);
      for (const h of r.highlights) {
        expect(h.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('versions are unique', () => {
    const seen = new Set<string>();
    for (const r of RELEASE_HISTORY) {
      expect(seen.has(r.version)).toBe(false);
      seen.add(r.version);
    }
  });
});

describe('recentReleases', () => {
  it('returns the requested count when ≤ history length', () => {
    expect(recentReleases(3)).toHaveLength(3);
  });

  it('clamps to history length when over-requested', () => {
    expect(recentReleases(999)).toHaveLength(RELEASE_HISTORY.length);
  });

  it('returns [] for non-positive limits', () => {
    expect(recentReleases(0)).toEqual([]);
    expect(recentReleases(-5)).toEqual([]);
  });

  it('preserves newest-first ordering', () => {
    const top2 = recentReleases(2);
    expect(top2[0]).toBe(RELEASE_HISTORY[0]);
    expect(top2[1]).toBe(RELEASE_HISTORY[1]);
  });
});

describe('releaseByVersion', () => {
  it('finds a known release', () => {
    const first = RELEASE_HISTORY[0];
    expect(releaseByVersion(first.version)).toBe(first);
  });

  it('returns null for an unknown version', () => {
    expect(releaseByVersion('99.99.99')).toBeNull();
  });
});
