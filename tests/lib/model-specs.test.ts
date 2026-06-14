/**
 * P1 of PROV-AGNOSTIC-PARAMS: every model spec carries a `provider`
 * field, `getModelProvider` resolves it (with a documented Leonardo
 * fallback for older shipped JSON), and `getModelSpecsByProvider`
 * filters cleanly. The image-only `minimax-image-01` spec — added to
 * close the gap discovered during MXIMG-001 — is the first
 * non-Leonardo image provider in the registry.
 *
 * See `docs/bmad/briefs/PROV-AGNOSTIC-PARAMS.md` for the rollout plan.
 */
import { describe, it, expect } from 'vitest';
import {
  getAllModelSpecs,
  getModelSpec,
  getModelProvider,
  getModelSpecsByProvider,
  type ModelSpec,
  type ModelSpecProvider,
} from '@/lib/model-specs';

describe('model-specs P1 — provider tagging', () => {
  it('every shipped spec declares a provider', () => {
    const all = getAllModelSpecs();
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(9);
    for (const [modelId, spec] of Object.entries(all)) {
      expect(spec.provider, `${modelId} missing provider`).toBeDefined();
    }
  });

  it('all 8 pre-MXIMG-001 image/video specs are tagged as leonardo', () => {
    const expectedLeonardo = [
      'gpt-image-1.5',
      'gpt-image-2',
      'nano-banana-2',
      'nano-banana-pro',
      'kling-3.0',
      'kling-o3',
      'veo-3.1',
      'seedance-2.0',
    ];
    for (const id of expectedLeonardo) {
      const spec = getModelSpec(id);
      expect(spec, `${id} spec missing`).toBeDefined();
      expect(spec?.provider).toBe('leonardo');
    }
  });

  it('minimax-image-01 spec exists and is tagged minimax', () => {
    const spec = getModelSpec('minimax-image-01');
    expect(spec).toBeDefined();
    expect(spec?.provider).toBe('minimax');
    expect(spec?.type).toBe('image');
    expect(spec?.apiName).toBe('image-01');
    // Capability shape matches what /api/minimax-image actually supports.
    expect(spec?.capabilities.styles).toBe(false);
    expect(spec?.capabilities.negativePrompt).toBe(false);
    expect(spec?.capabilities.seed).toBe(true);
  });

  it('getModelProvider returns the explicit field for tagged specs', () => {
    expect(getModelProvider('nano-banana-pro')).toBe('leonardo');
    expect(getModelProvider('minimax-image-01')).toBe('minimax');
  });

  it('getModelProvider falls back to leonardo for unknown models (back-compat)', () => {
    // Unknown / future model id with no spec — fallback documented in
    // the doc-block, exercised here so the contract is enforced.
    expect(getModelProvider('totally-not-a-real-model')).toBe('leonardo');
  });

  it('getModelSpecsByProvider returns only matching specs', () => {
    const leonardo = getModelSpecsByProvider('leonardo');
    expect(leonardo.length).toBe(8);
    for (const s of leonardo) {
      expect(s.provider).toBe('leonardo');
    }

    const minimax = getModelSpecsByProvider('minimax');
    expect(minimax.length).toBe(1);
    expect(minimax[0]?.modelId).toBe('minimax-image-01');

    // Provider with no specs yet — must return an empty array, not throw.
    const openai = getModelSpecsByProvider('openai' as ModelSpecProvider);
    expect(openai).toEqual([]);
  });

  it('every shipped spec has the structural fields the engine needs', () => {
    // Smoke that the JSON-shape contract didn't drift during the
    // provider-tagging migration — every file should still satisfy
    // ModelSpec when cast through the registry.
    const all = getAllModelSpecs();
    for (const [modelId, spec] of Object.entries(all) as Array<[string, ModelSpec]>) {
      expect(spec.modelId, `${modelId} modelId`).toBeTruthy();
      expect(spec.apiName, `${modelId} apiName`).toBeTruthy();
      expect(['image', 'video']).toContain(spec.type);
      expect(spec.endpoint, `${modelId} endpoint`).toBeTruthy();
      expect(spec.capabilities, `${modelId} capabilities`).toBeDefined();
      expect(Array.isArray(spec.rules), `${modelId} rules`).toBe(true);
    }
  });
});
