// @vitest-environment jsdom
/**
 * Unit tests for lib/outcome-tracker.ts
 *
 * Tests run in jsdom so localStorage is available. Each test clears
 * storage in beforeEach to guarantee isolation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordOutcome,
  getRecentOutcomes,
  getStyleSuccessRate,
  getOutcomeSummary,
  type PostOutcome,
} from '@/lib/outcome-tracker';

const STORAGE_KEY = 'mashup_outcome_history';

function makeOutcome(overrides: Partial<PostOutcome> = {}): PostOutcome {
  return {
    imageId: `img-${Math.random().toString(36).slice(2, 7)}`,
    prompt: 'test prompt',
    style: 'Dynamic',
    aspectRatio: '1:1',
    model: 'nano-banana-2',
    status: 'posted',
    platform: 'instagram',
    timestamp: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
});

// ─── recordOutcome ────────────────────────────────────────────────────────────

describe('recordOutcome', () => {
  it('stores an outcome in localStorage', () => {
    recordOutcome(makeOutcome({ imageId: 'img-a' }));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as PostOutcome[];
    expect(stored).toHaveLength(1);
    expect(stored[0].imageId).toBe('img-a');
  });

  it('appends subsequent outcomes', () => {
    recordOutcome(makeOutcome({ imageId: 'img-a' }));
    recordOutcome(makeOutcome({ imageId: 'img-b' }));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as PostOutcome[];
    expect(stored).toHaveLength(2);
    expect(stored.map((o) => o.imageId)).toEqual(['img-a', 'img-b']);
  });

  it('rotates oldest entries when cap (100) is reached', () => {
    for (let i = 0; i < 100; i++) {
      recordOutcome(makeOutcome({ imageId: `img-${i}`, timestamp: i }));
    }
    // 100 entries — at cap, not yet rotating
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toHaveLength(100);

    // Add the 101st — should drop img-0
    recordOutcome(makeOutcome({ imageId: 'img-new' }));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as PostOutcome[];
    expect(stored).toHaveLength(100);
    expect(stored[0].imageId).toBe('img-1');
    expect(stored[99].imageId).toBe('img-new');
  });

  it('stores all outcome fields including optional engagement', () => {
    const outcome = makeOutcome({
      imageId: 'img-x',
      style: 'Ray Traced',
      status: 'posted',
      engagement: { likes: 42, comments: 5, fetchedAt: 1000 },
    });
    recordOutcome(outcome);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as PostOutcome[];
    expect(stored[0].engagement?.likes).toBe(42);
    expect(stored[0].engagement?.comments).toBe(5);
  });

  it('stores rejected outcome correctly', () => {
    recordOutcome(makeOutcome({ imageId: 'img-r', status: 'rejected' }));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as PostOutcome[];
    expect(stored[0].status).toBe('rejected');
  });
});

// ─── getRecentOutcomes ────────────────────────────────────────────────────────

describe('getRecentOutcomes', () => {
  it('returns empty array when no outcomes recorded', () => {
    expect(getRecentOutcomes()).toEqual([]);
  });

  it('returns all outcomes when no count given', () => {
    recordOutcome(makeOutcome({ imageId: 'a' }));
    recordOutcome(makeOutcome({ imageId: 'b' }));
    recordOutcome(makeOutcome({ imageId: 'c' }));
    expect(getRecentOutcomes()).toHaveLength(3);
  });

  it('returns the last N outcomes when count is specified', () => {
    for (let i = 0; i < 10; i++) {
      recordOutcome(makeOutcome({ imageId: `img-${i}` }));
    }
    const recent = getRecentOutcomes(3);
    expect(recent).toHaveLength(3);
    expect(recent.map((o) => o.imageId)).toEqual(['img-7', 'img-8', 'img-9']);
  });

  it('returns all when count >= total length', () => {
    recordOutcome(makeOutcome({ imageId: 'a' }));
    recordOutcome(makeOutcome({ imageId: 'b' }));
    expect(getRecentOutcomes(100)).toHaveLength(2);
  });

  it('count=0 returns empty array', () => {
    recordOutcome(makeOutcome());
    expect(getRecentOutcomes(0)).toEqual([]);
  });
});

// ─── getStyleSuccessRate ──────────────────────────────────────────────────────

describe('getStyleSuccessRate', () => {
  it('returns 0 when no outcomes for that style', () => {
    expect(getStyleSuccessRate('Dynamic')).toBe(0);
  });

  it('returns 100 when all outcomes for the style are posted', () => {
    recordOutcome(makeOutcome({ style: 'Dynamic', status: 'posted' }));
    recordOutcome(makeOutcome({ style: 'Dynamic', status: 'posted' }));
    expect(getStyleSuccessRate('Dynamic')).toBe(100);
  });

  it('returns 0 when all outcomes for the style are rejected', () => {
    recordOutcome(makeOutcome({ style: 'Dynamic', status: 'rejected' }));
    recordOutcome(makeOutcome({ style: 'Dynamic', status: 'skipped' }));
    expect(getStyleSuccessRate('Dynamic')).toBe(0);
  });

  it('returns correct percentage for mixed outcomes', () => {
    recordOutcome(makeOutcome({ style: 'Ray Traced', status: 'posted' }));
    recordOutcome(makeOutcome({ style: 'Ray Traced', status: 'posted' }));
    recordOutcome(makeOutcome({ style: 'Ray Traced', status: 'rejected' }));
    recordOutcome(makeOutcome({ style: 'Ray Traced', status: 'skipped' }));
    // 2/4 = 50%
    expect(getStyleSuccessRate('Ray Traced')).toBe(50);
  });

  it('is case-insensitive', () => {
    recordOutcome(makeOutcome({ style: 'dynamic', status: 'posted' }));
    expect(getStyleSuccessRate('Dynamic')).toBe(100);
    expect(getStyleSuccessRate('DYNAMIC')).toBe(100);
  });

  it('isolates by style — other styles do not affect the rate', () => {
    recordOutcome(makeOutcome({ style: 'Dynamic', status: 'posted' }));
    recordOutcome(makeOutcome({ style: 'Illustration', status: 'rejected' }));
    recordOutcome(makeOutcome({ style: 'Illustration', status: 'rejected' }));
    expect(getStyleSuccessRate('Dynamic')).toBe(100);
    expect(getStyleSuccessRate('Illustration')).toBe(0);
  });
});

// ─── getOutcomeSummary ────────────────────────────────────────────────────────

describe('getOutcomeSummary', () => {
  it('returns empty string when fewer than 3 outcomes recorded', () => {
    recordOutcome(makeOutcome());
    recordOutcome(makeOutcome());
    expect(getOutcomeSummary()).toBe('');
  });

  it('returns a non-empty string once 3 or more outcomes exist', () => {
    recordOutcome(makeOutcome({ style: 'Dynamic', status: 'posted' }));
    recordOutcome(makeOutcome({ style: 'Dynamic', status: 'posted' }));
    recordOutcome(makeOutcome({ style: 'Dynamic', status: 'posted' }));
    expect(getOutcomeSummary()).not.toBe('');
  });

  it('includes top posted styles in the summary', () => {
    for (let i = 0; i < 4; i++) {
      recordOutcome(makeOutcome({ style: 'Dynamic', status: 'posted' }));
    }
    for (let i = 0; i < 3; i++) {
      recordOutcome(makeOutcome({ style: 'Illustration', status: 'posted' }));
    }
    const summary = getOutcomeSummary();
    expect(summary).toMatch(/Dynamic/);
    expect(summary).toMatch(/Illustration/);
  });

  it('mentions recently skipped styles', () => {
    // 3 posted to pass the minimum-3 gate
    recordOutcome(makeOutcome({ style: 'Dynamic', status: 'posted' }));
    recordOutcome(makeOutcome({ style: 'Dynamic', status: 'posted' }));
    recordOutcome(makeOutcome({ style: 'Dynamic', status: 'posted' }));
    // 2 rejected
    recordOutcome(makeOutcome({ style: 'Ray Traced', status: 'rejected' }));
    recordOutcome(makeOutcome({ style: 'Ray Traced', status: 'rejected' }));

    const summary = getOutcomeSummary();
    expect(summary).toMatch(/skipped|rejected/i);
    expect(summary).toMatch(/Ray Traced/);
  });

  it('summary ends with a period', () => {
    for (let i = 0; i < 5; i++) {
      recordOutcome(makeOutcome({ style: 'Dynamic', status: 'posted' }));
    }
    expect(getOutcomeSummary()).toMatch(/\.$/);
  });

  it('styles with only 1 outcome are excluded from the posted breakdown', () => {
    // 1 outcome for "Rare Style" — below the 2-entry threshold
    recordOutcome(makeOutcome({ style: 'Rare Style', status: 'posted' }));
    // 3 for Dynamic to pass minimum gate
    recordOutcome(makeOutcome({ style: 'Dynamic', status: 'posted' }));
    recordOutcome(makeOutcome({ style: 'Dynamic', status: 'posted' }));
    recordOutcome(makeOutcome({ style: 'Dynamic', status: 'posted' }));

    const summary = getOutcomeSummary();
    // Dynamic should appear (3 outcomes), Rare Style should not (only 1)
    expect(summary).toMatch(/Dynamic/);
    expect(summary).not.toMatch(/Rare Style/);
  });
});
