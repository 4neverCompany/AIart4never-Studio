/**
 * v1.2.3 — Eval aggregate unit tests.
 *
 * Each heuristic is a pure function, so we can drive it
 * with hand-crafted inputs and snapshot the output. The
 * tests intentionally don't depend on any IO, the
 * network, or the run-context — just the heuristics.
 */
import { describe, it, expect } from 'vitest';
import {
  evalNicheCoverage,
  evalCameraAngle,
  evalAntiAiLook,
  evalLength,
  evalAll,
  DEFAULT_WEIGHTS,
} from '@/lib/agent-eval';

describe('evalNicheCoverage', () => {
  it('returns 1.0 when no niches are requested', () => {
    const r = evalNicheCoverage('A long prompt that mentions nothing.', []);
    expect(r.score).toBe(1);
    expect(r.present).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it('counts only present niches case-insensitively', () => {
    const r = evalNicheCoverage(
      'Darth Vader duels Iron Man in a Marvel vs Star Wars crossover.',
      ['marvel', 'star wars', 'warhammer'],
    );
    expect(r.score).toBeCloseTo(2 / 3);
    expect(r.present).toEqual(['marvel', 'star wars']);
    expect(r.missing).toEqual(['warhammer']);
  });

  it('treats blank niche strings as missing', () => {
    // Use a prompt that mentions "marvel" so the score
    // is 0.5 (1 of 2 niches matches). The blank niche is
    // counted as missing.
    const r = evalNicheCoverage('A marvel prompt.', ['marvel', '   ']);
    expect(r.score).toBeCloseTo(0.5);
    expect(r.present).toEqual(['marvel']);
    expect(r.missing).toEqual(['   ']);
  });

  it('matches substrings (e.g. "marvel" in "marvel cinematic")', () => {
    const r = evalNicheCoverage('The marvel cinematic universe shows...', ['marvel']);
    expect(r.score).toBe(1);
  });
});

describe('evalCameraAngle', () => {
  it('returns 1.0 when a known angle is named', () => {
    expect(evalCameraAngle('A low angle shot of the duelist.')).toMatchObject({
      score: 1,
      hasExplicitAngle: true,
      matched: 'low angle',
    });
  });

  it('returns 0.5 when only a generic word is present', () => {
    expect(evalCameraAngle('A view of the duelist.')).toMatchObject({
      score: 0.5,
      hasExplicitAngle: false,
      matched: null,
    });
  });

  it('returns 0 when no angle reference at all', () => {
    expect(evalCameraAngle('The duelist stands in the rain.')).toMatchObject({
      score: 0,
      hasExplicitAngle: false,
    });
  });

  it('is case-insensitive', () => {
    expect(evalCameraAngle('A WORM-EYE View.')).toMatchObject({ score: 1 });
  });
});

describe('evalAntiAiLook', () => {
  it('returns 0 when no negatives present', () => {
    const r = evalAntiAiLook('A beautiful portrait.');
    expect(r.score).toBe(0);
    expect(r.hasNegatives).toBe(false);
  });

  it('returns a positive score when one negative is present', () => {
    const r = evalAntiAiLook('Portrait, no blurry artifacts.');
    expect(r.score).toBeGreaterThan(0);
    expect(r.hasNegatives).toBe(true);
    expect(r.matches).toContain('blurry');
  });

  it('caps the score at 1.0 when 4+ negatives match', () => {
    const r = evalAntiAiLook('No blurry, no extra fingers, no asymmetric eyes, no deformed, no malformed.');
    expect(r.score).toBe(1);
    expect(r.matches.length).toBeGreaterThanOrEqual(4);
  });
});

describe('evalLength', () => {
  it('scores 1 inside the ideal range', () => {
    // 60 words
    const prompt = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const r = evalLength(prompt);
    expect(r.score).toBe(1);
    expect(r.withinIdeal).toBe(true);
    expect(r.wordCount).toBe(60);
  });

  it('scores 0.5 in the soft range', () => {
    const prompt = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const r = evalLength(prompt);
    expect(r.score).toBe(0.5);
    expect(r.withinSoft).toBe(true);
  });

  it('scores 0 outside both ranges', () => {
    const prompt = 'too short';
    const r = evalLength(prompt);
    expect(r.score).toBe(0);
    expect(r.withinIdeal).toBe(false);
    expect(r.withinSoft).toBe(false);
    expect(r.wordCount).toBe(2);
  });

  it('counts words via whitespace split, not length', () => {
    const r = evalLength('a b c d e');
    expect(r.wordCount).toBe(5);
  });
});

describe('evalAll', () => {
  const sampleNiches = ['marvel', 'star wars'];

  it('returns overall + per-heuristic breakdown', () => {
    // Build a prompt that's clearly inside the ideal 50-150
    // word range by repeating the same scene description
    // a few times. The repeating copy may look silly, but
    // it deterministically lands us in the IDEAL bucket
    // without depending on a particular camera-angle
    // heuristic finding more matches.
    const scene = 'A low angle shot of Darth Vader in Iron Man armor, raining sparks, Marvel meets Star Wars. ';
    const prompt = scene.repeat(4);
    const r = evalAll({ prompt, niches: sampleNiches });
    expect(r.overall).toBeGreaterThan(0.7);
    expect(r.breakdown.nicheCoverage.score).toBe(1);
    expect(r.breakdown.cameraAngle.hasExplicitAngle).toBe(true);
    expect(r.breakdown.lengthBudget.withinIdeal).toBe(true);
    expect(r.breakdown.lengthBudget.wordCount).toBeGreaterThanOrEqual(50);
    expect(r.breakdown.lengthBudget.wordCount).toBeLessThanOrEqual(150);
    expect(r.issues).not.toContain('length-budget');
    expect(r.issues).not.toContain('niche-coverage');
    expect(r.issues).not.toContain('camera-angle');
  });

  it('lists issues for low-scoring heuristics', () => {
    const r = evalAll({
      prompt: 'A prompt with no niche coverage and no angle.',
      niches: ['marvel', 'star wars', 'warhammer'],
    });
    expect(r.issues).toContain('niche-coverage');
    expect(r.issues).toContain('camera-angle');
    expect(r.overall).toBeLessThan(0.5);
  });

  it('honours custom weights', () => {
    const r = evalAll({
      prompt: 'A Marvel prompt with no other signals.',
      niches: ['marvel'],
      weights: {
        nicheCoverage: 1.0,
        cameraAngle: 0,
        antiAiLook: 0,
        lengthBudget: 0,
      },
    });
    expect(r.overall).toBe(1);
  });

  it('default weights are reasonable', () => {
    expect(DEFAULT_WEIGHTS.nicheCoverage).toBeGreaterThan(DEFAULT_WEIGHTS.cameraAngle);
    expect(Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(1);
  });
});
