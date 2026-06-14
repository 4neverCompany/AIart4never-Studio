/**
 * Tests for lib/higgsfield/models.ts — the curated subset of the 35
 * Higgsfield models that MashupForge surfaces in the Studio picker.
 *
 * Invariants we check:
 *   - Every model has a unique slug.
 *   - Display names are non-empty.
 *   - Aspect-ratio allow-lists are non-empty for image models.
 *   - Family tag is one of the documented enum values.
 *   - Credit hint is a positive integer.
 *   - Default image + video model slugs are both present in their
 *     respective catalogs (i.e. you can't default to a non-model).
 */

import { describe, it, expect } from 'vitest';
import {
  HIGGSFIELD_IMAGE_MODELS,
  HIGGSFIELD_VIDEO_MODELS,
  HIGGSFIELD_DEFAULT_IMAGE_MODEL,
  HIGGSFIELD_DEFAULT_VIDEO_MODEL,
  getHiggsfieldImageModel,
  getHiggsfieldVideoModel,
} from '@/lib/higgsfield/models';

const FAMILIES = new Set([
  'nano-banana', 'flux', 'gpt-image', 'seedream', 'soul', 'auto',
  'seedance', 'kling', 'veo', 'wan', 'minimax',
]);

describe('HIGGSFIELD_IMAGE_MODELS', () => {
  it('has unique slugs', () => {
    const slugs = HIGGSFIELD_IMAGE_MODELS.map((m) => m.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
  it('every model has a display name', () => {
    for (const m of HIGGSFIELD_IMAGE_MODELS) {
      expect(m.displayName.length).toBeGreaterThan(0);
    }
  });
  it('every image model has at least one aspect ratio (Higgsfield rejects empty)', () => {
    for (const m of HIGGSFIELD_IMAGE_MODELS) {
      expect(m.aspectRatios.length).toBeGreaterThan(0);
    }
  });
  it('every family is in the documented enum', () => {
    for (const m of HIGGSFIELD_IMAGE_MODELS) {
      expect(FAMILIES.has(m.family)).toBe(true);
    }
  });
  it('credit hint is a positive integer', () => {
    for (const m of HIGGSFIELD_IMAGE_MODELS) {
      expect(Number.isInteger(m.creditHint)).toBe(true);
      expect(m.creditHint).toBeGreaterThan(0);
    }
  });
  it('default image model is present in the catalog', () => {
    expect(getHiggsfieldImageModel(HIGGSFIELD_DEFAULT_IMAGE_MODEL)).toBeDefined();
  });
  it('getHiggsfieldImageModel returns undefined for unknown slugs', () => {
    expect(getHiggsfieldImageModel('not-a-model')).toBeUndefined();
  });
});

describe('HIGGSFIELD_VIDEO_MODELS', () => {
  it('has unique slugs', () => {
    const slugs = HIGGSFIELD_VIDEO_MODELS.map((m) => m.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
  it('every family is in the documented enum', () => {
    for (const m of HIGGSFIELD_VIDEO_MODELS) {
      expect(FAMILIES.has(m.family)).toBe(true);
    }
  });
  it('default video model is present in the catalog', () => {
    expect(getHiggsfieldVideoModel(HIGGSFIELD_DEFAULT_VIDEO_MODEL)).toBeDefined();
  });
  it('image and video slugs do not collide (no slug appears in both catalogs)', () => {
    const img = new Set(HIGGSFIELD_IMAGE_MODELS.map((m) => m.slug));
    for (const m of HIGGSFIELD_VIDEO_MODELS) {
      expect(img.has(m.slug)).toBe(false);
    }
  });
});
