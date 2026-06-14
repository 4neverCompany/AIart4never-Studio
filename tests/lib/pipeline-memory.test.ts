// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createEmptyMemory,
  coerceMemory,
  compressMemory,
  formatMemoryForPrompt,
  getPipelineMemory,
  updatePipelineMemory,
  __test__,
  type PipelineMemory,
} from '@/lib/pipeline-memory';

describe('createEmptyMemory', () => {
  it('produces a zeroed memory', () => {
    const m = createEmptyMemory();
    expect(m.recentConcepts).toEqual([]);
    expect(m.successfulStyles).toEqual([]);
    expect(m.avoidedNegatives).toEqual([]);
    expect(m.nicheWeights).toEqual({});
    expect(m.lastUpdated).toBe(0);
  });
});

describe('coerceMemory', () => {
  it('returns empty for junk input', () => {
    expect(coerceMemory(null)).toEqual(createEmptyMemory());
    expect(coerceMemory(undefined)).toEqual(createEmptyMemory());
    expect(coerceMemory('oops')).toEqual(createEmptyMemory());
    expect(coerceMemory(42)).toEqual(createEmptyMemory());
  });

  it('drops non-string entries from array fields', () => {
    const m = coerceMemory({
      recentConcepts: ['valid', 42, null, 'also-valid', ''],
      successfulStyles: ['style-a'],
    });
    expect(m.recentConcepts).toEqual(['valid', 'also-valid']);
    expect(m.successfulStyles).toEqual(['style-a']);
  });

  it('drops non-positive niche weights', () => {
    const m = coerceMemory({
      nicheWeights: { sci_fi: 3, cursed: 'high', zero: 0, neg: -1, fine: 2 },
    });
    expect(m.nicheWeights).toEqual({ sci_fi: 3, fine: 2 });
  });

  it('truncates arrays to the per-field cap on read', () => {
    const many = Array.from({ length: 50 }, (_, i) => `c${i}`);
    const m = coerceMemory({ recentConcepts: many });
    expect(m.recentConcepts.length).toBe(__test__.MAX_RECENT_CONCEPTS);
    expect(m.recentConcepts[0]).toBe(`c${50 - __test__.MAX_RECENT_CONCEPTS}`);
  });
});

describe('compressMemory', () => {
  it('dedupes preserving last-seen position', () => {
    const input: PipelineMemory = {
      recentConcepts: ['a', 'b', 'a', 'c', 'b'],
      successfulStyles: [],
      avoidedNegatives: [],
      nicheWeights: {},
      lastUpdated: 0,
    };
    expect(compressMemory(input).recentConcepts).toEqual(['a', 'c', 'b']);
  });

  it('caps arrays to their max', () => {
    const input: PipelineMemory = {
      recentConcepts: Array.from({ length: 20 }, (_, i) => `c${i}`),
      successfulStyles: Array.from({ length: 20 }, (_, i) => `s${i}`),
      avoidedNegatives: Array.from({ length: 20 }, (_, i) => `n${i}`),
      nicheWeights: {},
      lastUpdated: 0,
    };
    const out = compressMemory(input);
    expect(out.recentConcepts.length).toBe(__test__.MAX_RECENT_CONCEPTS);
    expect(out.successfulStyles.length).toBe(__test__.MAX_SUCCESSFUL_STYLES);
    expect(out.avoidedNegatives.length).toBe(__test__.MAX_AVOIDED_NEGATIVES);
    expect(out.recentConcepts[out.recentConcepts.length - 1]).toBe('c19');
  });

  it('keeps top niches, drops low weights', () => {
    const weights: Record<string, number> = {};
    for (let i = 0; i < 20; i++) weights[`n${i}`] = i + 1;
    weights.tiny = 0.5;
    const out = compressMemory({
      recentConcepts: [],
      successfulStyles: [],
      avoidedNegatives: [],
      nicheWeights: weights,
      lastUpdated: 0,
    });
    expect(Object.keys(out.nicheWeights).length).toBe(__test__.MAX_NICHES);
    expect(out.nicheWeights).not.toHaveProperty('tiny');
    expect(out.nicheWeights.n19).toBe(20);
  });
});

describe('formatMemoryForPrompt', () => {
  it('returns empty string for null / empty memory', () => {
    expect(formatMemoryForPrompt(null)).toBe('');
    expect(formatMemoryForPrompt(undefined)).toBe('');
    expect(formatMemoryForPrompt(createEmptyMemory())).toBe('');
  });

  it('renders a SESSION MEMORY block', () => {
    const out = formatMemoryForPrompt({
      recentConcepts: ['batman x goku'],
      successfulStyles: ['cinematic'],
      avoidedNegatives: ['blurry'],
      nicheWeights: { sci_fi: 3 },
      lastUpdated: 1,
    });
    expect(out).toContain('[SESSION MEMORY]');
    expect(out).toContain('Recent concepts');
    expect(out).toContain('batman x goku');
    expect(out).toContain('cinematic');
    expect(out).toContain('blurry');
    expect(out).toContain('sci_fi(3)');
  });

  it('omits empty sections', () => {
    const out = formatMemoryForPrompt({
      recentConcepts: ['x'],
      successfulStyles: [],
      avoidedNegatives: [],
      nicheWeights: {},
      lastUpdated: 0,
    });
    expect(out).toContain('Recent concepts');
    expect(out).not.toContain('Styles that worked');
    expect(out).not.toContain('Avoid these');
    expect(out).not.toContain('Active niches');
  });

  it('caps total output at MAX_FORMATTED_WORDS', () => {
    const huge = Array.from({ length: 500 }, (_, i) => `concept-${i}`);
    const out = formatMemoryForPrompt({
      ...createEmptyMemory(),
      recentConcepts: huge,
    });
    const words = out.split(/\s+/).filter(Boolean);
    expect(words.length).toBeLessThanOrEqual(__test__.MAX_FORMATTED_WORDS + 1);
  });
});

describe('localStorage bridge (jsdom)', () => {
  beforeEach(() => {
    window.localStorage.removeItem(__test__.STORAGE_KEY);
  });

  it('returns empty when nothing stored', () => {
    expect(getPipelineMemory()).toEqual(createEmptyMemory());
  });

  it('round-trips via updatePipelineMemory', () => {
    updatePipelineMemory((prev) => ({
      ...prev,
      recentConcepts: [...prev.recentConcepts, 'first'],
      nicheWeights: { sci_fi: 2 },
    }));
    const loaded = getPipelineMemory();
    expect(loaded.recentConcepts).toEqual(['first']);
    expect(loaded.nicheWeights).toEqual({ sci_fi: 2 });
    expect(loaded.lastUpdated).toBeGreaterThan(0);
  });

  it('recovers gracefully from corrupt JSON', () => {
    window.localStorage.setItem(__test__.STORAGE_KEY, '{not json');
    expect(getPipelineMemory()).toEqual(createEmptyMemory());
  });

  it('compresses on every write', () => {
    updatePipelineMemory(() => ({
      recentConcepts: Array.from({ length: 50 }, (_, i) => `c${i}`),
      successfulStyles: [],
      avoidedNegatives: [],
      nicheWeights: {},
      lastUpdated: 0,
    }));
    const loaded = getPipelineMemory();
    expect(loaded.recentConcepts.length).toBe(__test__.MAX_RECENT_CONCEPTS);
  });
});
