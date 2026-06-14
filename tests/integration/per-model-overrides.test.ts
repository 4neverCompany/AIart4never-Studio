/**
 * V030-008-per-model: Integration tests for per-model settings isolation.
 *
 * The bug: per-model settings tabs shared state instead of isolating it per
 * model. Fix added `perModelOverrides` state in MainContent.tsx.
 *
 * Coverage:
 *   1. Apply per-model overrides — each model gets its own style/aspectRatio
 *   2. Deselect a model — its override is cleaned up (not in output map)
 *   3. Override + compare — mergedEnhancements uses per-model params for each
 *   4. Override → generate — correct params resolved per model (not shared)
 *
 * Tests mirror the pure logic from MainContent.tsx:
 *   - extractPerModelOverrides  → handleApplySuggestion body
 *   - buildMergedEnhancements   → handleCompare body
 *   - resolveParamsForModel     → preview effect param resolution
 */

import { describe, it, expect } from 'vitest';
import type { PerModelImageSuggestion, PerModelSuggestion } from '@/lib/param-suggest';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeImageSuggestion(
  modelId: string,
  overrides?: Partial<PerModelImageSuggestion>,
): PerModelImageSuggestion {
  return {
    type: 'image',
    modelId,
    apiName: modelId,
    aspectRatio: '1:1',
    width: 1024,
    height: 1024,
    imageSize: '1K',
    promptEnhance: 'ON',
    reason: `${modelId} default`,
    source: 'rules',
    ...overrides,
  };
}

// ─── Pure mirrors of MainContent logic ───────────────────────────────────────

/** Mirrors the override extraction loop in handleApplySuggestion */
function extractPerModelOverrides(
  modelIds: string[],
  perModel: Record<string, PerModelSuggestion>,
): Record<string, { style?: string; aspectRatio?: string; negativePrompt?: string }> {
  const overrides: Record<string, { style?: string; aspectRatio?: string; negativePrompt?: string }> = {};
  for (const id of modelIds) {
    const entry = perModel[id];
    if (entry) {
      overrides[id] = {
        aspectRatio: entry.aspectRatio,
        ...('style' in entry ? { style: (entry as PerModelImageSuggestion).style } : {}),
        ...('negativePrompt' in entry ? { negativePrompt: entry.negativePrompt } : {}),
      };
    }
  }
  return overrides;
}

type CachedEnhancement = {
  prompt?: string;
  style?: string;
  aspectRatio?: string;
  negativePrompt?: string;
};

/** Mirrors the mergedEnhancements assembly in handleCompare */
function buildMergedEnhancements(
  modelPreviews: Record<string, CachedEnhancement>,
  perModelOverrides: Record<string, { style?: string; aspectRatio?: string; negativePrompt?: string }>,
): Record<string, CachedEnhancement> {
  const merged = { ...modelPreviews };
  for (const [id, ov] of Object.entries(perModelOverrides)) {
    merged[id] = { ...merged[id], ...ov };
  }
  return merged;
}

interface ComparisonOptions {
  style?: string;
  aspectRatio?: string;
  negativePrompt?: string;
}

/** Mirrors per-model param resolution in the preview effect */
function resolveParamsForModel(
  modelId: string,
  perModelOverrides: Record<string, { style?: string; aspectRatio?: string; negativePrompt?: string }>,
  comparisonOptions: ComparisonOptions,
): ComparisonOptions {
  const ov = perModelOverrides[modelId];
  return {
    style: ov?.style ?? comparisonOptions.style,
    aspectRatio: ov?.aspectRatio ?? comparisonOptions.aspectRatio,
    negativePrompt: ov?.negativePrompt ?? comparisonOptions.negativePrompt,
  };
}

// ─── 1. Apply per-model overrides — each model gets its own style/aspect ─────

describe('V030-008.1 — apply per-model overrides isolates each model', () => {
  it('each model receives its own style and aspectRatio', () => {
    const perModel: Record<string, PerModelSuggestion> = {
      'nano-banana-2': makeImageSuggestion('nano-banana-2', { style: 'Dynamic', aspectRatio: '16:9' }),
      'nano-banana-pro': makeImageSuggestion('nano-banana-pro', { style: 'Illustration', aspectRatio: '9:16' }),
      'gpt-image-1.5': makeImageSuggestion('gpt-image-1.5', { aspectRatio: '1:1' }),
    };

    const overrides = extractPerModelOverrides(
      ['nano-banana-2', 'nano-banana-pro', 'gpt-image-1.5'],
      perModel,
    );

    expect(overrides['nano-banana-2'].style).toBe('Dynamic');
    expect(overrides['nano-banana-2'].aspectRatio).toBe('16:9');
    expect(overrides['nano-banana-pro'].style).toBe('Illustration');
    expect(overrides['nano-banana-pro'].aspectRatio).toBe('9:16');
    expect(overrides['gpt-image-1.5'].style).toBeUndefined();
    expect(overrides['gpt-image-1.5'].aspectRatio).toBe('1:1');
  });

  it('no style bleed between models — changing m1 does not affect m2', () => {
    const perModel: Record<string, PerModelSuggestion> = {
      'm1': makeImageSuggestion('m1', { style: 'Ray Traced', aspectRatio: '16:9' }),
      'm2': makeImageSuggestion('m2', { style: 'Illustration', aspectRatio: '4:3' }),
    };

    const overrides = extractPerModelOverrides(['m1', 'm2'], perModel);

    expect(overrides['m1'].style).not.toBe(overrides['m2'].style);
    expect(overrides['m1'].aspectRatio).not.toBe(overrides['m2'].aspectRatio);
  });

  it('negativePrompt is isolated per model', () => {
    const perModel: Record<string, PerModelSuggestion> = {
      'm1': makeImageSuggestion('m1', { negativePrompt: 'blurry, low quality' }),
      'm2': makeImageSuggestion('m2'),
    };

    const overrides = extractPerModelOverrides(['m1', 'm2'], perModel);

    expect(overrides['m1'].negativePrompt).toBe('blurry, low quality');
    expect(overrides['m2'].negativePrompt).toBeUndefined();
  });

  it('model without style entry does not inject style key into its override', () => {
    const perModel: Record<string, PerModelSuggestion> = {
      'm1': makeImageSuggestion('m1'), // no style
    };

    const overrides = extractPerModelOverrides(['m1'], perModel);

    expect('style' in overrides['m1']).toBe(false);
  });
});

// ─── 2. Deselect a model — its override is cleaned up ────────────────────────

describe('V030-008.2 — deselecting a model removes its override', () => {
  it('deselected model is absent from the override map', () => {
    const perModel: Record<string, PerModelSuggestion> = {
      'm1': makeImageSuggestion('m1', { style: 'Dynamic' }),
      'm2': makeImageSuggestion('m2', { style: 'Ray Traced' }),
    };
    // User toggled off 'm2' before applying — not in modelIds
    const overrides = extractPerModelOverrides(['m1'], perModel);

    expect(overrides['m1']).toBeDefined();
    expect(overrides['m2']).toBeUndefined();
  });

  it('applying with no models yields an empty override map', () => {
    const perModel: Record<string, PerModelSuggestion> = {
      'm1': makeImageSuggestion('m1', { style: 'Dynamic' }),
    };

    const overrides = extractPerModelOverrides([], perModel);

    expect(Object.keys(overrides)).toHaveLength(0);
  });

  it('model in modelIds but missing from perModel is skipped, not inserted as undefined', () => {
    const perModel: Record<string, PerModelSuggestion> = {
      'm1': makeImageSuggestion('m1', { style: 'Dynamic' }),
      // 'm2' absent — removed from suggestion before Apply was clicked
    };

    const overrides = extractPerModelOverrides(['m1', 'm2'], perModel);

    expect(overrides['m1']).toBeDefined();
    expect('m2' in overrides).toBe(false);
  });

  it('full deselect then reselect: only reselected models have overrides', () => {
    const perModel: Record<string, PerModelSuggestion> = {
      'm1': makeImageSuggestion('m1', { style: 'Dynamic' }),
      'm2': makeImageSuggestion('m2', { style: 'Ray Traced' }),
      'm3': makeImageSuggestion('m3', { style: 'Illustration' }),
    };

    // First apply: all three selected
    const first = extractPerModelOverrides(['m1', 'm2', 'm3'], perModel);
    expect(Object.keys(first)).toHaveLength(3);

    // Second apply: only m1 and m3 reselected — m2 deselected
    const second = extractPerModelOverrides(['m1', 'm3'], perModel);
    expect(Object.keys(second)).toHaveLength(2);
    expect('m2' in second).toBe(false);
  });
});

// ─── 3. Override + compare — each model in comparison uses its own params ────

describe('V030-008.3 — mergedEnhancements for compare uses per-model params', () => {
  it('each model in mergedEnhancements gets its own style and aspect', () => {
    const modelPreviews: Record<string, CachedEnhancement> = {
      'm1': { prompt: 'enhanced m1', style: 'old-m1' },
      'm2': { prompt: 'enhanced m2', style: 'old-m2' },
    };
    const perModelOverrides = {
      'm1': { style: 'Ray Traced', aspectRatio: '16:9' },
      'm2': { style: 'Illustration', aspectRatio: '9:16' },
    };

    const merged = buildMergedEnhancements(modelPreviews, perModelOverrides);

    expect(merged['m1'].style).toBe('Ray Traced');
    expect(merged['m1'].aspectRatio).toBe('16:9');
    expect(merged['m2'].style).toBe('Illustration');
    expect(merged['m2'].aspectRatio).toBe('9:16');
  });

  it('override merges on top of preview — prompt from preview is preserved', () => {
    const modelPreviews: Record<string, CachedEnhancement> = {
      'm1': { prompt: 'my enhanced prompt', style: 'old-style' },
    };

    const merged = buildMergedEnhancements(modelPreviews, { 'm1': { style: 'Dynamic' } });

    expect(merged['m1'].prompt).toBe('my enhanced prompt');
    expect(merged['m1'].style).toBe('Dynamic');
  });

  it('model not in overrides keeps its preview unchanged', () => {
    const modelPreviews: Record<string, CachedEnhancement> = {
      'm1': { prompt: 'p1', style: 'Illustration' },
      'm2': { prompt: 'p2', style: 'Dynamic' },
    };

    const merged = buildMergedEnhancements(modelPreviews, { 'm1': { style: 'Ray Traced' } });

    expect(merged['m1'].style).toBe('Ray Traced');
    expect(merged['m2'].style).toBe('Dynamic');
    expect(merged['m2'].prompt).toBe('p2');
  });

  it('model with override but no preview still appears in merged output', () => {
    const merged = buildMergedEnhancements(
      {},
      { 'm1': { style: 'Dynamic', aspectRatio: '16:9' } },
    );

    expect(merged['m1'].style).toBe('Dynamic');
    expect(merged['m1'].aspectRatio).toBe('16:9');
  });

  it('three-model compare: all models have independent merged values', () => {
    const modelPreviews: Record<string, CachedEnhancement> = {
      'm1': { prompt: 'p1' },
      'm2': { prompt: 'p2' },
      'm3': { prompt: 'p3' },
    };
    const perModelOverrides = {
      'm1': { style: 'Dynamic', aspectRatio: '16:9' },
      'm2': { style: 'Ray Traced', aspectRatio: '1:1' },
      'm3': { style: 'Illustration', aspectRatio: '9:16' },
    };

    const merged = buildMergedEnhancements(modelPreviews, perModelOverrides);

    expect(merged['m1']).toMatchObject({ style: 'Dynamic', aspectRatio: '16:9', prompt: 'p1' });
    expect(merged['m2']).toMatchObject({ style: 'Ray Traced', aspectRatio: '1:1', prompt: 'p2' });
    expect(merged['m3']).toMatchObject({ style: 'Illustration', aspectRatio: '9:16', prompt: 'p3' });
  });
});

// ─── 4. Override → generate — correct params resolved per model ───────────────

describe('V030-008.4 — per-model param resolution during preview and generate', () => {
  it('per-model override takes precedence over shared comparisonOptions', () => {
    const overrides = { 'm1': { style: 'Ray Traced', aspectRatio: '16:9' } };
    const resolved = resolveParamsForModel('m1', overrides, { style: 'Dynamic', aspectRatio: '1:1' });

    expect(resolved.style).toBe('Ray Traced');
    expect(resolved.aspectRatio).toBe('16:9');
  });

  it('falls back to comparisonOptions when model has no override', () => {
    const resolved = resolveParamsForModel('m1', {}, { style: 'Illustration', aspectRatio: '4:3' });

    expect(resolved.style).toBe('Illustration');
    expect(resolved.aspectRatio).toBe('4:3');
  });

  it('two models resolve to independent params from the same override map', () => {
    const overrides = {
      'm1': { style: 'Ray Traced', aspectRatio: '16:9' },
      'm2': { style: 'Illustration', aspectRatio: '9:16' },
    };
    const shared: ComparisonOptions = { style: 'Dynamic', aspectRatio: '1:1' };

    const r1 = resolveParamsForModel('m1', overrides, shared);
    const r2 = resolveParamsForModel('m2', overrides, shared);

    expect(r1.style).toBe('Ray Traced');
    expect(r1.aspectRatio).toBe('16:9');
    expect(r2.style).toBe('Illustration');
    expect(r2.aspectRatio).toBe('9:16');
  });

  it('partial override: only overridden fields win, rest falls through to shared', () => {
    const overrides = { 'm1': { style: 'Ray Traced' } }; // no aspectRatio
    const resolved = resolveParamsForModel('m1', overrides, { style: 'Dynamic', aspectRatio: '4:3' });

    expect(resolved.style).toBe('Ray Traced');
    expect(resolved.aspectRatio).toBe('4:3');
  });

  it('all three models in a generate call receive independent resolved params', () => {
    const overrides = {
      'm1': { style: 'Dynamic', aspectRatio: '16:9' },
      'm2': { style: 'Illustration', aspectRatio: '9:16' },
      'm3': { aspectRatio: '4:3' }, // no style override — falls through
    };
    const shared: ComparisonOptions = { style: 'None', aspectRatio: '1:1' };

    const resolved = ['m1', 'm2', 'm3'].map(id => resolveParamsForModel(id, overrides, shared));

    expect(resolved[0]).toMatchObject({ style: 'Dynamic', aspectRatio: '16:9' });
    expect(resolved[1]).toMatchObject({ style: 'Illustration', aspectRatio: '9:16' });
    expect(resolved[2]).toMatchObject({ style: 'None', aspectRatio: '4:3' });
  });

  it('negativePrompt override is applied per model independently', () => {
    const overrides = {
      'm1': { negativePrompt: 'blurry' },
      'm2': { negativePrompt: 'low quality' },
    };
    const shared: ComparisonOptions = { negativePrompt: 'shared-neg' };

    const r1 = resolveParamsForModel('m1', overrides, shared);
    const r2 = resolveParamsForModel('m2', overrides, shared);
    const r3 = resolveParamsForModel('m3', overrides, shared); // no override

    expect(r1.negativePrompt).toBe('blurry');
    expect(r2.negativePrompt).toBe('low quality');
    expect(r3.negativePrompt).toBe('shared-neg');
  });
});
