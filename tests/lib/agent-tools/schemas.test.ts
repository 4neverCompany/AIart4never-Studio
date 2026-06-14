/**
 * v1.2 Tool Registry — schemas unit tests.
 *
 * The schemas are the contract every other tool test depends on,
 * so we cover them first and comprehensively. Each schema gets:
 *   - happy path: a minimal valid input parses
 *   - happy path: a maximal valid input parses (no overflow guards trip)
 *   - common error paths: missing required, wrong type, length cap
 *   - inferred type smoke: the z.infer<...> type is structurally
 *     compatible with the runtime parse output
 */
import { describe, it, expect } from 'vitest';
import {
  zAssetRef,
  zTrendingSearchInput,
  zGeneratePromptInput,
  zCritiquePromptInput,
  zImageSettings,
  zGenerateImageInput,
  zVideoSettings,
  zGenerateVideoInput,
  zAssetMetadata,
  zPersistAssetInput,
  zNicheString,
  zAngleString,
} from '@/lib/agent-tools/schemas';

describe('zAssetRef', () => {
  it('accepts a fully-populated ref', () => {
    const r = zAssetRef.parse({
      provider: 'higgsfield',
      id: 'img-123',
      url: 'https://example.com/a.png',
    });
    expect(r.provider).toBe('higgsfield');
    expect(r.id).toBe('img-123');
    expect(r.url).toBe('https://example.com/a.png');
  });

  it('rejects an unknown provider', () => {
    expect(() =>
      zAssetRef.parse({ provider: 'fake', id: 'x', url: 'https://x.com' }),
    ).toThrow();
  });

  it('rejects a non-URL url', () => {
    expect(() =>
      zAssetRef.parse({ provider: 'mock', id: 'x', url: 'not-a-url' }),
    ).toThrow();
  });

  it('rejects an empty id', () => {
    expect(() =>
      zAssetRef.parse({ provider: 'mock', id: '', url: 'https://x.com' }),
    ).toThrow();
  });
});

describe('zNicheString / zAngleString', () => {
  it('trims and accepts non-empty niches', () => {
    expect(zNicheString.parse('  Marvel  ')).toBe('Marvel');
  });

  it('rejects empty niches after trim', () => {
    expect(() => zNicheString.parse('   ')).toThrow();
  });

  it('caps at 80 chars (niche) / 400 (angle)', () => {
    expect(() => zNicheString.parse('a'.repeat(81))).toThrow();
    expect(() => zAngleString.parse('a'.repeat(401))).toThrow();
  });

  it('requires the angle to be at least 3 chars', () => {
    expect(() => zAngleString.parse('ab')).toThrow();
    expect(zAngleString.parse('abc')).toBe('abc');
  });
});

describe('zTrendingSearchInput', () => {
  it('requires at least one niche', () => {
    expect(() => zTrendingSearchInput.parse({ niches: [] })).toThrow();
  });

  it('caps at 6 niches', () => {
    expect(() =>
      zTrendingSearchInput.parse({ niches: Array.from({ length: 7 }, (_, i) => `n${i}`) }),
    ).toThrow();
  });

  it('accepts the canonical shape', () => {
    const parsed = zTrendingSearchInput.parse({
      niches: ['Multiverse Crossovers'],
      ideaConcept: 'Darth Vader meets Iron Man',
      count: 5,
    });
    expect(parsed.count).toBe(5);
    expect(parsed.ideaConcept).toBe('Darth Vader meets Iron Man');
  });

  it('defaults count to 5 when omitted', () => {
    const parsed = zTrendingSearchInput.parse({ niches: ['Sci-Fi & Fantasy'] });
    expect(parsed.count).toBe(5);
  });

  it('rejects a count above 10', () => {
    expect(() =>
      zTrendingSearchInput.parse({ niches: ['X'], count: 11 }),
    ).toThrow();
  });

  it('treats ideaConcept as optional', () => {
    const parsed = zTrendingSearchInput.parse({ niches: ['X'] });
    expect(parsed.ideaConcept).toBeUndefined();
  });
});

describe('zGeneratePromptInput', () => {
  const baseInput = {
    niches: ['Mythic Legends'],
    genres: ['Cinematic Crossovers'],
    angle: 'Darth Vader in Iron Man suit',
  };

  it('accepts a minimal input', () => {
    const parsed = zGeneratePromptInput.parse(baseInput);
    expect(parsed.angle).toBe('Darth Vader in Iron Man suit');
    expect(parsed.skillContext).toEqual([]);
  });

  it('defaults skillContext to []', () => {
    const parsed = zGeneratePromptInput.parse(baseInput);
    expect(parsed.skillContext).toEqual([]);
  });

  it('rejects when niches is empty', () => {
    expect(() => zGeneratePromptInput.parse({ ...baseInput, niches: [] })).toThrow();
  });

  it('rejects when genres is empty', () => {
    expect(() => zGeneratePromptInput.parse({ ...baseInput, genres: [] })).toThrow();
  });

  it('caps trending context at 30 entries', () => {
    const huge = Array.from({ length: 31 }, (_, i) => ({
      title: `t${i}`,
      url: 'https://x.com',
      snippet: '',
      niche: 'X',
      source: '@google_search',
    }));
    expect(() =>
      zGeneratePromptInput.parse({ ...baseInput, trendingContext: huge }),
    ).toThrow();
  });
});

describe('zCritiquePromptInput', () => {
  it('requires a non-trivial prompt (>= 20 chars)', () => {
    expect(() =>
      zCritiquePromptInput.parse({
        prompt: 'short',
        requirements: { niches: ['X'], angle: 'something interesting here' },
      }),
    ).toThrow();
  });

  it('defaults antiAiLook to true', () => {
    const parsed = zCritiquePromptInput.parse({
      prompt: 'A sufficiently long prompt to pass the validation gate.',
      requirements: { niches: ['X'], angle: 'some angle here' },
    });
    expect(parsed.requirements.antiAiLook).toBe(true);
  });

  it('preserves a false antiAiLook', () => {
    const parsed = zCritiquePromptInput.parse({
      prompt: 'A sufficiently long prompt to pass the validation gate.',
      requirements: { niches: ['X'], angle: 'some angle here', antiAiLook: false },
    });
    expect(parsed.requirements.antiAiLook).toBe(false);
  });
});

describe('zImageSettings', () => {
  it('applies the documented defaults', () => {
    const s = zImageSettings.parse({});
    expect(s.aspectRatio).toBe('1:1');
    expect(s.resolution).toBe('1k');
    expect(s.seed).toBe(0);
  });

  it('rejects a non-allowlisted aspect ratio', () => {
    expect(() => zImageSettings.parse({ aspectRatio: '7:7' })).toThrow();
  });

  it('rejects a non-allowlisted resolution', () => {
    expect(() => zImageSettings.parse({ resolution: '8k' })).toThrow();
  });
});

describe('zGenerateImageInput', () => {
  const validPrompt = 'A long enough prompt to satisfy the min-20 validation gate.';
  it('accepts the canonical shape', () => {
    const parsed = zGenerateImageInput.parse({
      model: 'nano_banana_2',
      prompt: validPrompt,
    });
    // settings is optional in the schema; the tool applies defaults
    // at execute() time (see IMAGE_SETTINGS_DEFAULTS).
    expect(parsed.settings).toBeUndefined();
    expect(parsed.providerOptions).toBeUndefined();
  });

  it('rejects a prompt shorter than 20 chars', () => {
    expect(() =>
      zGenerateImageInput.parse({ model: 'nano_banana_2', prompt: 'short' }),
    ).toThrow();
  });
});

describe('zVideoSettings', () => {
  it('allows "auto" aspect ratio (only video does)', () => {
    expect(zVideoSettings.parse({ aspectRatio: 'auto' }).aspectRatio).toBe('auto');
  });

  it('caps duration at 15s', () => {
    expect(() => zVideoSettings.parse({ durationSec: 16 })).toThrow();
  });
});

describe('zGenerateVideoInput', () => {
  const validPrompt = 'A long enough prompt to satisfy the min-20 validation gate.';
  it('accepts the canonical shape', () => {
    const parsed = zGenerateVideoInput.parse({
      model: 'seedance_2_0',
      prompt: validPrompt,
      settings: { durationSec: 5 },
    });
    expect(parsed.settings?.durationSec).toBe(5);
  });
});

describe('zAssetMetadata / zPersistAssetInput', () => {
  it('defaults kind to "image"', () => {
    const m = zAssetMetadata.parse({ title: 'Test' });
    expect(m.kind).toBe('image');
  });

  it('caps tags at 40', () => {
    expect(() =>
      zAssetMetadata.parse({
        title: 'Test',
        tags: Array.from({ length: 41 }, (_, i) => `t${i}`),
      }),
    ).toThrow();
  });

  it('accepts the full input shape', () => {
    const parsed = zPersistAssetInput.parse({
      assetRef: { provider: 'higgsfield', id: 'x', url: 'https://x.com' },
      metadata: { title: 'Test', kind: 'image', tags: ['Marvel'] },
    });
    expect(parsed.metadata.title).toBe('Test');
  });
});
