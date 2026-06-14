/**
 * V082: text-model catalog tests.
 *
 * The catalog (lib/text-model-catalog.ts) is the single source of truth
 * for every text model the app knows how to call via the Vercel AI
 * SDK. 4NE-20: MiniMax-only. Tests cover the four contract surfaces:
 *   1. defaults + mode-override merging (mode override wins when set)
 *   2. unknown models return an empty object (safe-to-spread contract)
 *   3. provider-bucketing helper returns only matching entries
 *   4. alias resolution (historical IDs like `M2.7-highspeed` → canonical
 *      `MiniMax-M2.7-highspeed`) keeps persisted user selections working
 *
 * Also pinned: the catalog contains the expected 5 MiniMax entries
 * (M2, M2.5, M2.7, M2.7-highspeed, M3). Adding a new model is a
 * one-line addition to TEXT_MODEL_CATALOG; if this test starts
 * failing after a model add, update the count below in lock-step.
 */

import { describe, it, expect } from 'vitest';
import {
  TEXT_MODEL_CATALOG,
  getTextModelCatalogEntry,
  getTextModelParams,
  getAllTextCatalogEntries,
  getTextCatalogByProvider,
  getDefaultTextModelForProvider,
  getAvailableTextModels,
  resolveTextModel,
} from '@/lib/text-model-catalog';

describe('text-model-catalog V082', () => {
  it('ships MiniMax text models only (4NE-20)', () => {
    const minimax = getTextCatalogByProvider('minimax');
    expect(minimax.length).toBeGreaterThanOrEqual(3);

    // 4NE-20: OpenAI was removed; it returns no text models now.
    expect(getTextCatalogByProvider('openai')).toEqual([]);

    // The two earlier-dropped providers return no text models.
    expect(getTextCatalogByProvider('anthropic')).toEqual([]);
    expect(getTextCatalogByProvider('openrouter')).toEqual([]);

    // leonardo has no text models — must not accidentally pick up
    // image specs from the parallel lib/model-specs registry.
    expect(getTextCatalogByProvider('leonardo')).toEqual([]);
  });

  it('catalog has the expected model count and structure', () => {
    // 4NE-20: 5 MiniMax variants (M2, M2.5, M2.7, M2.7-highspeed, M3).
    // Adding a new model is a one-line addition; bump this count in
    // lock-step.
    const all = getAllTextCatalogEntries();
    expect(all.length).toBe(5);
    expect(all.every((m) => m.provider === 'minimax')).toBe(true);

    for (const s of all) {
      expect(s.modelId).toBeTruthy();
      expect(s.provider).toBeTruthy();
      expect(s.defaults).toBeDefined();
      expect(s.contextWindow).toBeGreaterThan(0);
      expect(s.defaultMaxTokens).toBeGreaterThan(0);
      expect(s.recommendedFor.length).toBeGreaterThan(0);
    }
  });

  it('getTextModelCatalogEntry returns the full record for known ids', () => {
    const m25 = getTextModelCatalogEntry('MiniMax-M2.5');
    expect(m25).toBeDefined();
    expect(m25?.provider).toBe('minimax');
    expect(m25?.defaults.temperature).toBe(0.8);
    expect(m25?.defaults.maxTokens).toBe(4096);

    const m27 = getTextModelCatalogEntry('MiniMax-M2.7');
    expect(m27?.defaults.temperature).toBe(0.7);
    expect(m27?.defaults.maxTokens).toBe(8192);

    // The new M3 entry is the default for new installs.
    const m3 = getTextModelCatalogEntry('MiniMax-M3');
    expect(m3?.isDefault).toBe(true);
    expect(m3?.defaults.temperature).toBe(0.7);
    expect(m3?.defaults.maxTokens).toBe(16_384);

    expect(getTextModelCatalogEntry('not-a-real-model')).toBeUndefined();
  });

  it('resolveTextModel handles legacy alias forms', () => {
    // Pre-v082 settings may have stored `M2.7-highspeed` (no `MiniMax-`
    // prefix). The resolver should normalise to the canonical form.
    const alias = resolveTextModel('M2.7-highspeed');
    expect(alias).toBeDefined();
    expect(alias?.modelId).toBe('MiniMax-M2.7-highspeed');

    // Canonical IDs work too.
    expect(resolveTextModel('MiniMax-M3')?.modelId).toBe('MiniMax-M3');

    // Unknown IDs return undefined.
    expect(resolveTextModel('totally-fake-model')).toBeUndefined();
  });

  it('getTextModelParams without mode returns the model defaults', () => {
    const params = getTextModelParams('MiniMax-M2.5');
    expect(params.temperature).toBe(0.8);
    expect(params.maxTokens).toBe(4096);
  });

  it('mode override wins over the default temperature', () => {
    // idea → 0.95 from SHARED_MODE_OVERRIDES; defaults are 0.8
    const idea = getTextModelParams('MiniMax-M2.5', 'idea');
    expect(idea.temperature).toBe(0.95);
    // maxTokens is NOT overridden per-mode, so the default leaks through
    expect(idea.maxTokens).toBe(4096);

    // tag → 0.3, structured short output
    const tag = getTextModelParams('MiniMax-M2.5', 'tag');
    expect(tag.temperature).toBe(0.3);
    expect(tag.maxTokens).toBe(4096);
  });

  it('mode override is consistent across models with the shared profile', () => {
    // Every shipped model uses SHARED_MODE_OVERRIDES → same temperature
    // per mode, only the maxTokens default differs per generation.
    for (const modelId of ['MiniMax-M2.5', 'MiniMax-M2.7', 'MiniMax-M3']) {
      expect(getTextModelParams(modelId, 'idea').temperature).toBe(0.95);
      expect(getTextModelParams(modelId, 'tag').temperature).toBe(0.3);
      expect(getTextModelParams(modelId, 'enhance').temperature).toBe(0.5);
    }
  });

  it('getTextModelParams returns an empty object for unknown models — safe to spread', () => {
    const params = getTextModelParams('totally-fake-model', 'idea');
    expect(params).toEqual({});
    // Spread into a request body must be a no-op.
    const body = { model: 'totally-fake-model', stream: true, ...params };
    expect(body).toEqual({ model: 'totally-fake-model', stream: true });
  });

  it('unknown mode falls back to model defaults (no crash)', () => {
    const params = getTextModelParams(
      'MiniMax-M2.5',
      'some-future-mode-not-in-overrides' as unknown as 'chat',
    );
    expect(params.temperature).toBe(0.8); // default leaks through
    expect(params.maxTokens).toBe(4096);
  });

  it('getDefaultTextModelForProvider returns the flagged default', () => {
    expect(getDefaultTextModelForProvider('minimax')).toBe('MiniMax-M3');
    // 4NE-20: OpenAI has no catalog entries, so no default.
    expect(getDefaultTextModelForProvider('openai')).toBeUndefined();
  });

  it('exactly one default for the MiniMax provider is flagged', () => {
    const minimax = TEXT_MODEL_CATALOG.filter((m) => m.provider === 'minimax');
    expect(minimax.filter((m) => m.isDefault).length).toBe(1);
  });

  it('getAvailableTextModels marks models available/unavailable per env', () => {
    const all = getAvailableTextModels({ minimax: true });
    expect(all.every((m) => m.available)).toBe(true);

    const none = getAvailableTextModels({ minimax: false });
    expect(none.every((m) => !m.available)).toBe(true);
  });
});
