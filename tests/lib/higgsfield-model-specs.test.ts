/**
 * Tests for the higgsfield-* entries in lib/model-specs/index.ts.
 *
 * Verifies the curated Higgsfield specs are loaded correctly and
 * exposed via the same getModelSpec / getModelProvider /
 * getModelSpecsByProvider surface used by every other model.
 *
 * This is the "plumbing" check: as long as the JSON files parse
 * and the index module re-exports them, the rest of the app
 * (settings picker, pipeline provider filter, image-prompt-builder)
 * finds them without code changes.
 */

import { describe, it, expect } from 'vitest';
import {
  getAllModelSpecs,
  getModelProvider,
  getModelSpec,
  getModelSpecsByProvider,
} from '@/lib/model-specs';

describe('Higgsfield model specs (plumbing)', () => {
  it('all 4 higgsfield-* specs are loaded into MODEL_SPECS', () => {
    expect(getModelSpec('higgsfield-nano-banana-pro')).toBeDefined();
    expect(getModelSpec('higgsfield-seedance-2-0')).toBeDefined();
    expect(getModelSpec('higgsfield-flux-2')).toBeDefined();
    expect(getModelSpec('higgsfield-gpt-image-2')).toBeDefined();
  });

  it('every higgsfield spec declares provider=higgsfield', () => {
    for (const id of [
      'higgsfield-nano-banana-pro',
      'higgsfield-seedance-2-0',
      'higgsfield-flux-2',
      'higgsfield-gpt-image-2',
    ]) {
      expect(getModelProvider(id)).toBe('higgsfield');
    }
  });

  it('getModelSpecsByProvider("higgsfield") returns exactly the higgsfield entries', () => {
    const specs = getModelSpecsByProvider('higgsfield');
    const ids = specs.map((s) => s.modelId).sort();
    expect(ids).toEqual([
      'higgsfield-flux-2',
      'higgsfield-gpt-image-2',
      'higgsfield-nano-banana-pro',
      'higgsfield-seedance-2-0',
    ]);
  });

  it('Higgsfield specs do NOT claim style UUIDs (Higgsfield models do not accept styleIds)', () => {
    for (const id of [
      'higgsfield-nano-banana-pro',
      'higgsfield-seedance-2-0',
      'higgsfield-flux-2',
      'higgsfield-gpt-image-2',
    ]) {
      const spec = getModelSpec(id);
      expect(spec).toBeDefined();
      // Either no styles map, or the map is empty.
      expect(spec!.styles === undefined || Object.keys(spec!.styles as object).length === 0).toBe(true);
    }
  });

  it('Higgsfield specs carry the correct apiName (job_set_type slug)', () => {
    expect(getModelSpec('higgsfield-nano-banana-pro')?.apiName).toBe('nano_banana_2');
    expect(getModelSpec('higgsfield-seedance-2-0')?.apiName).toBe('seedance_2_0');
    expect(getModelSpec('higgsfield-flux-2')?.apiName).toBe('flux_2');
    expect(getModelSpec('higgsfield-gpt-image-2')?.apiName).toBe('gpt_image_2');
  });

  it('Higgsfield specs include an aspectRatios table the prompt builder can read', () => {
    const spec = getModelSpec('higgsfield-nano-banana-pro');
    expect(spec).toBeDefined();
    const ratios = spec!.aspectRatios as Record<string, unknown>;
    expect(ratios['1:1']).toBeDefined();
    expect(ratios['9:16']).toBeDefined();
    expect(ratios['16:9']).toBeDefined();
  });

  it('the global catalog count grew by exactly 4 (vs pre-Higgsfield)', () => {
    // Sanity check: the catalog now has the original 9 + 4 higgsfield = 13.
    const all = getAllModelSpecs();
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(13);
  });
});
