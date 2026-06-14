// V030-007: suggestParameters is pure and deterministic.
// V030-008: AI variant via dependency-injected aiCall.
// V030-008-per-model: parameters are now produced PER MODEL.
// V082-PARAM-SCRIPT: pi.dev variant retired — suggestParametersAI now
// just async-wraps suggestParameters. Tests for buildAIPromptPayload /
// buildPerModelPromptPayload were removed with the helpers themselves.

import { describe, it, expect } from 'vitest';
import { suggestParameters, suggestParametersAI } from '@/lib/param-suggest';
import type { GeneratedImage, LeonardoModelConfig } from '@/types/mashup';

function makeModel(id: string, overrides?: Partial<LeonardoModelConfig>): LeonardoModelConfig {
  return {
    id,
    name: id,
    apiModelId: id,
    version: 'v2',
    supportsStyleIds: true,
    supportsQuality: false,
    supportsGuidance: true,
    maxQuantity: 4,
    aspectRatios: [{ label: '1:1', width: 1024, height: 1024 }],
    ...overrides,
  };
}

function makeSaved(
  prompt: string,
  modelId: string,
  overrides?: Partial<GeneratedImage>,
): GeneratedImage {
  return {
    id: `saved-${Math.random().toString(36).slice(2, 8)}`,
    prompt,
    url: 'https://cdn/x.jpg',
    status: 'ready',
    winner: true,
    modelInfo: { provider: 'leonardo', modelId, modelName: modelId },
    ...overrides,
  };
}

const models = [
  makeModel('nano-banana'),
  makeModel('nano-banana-2'),
  makeModel('nano-banana-pro'),
  makeModel('gpt-image-1.5'),
];

const guides: Record<string, string> = {
  'nano-banana': 'concise vivid illustration concept art',
  'nano-banana-2': 'concise vivid illustration concept art',
  'nano-banana-pro': 'photorealistic ultra detailed sharp focus 8k',
  'gpt-image-1.5': 'photorealistic text rendering complex composition',
};

const styles = [
  { name: 'Illustration', uuid: 'u1' },
  { name: '3D Render', uuid: 'u2' },
  { name: 'Pro Color Photography', uuid: '7c3f932b-a572-47cb-9b9b-f20211e63b5b' },
  { name: 'Portrait Cinematic', uuid: 'u4' },
  { name: 'Pro B&W Photography', uuid: 'u5' },
  { name: 'Fashion', uuid: 'u6' },
  { name: 'Graphic Design 2D', uuid: 'u7' },
  { name: 'Creative', uuid: 'u8' },
  { name: 'Pro Film Photography', uuid: 'u9' },
  { name: 'Ray Traced', uuid: 'u10' },
];

describe('suggestParameters', () => {
  it('emits a perModel entry for each shortlisted model', () => {
    const s = suggestParameters({
      prompt: 'photorealistic mountains',
      availableModels: models,
      modelGuides: guides,
      availableStyles: styles,
      savedImages: [],
    });
    expect(s.modelIds.length).toBeGreaterThan(0);
    for (const id of s.modelIds) {
      expect(s.perModel[id]).toBeDefined();
      expect(s.perModel[id].modelId).toBe(id);
    }
  });

  it('per-model image entry carries width/height/imageSize/promptEnhance', () => {
    const s = suggestParameters({
      prompt: 'photorealistic mountains',
      availableModels: [makeModel('gpt-image-1.5')],
      modelGuides: { 'gpt-image-1.5': 'photorealistic mountains' },
      availableStyles: styles,
      savedImages: [],
    });
    const entry = s.perModel['gpt-image-1.5'];
    expect(entry.type).toBe('image');
    if (entry.type !== 'image') return;
    expect(entry.width).toBe(1024);
    expect(entry.height).toBe(1024);
    expect(entry.imageSize).toBe('1K');
    expect(entry.promptEnhance).toBe('ON');
    // gpt-image-1.5 spec pins quality to HIGH regardless of detailHit
    // (see lib/model-specs/gpt-image-1.5.json: "quality must always be HIGH").
    expect(entry.quality).toBe('HIGH');
  });

  it('per-model image entry bumps to 2K + HIGH quality on detail keywords', () => {
    const s = suggestParameters({
      prompt: 'ultra detailed 8k photorealistic spaceship',
      availableModels: [makeModel('gpt-image-1.5')],
      modelGuides: { 'gpt-image-1.5': 'photorealistic detailed' },
      availableStyles: styles,
      savedImages: [],
    });
    const entry = s.perModel['gpt-image-1.5'];
    if (entry.type !== 'image') throw new Error('expected image');
    expect(entry.imageSize).toBe('2K');
    expect(entry.quality).toBe('HIGH');
  });

  it('per-model image entry omits quality when model lacks the knob', () => {
    const s = suggestParameters({
      prompt: 'anime scene',
      availableModels: [makeModel('nano-banana-2')],
      modelGuides: { 'nano-banana-2': 'illustration anime' },
      availableStyles: styles,
      savedImages: [],
    });
    const entry = s.perModel['nano-banana-2'];
    if (entry.type !== 'image') throw new Error('expected image');
    expect(entry.quality).toBeUndefined();
  });

  it('per-model image entry only sets style when model supports style_ids', () => {
    const s = suggestParameters({
      prompt: 'anime scene',
      availableModels: [makeModel('nano-banana-2'), makeModel('gpt-image-1.5')],
      modelGuides: {
        'nano-banana-2': 'illustration anime',
        'gpt-image-1.5': 'illustration anime',
      },
      availableStyles: styles,
      savedImages: [],
      topN: 2,
    });
    const nano = s.perModel['nano-banana-2'];
    const gpt = s.perModel['gpt-image-1.5'];
    if (nano.type !== 'image' || gpt.type !== 'image') throw new Error('expected image');
    expect(nano.style).toBe('Illustration'); // nano-banana-2 supports style_ids
    expect(gpt.style).toBeUndefined();        // gpt-image-1.5 does not
  });

  it('clamps aspect ratio to 1:1 when model only supports 1024x1024', () => {
    const s = suggestParameters({
      prompt: 'sweeping cityscape panorama 16:9',
      availableModels: [makeModel('gpt-image-1.5')],
      modelGuides: { 'gpt-image-1.5': 'cityscape panorama' },
      availableStyles: styles,
      savedImages: [],
    });
    const entry = s.perModel['gpt-image-1.5'];
    if (entry.type !== 'image') throw new Error('expected image');
    expect(entry.aspectRatio).toBe('1:1');
  });

  it('excludes nano-banana legacy from the shortlist by default', () => {
    const s = suggestParameters({
      prompt: 'anything',
      availableModels: models,
      modelGuides: guides,
      availableStyles: styles,
      savedImages: [],
    });
    expect(s.modelIds).not.toContain('nano-banana');
    expect(s.perModel['nano-banana']).toBeUndefined();
  });

  it('force-includes user-selected models even when they score low', () => {
    // prompt screams "anime" → nano-banana-2 is the top pick; gpt-image-1.5
    // scores zero on this prompt. Without includedModelIds it'd be dropped.
    const s = suggestParameters({
      prompt: 'anime scene cel shaded',
      availableModels: models,
      modelGuides: guides,
      availableStyles: styles,
      savedImages: [],
      includedModelIds: ['gpt-image-1.5'],
    });
    expect(s.modelIds).toContain('gpt-image-1.5');
    expect(s.perModel['gpt-image-1.5']).toBeDefined();
  });

  it('ignores excluded ids passed in as forced includes', () => {
    // nano-banana is in excludedModelIds by default; forcing it shouldn't
    // bypass the exclusion contract.
    const s = suggestParameters({
      prompt: 'anime scene',
      availableModels: models,
      modelGuides: guides,
      availableStyles: styles,
      savedImages: [],
      includedModelIds: ['nano-banana'],
    });
    expect(s.modelIds).not.toContain('nano-banana');
  });

  it('keeps both top-ranked and forced models when topN budget covers them', () => {
    const s = suggestParameters({
      prompt: 'anime scene',
      availableModels: models,
      modelGuides: guides,
      availableStyles: styles,
      savedImages: [],
      topN: 2,
      includedModelIds: ['gpt-image-1.5'],
    });
    // Expect at least the forced model + 1 top-scored model.
    expect(s.modelIds).toContain('gpt-image-1.5');
    expect(s.modelIds.length).toBeGreaterThanOrEqual(2);
    // All ids should be unique.
    expect(new Set(s.modelIds).size).toBe(s.modelIds.length);
  });

  it('honors a custom topN', () => {
    const s = suggestParameters({
      prompt: 'photorealistic mountains',
      availableModels: models,
      modelGuides: guides,
      availableStyles: styles,
      savedImages: [],
      topN: 3,
    });
    expect(s.modelIds.length).toBe(3);
    expect(Object.keys(s.perModel).length).toBe(3);
  });

  it('boosts models that won on similar prior prompts', () => {
    const saved = [
      makeSaved('photorealistic mountains at golden hour', 'gpt-image-1.5'),
      makeSaved('photorealistic mountains at golden hour', 'gpt-image-1.5'),
      makeSaved('photorealistic mountains at golden hour', 'gpt-image-1.5'),
    ];
    const s = suggestParameters({
      prompt: 'photorealistic mountains at sunrise',
      availableModels: models,
      modelGuides: guides,
      availableStyles: styles,
      savedImages: saved,
    });
    expect(s.modelIds[0]).toBe('gpt-image-1.5');
    expect(s.priorMatchCount).toBeGreaterThan(0);
  });

  it('carries over a negative prompt from prior winner into per-model entries', () => {
    const saved = [
      makeSaved('photorealistic mountains', 'gpt-image-1.5', {
        negativePrompt: 'blurry, low-res, watermark',
      }),
    ];
    const s = suggestParameters({
      prompt: 'photorealistic mountains at dawn',
      availableModels: models,
      modelGuides: guides,
      availableStyles: styles,
      savedImages: saved,
    });
    const entry = s.perModel[s.modelIds[0]];
    if (entry.type !== 'image') throw new Error('expected image');
    expect(entry.negativePrompt).toBe('blurry, low-res, watermark');
  });

  it('handles empty prompts without throwing', () => {
    const s = suggestParameters({
      prompt: '',
      availableModels: models,
      modelGuides: guides,
      availableStyles: styles,
      savedImages: [],
    });
    expect(s.modelIds.length).toBeGreaterThan(0);
    expect(Object.keys(s.perModel).length).toBeGreaterThan(0);
  });

  it('V085-MODEL-STYLE-DIVERSITY: sibling models drawing from the same style pool get distinct styles', () => {
    // nano-banana-2 and nano-banana-pro both share LEONARDO_SHARED_STYLES.
    // Pre-V085, both would receive 'Illustration' for an anime prompt,
    // making A/B comparisons pointless. The diversity rule walks the
    // ranked candidates list and assigns each sibling a different style.
    const s = suggestParameters({
      prompt: 'anime illustration of a samurai',
      availableModels: [makeModel('nano-banana-2'), makeModel('nano-banana-pro')],
      modelGuides: {
        'nano-banana-2': 'illustration anime',
        'nano-banana-pro': 'illustration anime',
      },
      availableStyles: styles,
      savedImages: [],
    });
    const a = s.perModel['nano-banana-2'];
    const b = s.perModel['nano-banana-pro'];
    if (a.type !== 'image' || b.type !== 'image') throw new Error('expected image');
    expect(a.style).toBeDefined();
    expect(b.style).toBeDefined();
    expect(a.style).not.toBe(b.style);
    // Both picks must come from the ranked candidate list for "anime".
    expect(['Illustration', 'Graphic Design 2D', 'Creative']).toContain(a.style);
    expect(['Illustration', 'Graphic Design 2D', 'Creative']).toContain(b.style);
  });

  it('RAY-TRACED-FIX (IMG-INVEST-001 issue 5): explicit raytrace keyword surfaces Ray Traced', () => {
    // Pre-fix: the STYLE_RULES loop broke on first match, so any
    // prompt that also mentioned a more common cue (e.g. "illustration"
    // / "photograph") prevented the 3D/Ray-Traced rule from ever being
    // evaluated. Even when the 3D rule did match, Ray Traced was 2nd in
    // its list and the diversity walker preferred the 1st pick. The
    // dedicated raytrace rule lifts Ray Traced to the top slot when
    // the user spells out their intent.
    const s = suggestParameters({
      prompt: 'raytraced cyberpunk samurai with realistic lighting',
      availableModels: [makeModel('nano-banana-2')],
      modelGuides: { 'nano-banana-2': 'photoreal ray traced render' },
      availableStyles: styles,
      savedImages: [],
    });
    const entry = s.perModel['nano-banana-2'];
    if (entry.type !== 'image') throw new Error('expected image');
    expect(entry.style).toBe('Ray Traced');
  });

  it('RAY-TRACED-FIX: accumulates style candidates across all matching rules (no first-match break)', () => {
    // Prompt mentions both an "illustration" cue (rule #3) and a
    // "ray traced" cue (rule #4). With accumulation + interleaving,
    // both rules contribute to the candidate list. With sibling models
    // drawing from a shared pool, one model picks Illustration and the
    // other picks Ray Traced — neither rule's candidate is blocked
    // by the other rule firing first.
    const s = suggestParameters({
      prompt: 'illustration of a samurai with ray traced lighting',
      availableModels: [makeModel('nano-banana-2'), makeModel('nano-banana-pro')],
      modelGuides: {
        'nano-banana-2': 'illustration sharp focus',
        'nano-banana-pro': 'ray traced photoreal',
      },
      availableStyles: styles,
      savedImages: [],
    });
    const a = s.perModel['nano-banana-2'];
    const b = s.perModel['nano-banana-pro'];
    if (a.type !== 'image' || b.type !== 'image') throw new Error('expected image');
    const picks = new Set([a.style, b.style]);
    // Both rules' top picks (Illustration AND Ray Traced) should be in
    // the interleaved candidate set — sibling diversity assigns each
    // model a distinct one.
    expect(picks.has('Illustration') || picks.has('Ray Traced')).toBe(true);
    expect(picks.size).toBe(2);
  });

  it('V085-MODEL-STYLE-DIVERSITY: when only one candidate style is available, second sibling gets undefined', () => {
    // Only Illustration is in the available pool — Graphic Design 2D and
    // Creative are not. Sibling cannot find a non-colliding alternative
    // and so receives no style rather than duplicating.
    const limitedStyles = [{ name: 'Illustration', uuid: 'u1' }];
    const s = suggestParameters({
      prompt: 'anime scene',
      availableModels: [makeModel('nano-banana-2'), makeModel('nano-banana-pro')],
      modelGuides: {
        'nano-banana-2': 'illustration anime',
        'nano-banana-pro': 'illustration anime',
      },
      availableStyles: limitedStyles,
      savedImages: [],
    });
    const entries = [s.perModel['nano-banana-2'], s.perModel['nano-banana-pro']];
    const withStyle = entries.filter(e => e.type === 'image' && e.style).length;
    const withoutStyle = entries.filter(e => e.type === 'image' && !e.style).length;
    expect(withStyle).toBe(1);
    expect(withoutStyle).toBe(1);
  });

  it('produces a video per-model entry when a video model is in the shortlist', () => {
    const s = suggestParameters({
      prompt: 'a vertical reel of a dancer',
      availableModels: [makeModel('kling-3.0', { supportsStyleIds: false })],
      modelGuides: { 'kling-3.0': 'video reel motion dancer' },
      availableStyles: styles,
      savedImages: [],
    });
    const entry = s.perModel['kling-3.0'];
    expect(entry.type).toBe('video');
    if (entry.type !== 'video') return;
    expect(entry.aspectRatio).toBe('9:16');
    expect(entry.width).toBe(1080);
    expect(entry.height).toBe(1920);
    expect(entry.duration).toBeGreaterThan(0);
    expect(entry.mode).toMatch(/RESOLUTION_/);
  });
});

describe('suggestParameters provider filter (P2 of PROV-AGNOSTIC-PARAMS)', () => {
  // Mixed pool: 4 Leonardo + 1 MiniMax image model.
  const mixedModels = [
    ...models,
    makeModel('minimax-image-01', { provider: 'minimax', apiModelId: 'image-01', version: 'v1' }),
  ];
  const mixedGuides: Record<string, string> = {
    ...guides,
    'minimax-image-01': 'minimax native image generation',
  };

  it('with no provider filter, every eligible model survives', () => {
    const s = suggestParameters({
      prompt: 'photorealistic mountains',
      availableModels: mixedModels,
      modelGuides: mixedGuides,
      availableStyles: styles,
      savedImages: [],
    });
    // nano-banana is excluded by default; the other 4 should all be present.
    expect(s.modelIds).toContain('nano-banana-2');
    expect(s.modelIds).toContain('nano-banana-pro');
    expect(s.modelIds).toContain('gpt-image-1.5');
    expect(s.modelIds).toContain('minimax-image-01');
  });

  it('provider=leonardo drops minimax-image-01 from the pool', () => {
    const s = suggestParameters({
      prompt: 'photorealistic mountains',
      availableModels: mixedModels,
      modelGuides: mixedGuides,
      availableStyles: styles,
      savedImages: [],
      provider: 'leonardo',
    });
    expect(s.modelIds).not.toContain('minimax-image-01');
    expect(s.modelIds).toContain('nano-banana-2');
    expect(s.modelIds).toContain('nano-banana-pro');
    expect(s.modelIds).toContain('gpt-image-1.5');
    // perModel is a Record — its keys mirror modelIds.
    expect(s.perModel['minimax-image-01']).toBeUndefined();
  });

  it('provider=minimax keeps only minimax-image-01', () => {
    const s = suggestParameters({
      prompt: 'photorealistic mountains',
      availableModels: mixedModels,
      modelGuides: mixedGuides,
      availableStyles: styles,
      savedImages: [],
      provider: 'minimax',
    });
    expect(s.modelIds).toEqual(['minimax-image-01']);
    expect(Object.keys(s.perModel)).toEqual(['minimax-image-01']);
  });

  it('treats absent provider on a model as leonardo (back-compat)', () => {
    // nano-banana-2 has no `provider` field — every pre-MXIMG-001 model is
    // implicitly Leonardo, which the filter must honour.
    const s = suggestParameters({
      prompt: 'photorealistic mountains',
      availableModels: mixedModels,
      modelGuides: mixedGuides,
      availableStyles: styles,
      savedImages: [],
      provider: 'leonardo',
    });
    expect(s.modelIds).toContain('nano-banana-2');
  });

  it('provider with no matching models returns an empty pool', () => {
    const s = suggestParameters({
      prompt: 'photorealistic mountains',
      availableModels: mixedModels,
      modelGuides: mixedGuides,
      availableStyles: styles,
      savedImages: [],
      provider: 'openai',
    });
    expect(s.modelIds).toEqual([]);
    expect(s.perModel).toEqual({});
  });
});

describe('suggestParametersAI', () => {
  const baseInput = {
    prompt: 'photorealistic mountains at dawn',
    availableModels: models,
    modelGuides: guides,
    availableStyles: styles,
    savedImages: [] as GeneratedImage[],
  };

  it('returns the same shape as suggestParameters when no aiCall provided', async () => {
    const sync = suggestParameters(baseInput);
    const async_ = await suggestParametersAI(baseInput);
    expect(async_.modelIds).toEqual(sync.modelIds);
    expect(async_.source).toBe('rules');
    expect(Object.keys(async_.perModel)).toEqual(Object.keys(sync.perModel));
  });

  it('falls back to rule engine when aiCall is omitted (no network)', async () => {
    let aiCalled = false;
    const s = await suggestParametersAI(baseInput, {
      // No aiCall — should never reach this fallback even if defined
      fallback: (input) => {
        // Use suggestParameters but verify no AI was invoked above us
        return suggestParameters(input);
      },
    });
    expect(aiCalled).toBe(false);
    expect(s.source).toBe('rules');
  });

  it('AI-PARAM-SUGGEST: invokes aiCall when provided', async () => {
    let aiCalled = false;
    let capturedPrompt = '';
    await suggestParametersAI(baseInput, {
      aiCall: async (msg) => {
        aiCalled = true;
        capturedPrompt = msg;
        return '{}'; // Empty JSON → falls back to rules
      },
    });
    expect(aiCalled).toBe(true);
    expect(capturedPrompt).toContain('Model capabilities');
    expect(capturedPrompt).toContain(baseInput.prompt);
  });

  it('PARAM-TRENDING: forwards trendingContext into the AI prompt verbatim', async () => {
    // The pipeline already fetches a Reddit + SearXNG blurb via
    // fetchTrendingContext; without this wiring it was being discarded
    // before reaching the AI parameter picker, so style / aspect picks
    // ignored real-world trend signal.
    let capturedPrompt = '';
    const trendingBlurb = 'Cyberpunk neon aesthetic spiking on r/cyberpunk this week';
    await suggestParametersAI(
      { ...baseInput, trendingContext: trendingBlurb },
      {
        aiCall: async (msg) => {
          capturedPrompt = msg;
          return '{}';
        },
      },
    );
    expect(capturedPrompt).toContain('Trending context');
    expect(capturedPrompt).toContain(trendingBlurb);
  });

  it('PARAM-TRENDING: emits "(none available)" placeholder when trendingContext is missing', async () => {
    let capturedPrompt = '';
    await suggestParametersAI(baseInput, {
      aiCall: async (msg) => {
        capturedPrompt = msg;
        return '{}';
      },
    });
    expect(capturedPrompt).toContain('Trending context');
    expect(capturedPrompt).toContain('(none available)');
  });

  it('AI-PARAM-SUGGEST: silently falls back to rules when aiCall throws', async () => {
    const s = await suggestParametersAI(baseInput, {
      aiCall: async () => {
        throw new Error('network down');
      },
    });
    expect(s.source).toBe('rules');
  });

  it('AI-PARAM-SUGGEST: silently falls back to rules on unparseable JSON', async () => {
    const s = await suggestParametersAI(baseInput, {
      aiCall: async () => 'not JSON at all — completely garbage',
    });
    expect(s.source).toBe('rules');
  });

  it('AI-PARAM-SUGGEST: applies AI overrides when response is well-formed', async () => {
    const s = await suggestParametersAI(baseInput, {
      aiCall: async () =>
        JSON.stringify({
          perModel: {
            'nano-banana-2': {
              aspectRatio: '16:9',
              imageSize: '2K',
              promptEnhance: 'OFF',
              style: 'Pro Color Photography',
              reason: 'wide landscape, photoreal',
            },
          },
          overall: 'cinematic landscape strategy',
        }),
    });
    const entry = s.perModel['nano-banana-2'];
    if (entry?.type !== 'image') throw new Error('expected image entry');
    expect(entry.aspectRatio).toBe('16:9');
    expect(entry.imageSize).toBe('2K');
    expect(entry.promptEnhance).toBe('OFF');
    expect(entry.style).toBe('Pro Color Photography');
    expect(entry.reason).toContain('photoreal');
    expect(entry.source).toBe('ai');
  });

  it('AI-PARAM-SUGGEST: capability filter STRIPS style for gpt-image-1.5 even if AI hallucinates one', async () => {
    // This is the exact V082 failure mode — AI proposes a style for a
    // model that has no style parameter. The post-filter must drop it.
    const s = await suggestParametersAI({ ...baseInput, includedModelIds: ['gpt-image-1.5'] }, {
      aiCall: async () =>
        JSON.stringify({
          perModel: {
            'gpt-image-1.5': {
              aspectRatio: '1:1',
              style: 'Pro Color Photography', // ← hallucinated; not supported
              reason: 'photoreal',
            },
          },
        }),
    });
    const entry = s.perModel['gpt-image-1.5'];
    if (entry?.type !== 'image') throw new Error('expected image entry');
    expect(entry.style).toBeUndefined();
  });

  it('AI-PARAM-SUGGEST: capability filter STRIPS negativePrompt for gpt-image-1.5', async () => {
    const s = await suggestParametersAI({ ...baseInput, includedModelIds: ['gpt-image-1.5'] }, {
      aiCall: async () =>
        JSON.stringify({
          perModel: {
            'gpt-image-1.5': {
              negativePrompt: 'blurry, low-res', // ← hallucinated; not supported
            },
          },
        }),
    });
    const entry = s.perModel['gpt-image-1.5'];
    if (entry?.type !== 'image') throw new Error('expected image entry');
    expect(entry.negativePrompt).toBeUndefined();
  });

  it('AI-PARAM-SUGGEST: capability filter STRIPS unknown style for a style-supporting model', async () => {
    const s = await suggestParametersAI(baseInput, {
      aiCall: async () =>
        JSON.stringify({
          perModel: {
            'nano-banana-2': {
              style: 'Definitely Not A Real Style Name', // ← unknown; available styles are limited
            },
          },
        }),
    });
    const entry = s.perModel['nano-banana-2'];
    if (entry?.type !== 'image') throw new Error('expected image entry');
    // Either the original baseline style or undefined — never the hallucinated value.
    expect(entry.style).not.toBe('Definitely Not A Real Style Name');
  });

  it('AI-PARAM-SUGGEST: capability filter REJECTS aspect ratio outside the allowed set', async () => {
    const baseline = suggestParameters(baseInput);
    const baselineAspect = baseline.perModel['nano-banana-2']?.aspectRatio;
    const s = await suggestParametersAI(baseInput, {
      aiCall: async () =>
        JSON.stringify({
          perModel: {
            'nano-banana-2': {
              aspectRatio: '42:1', // garbage
            },
          },
        }),
    });
    const entry = s.perModel['nano-banana-2'];
    if (entry?.type !== 'image') throw new Error('expected image entry');
    expect(entry.aspectRatio).toBe(baselineAspect);
  });

  it('honors a fallback override', async () => {
    let fallbackCalled = false;
    const fakeFallback = (input: typeof baseInput): ReturnType<typeof suggestParameters> => {
      fallbackCalled = true;
      return suggestParameters(input);
    };
    await suggestParametersAI(baseInput, { fallback: fakeFallback });
    expect(fallbackCalled).toBe(true);
  });

  it('never sets style for gpt-image-1.5 even when a style cue is present', async () => {
    const s = await suggestParametersAI({
      prompt: 'cinematic dramatic photoreal mountain',
      availableModels: [makeModel('gpt-image-1.5')],
      modelGuides: { 'gpt-image-1.5': 'photorealistic cinematic' },
      availableStyles: styles,
      savedImages: [],
    });
    const entry = s.perModel['gpt-image-1.5'];
    if (entry.type !== 'image') throw new Error('expected image');
    expect(entry.style).toBeUndefined();
  });

  it('keeps user-selected models in the shortlist instead of auto-deactivating them', async () => {
    // Default topN bumped to 99 in V082, so all eligible models survive
    // the ranking pass — nothing the user selected gets silently dropped.
    const s = await suggestParametersAI({
      prompt: 'anime scene',
      availableModels: models,
      modelGuides: guides,
      availableStyles: styles,
      savedImages: [],
    });
    // All non-excluded models should appear.
    expect(s.modelIds).toContain('gpt-image-1.5');
    expect(s.modelIds).toContain('nano-banana-2');
    expect(s.modelIds).toContain('nano-banana-pro');
    expect(s.modelIds).not.toContain('nano-banana');
  });
});
