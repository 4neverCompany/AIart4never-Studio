/**
 * M3.4-P4-B3 follow-up (v1.8.1 hygiene): the god-file split lifted these
 * pure parsers out of useImageGeneration into
 * lib/image-generation/parseGeneratedItems.ts but only the per-item
 * cameraAngle behavior had a test (tests/hooks/parseGeneratedItems-
 * cameraAngle.test.ts). This covers the rest: getModelName's fallback,
 * pickStringArray's type-filtering, and parseGeneratedItems' field
 * extraction + robustness against malformed / partial input.
 */
import { describe, it, expect } from 'vitest';
import {
  getModelName,
  pickStringArray,
  parseGeneratedItems,
} from '@/lib/image-generation/parseGeneratedItems';

describe('getModelName', () => {
  it('falls back to the raw id for an unknown model', () => {
    expect(getModelName('definitely-not-a-real-model-id')).toBe(
      'definitely-not-a-real-model-id',
    );
  });
});

describe('pickStringArray', () => {
  it('returns undefined for non-array input', () => {
    expect(pickStringArray(undefined)).toBeUndefined();
    expect(pickStringArray(null)).toBeUndefined();
    expect(pickStringArray('a,b')).toBeUndefined();
    expect(pickStringArray(42)).toBeUndefined();
    expect(pickStringArray({ 0: 'a' })).toBeUndefined();
  });

  it('returns only the string members of an array', () => {
    expect(pickStringArray(['a', 1, 'b', null, 'c', {}])).toEqual(['a', 'b', 'c']);
  });

  it('returns undefined when an array has no strings', () => {
    expect(pickStringArray([])).toBeUndefined();
    expect(pickStringArray([1, 2, null, {}])).toBeUndefined();
  });
});

describe('parseGeneratedItems', () => {
  it('maps the scalar + array fields of a well-formed item', () => {
    const raw = JSON.stringify([
      {
        prompt: 'A neon-lit alley',
        aspectRatio: '2:3',
        tags: ['noir', 'neon'],
        selectedNiches: ['Cyberpunk'],
        selectedGenres: ['Noir'],
        negativePrompt: 'blurry, lowres',
      },
    ]);
    expect(parseGeneratedItems(raw)).toEqual([
      {
        prompt: 'A neon-lit alley',
        aspectRatio: '2:3',
        tags: ['noir', 'neon'],
        selectedNiches: ['Cyberpunk'],
        selectedGenres: ['Noir'],
        negativePrompt: 'blurry, lowres',
        cameraAngle: undefined,
      },
    ]);
  });

  it('coerces wrong-typed scalar fields to undefined and keeps the prompt', () => {
    const raw = JSON.stringify([
      { prompt: 'Keep me', aspectRatio: 169, negativePrompt: { not: 'a string' } },
    ]);
    const [item] = parseGeneratedItems(raw);
    expect(item.prompt).toBe('Keep me');
    expect(item.aspectRatio).toBeUndefined();
    expect(item.negativePrompt).toBeUndefined();
  });

  it('drops non-string entries inside tag/niche/genre arrays', () => {
    const raw = JSON.stringify([
      { prompt: 'p', tags: ['ok', 7, null], selectedNiches: [1, 2] },
    ]);
    const [item] = parseGeneratedItems(raw);
    expect(item.tags).toEqual(['ok']);
    // an all-non-string array collapses to undefined
    expect(item.selectedNiches).toBeUndefined();
  });

  it('filters out items with a missing or empty prompt', () => {
    const raw = JSON.stringify([
      { prompt: '' },
      { aspectRatio: '1:1' },
      { prompt: 'real one' },
      { prompt: 123 },
    ]);
    const items = parseGeneratedItems(raw);
    expect(items).toHaveLength(1);
    expect(items[0].prompt).toBe('real one');
  });

  it('filters out non-object array members', () => {
    const raw = JSON.stringify(['a string', 42, null, { prompt: 'survivor' }]);
    const items = parseGeneratedItems(raw);
    expect(items).toHaveLength(1);
    expect(items[0].prompt).toBe('survivor');
  });

  it('returns an empty array for input with no usable JSON array', () => {
    expect(parseGeneratedItems('no json here at all')).toEqual([]);
    expect(parseGeneratedItems('')).toEqual([]);
  });
});
