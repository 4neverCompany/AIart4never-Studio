import { describe, it, expect } from 'vitest';
import { buildEnhancedPrompt } from '@/lib/image-prompt-builder';

// nano-banana-2 spec has style "Dynamic" with a UUID, and an aspectRatios
// table keyed "1:1" -> { "1K": [1024,1024], "2K": [2048,2048], "4K": [...] }.
// gpt-image-1.5 spec has parameters.quality default HIGH, mode default
// ULTRA, prompt_enhance default ON.
const NANO_DYNAMIC_UUID = '111dc692-d470-4eec-b791-3475abac4c46';

describe('buildEnhancedPrompt — shared output (prompt + hints)', () => {
  it('returns the original prompt unchanged when no spec/style is given', () => {
    const r = buildEnhancedPrompt('a cat on a sofa');
    expect(r.prompt).toBe('a cat on a sofa');
    expect(r.appliedHints).toEqual([]);
    expect(r.mmx).toEqual({});
    expect(r.leonardo).toEqual({});
  });

  it('matches style names case-insensitively against the spec', () => {
    const r = buildEnhancedPrompt('p', {
      modelId: 'nano-banana-2',
      styleName: 'dynamic',
    });
    expect(r.appliedHints).toContain('style: Dynamic');
  });

  it('does not inject a style that is not in the spec', () => {
    const r = buildEnhancedPrompt('p', {
      modelId: 'nano-banana-2',
      styleName: 'NotARealStyle',
    });
    expect(r.appliedHints.find((h) => h.startsWith('style:'))).toBeUndefined();
    expect(r.leonardo.styleIds).toBeUndefined();
  });

  it('appends caller-supplied qualityHint after spec-derived hints', () => {
    const r = buildEnhancedPrompt('p', {
      qualityHint: 'cinematic lighting, hyperdetailed',
    });
    expect(r.prompt).toBe('p. cinematic lighting, hyperdetailed');
    expect(r.appliedHints).toContain('cinematic lighting, hyperdetailed');
  });

  it('orders hints: style → aspect → quality/mode → user qualityHint', () => {
    const r = buildEnhancedPrompt('a cat', {
      modelId: 'gpt-image-1.5',
      qualityHint: 'warm dramatic',
    });
    const idx = (h: string) => r.appliedHints.indexOf(h);
    expect(idx('quality: HIGH')).toBeLessThan(idx('warm dramatic'));
  });

  it('injects bare style keyword when no spec is supplied', () => {
    const r = buildEnhancedPrompt('p', { styleName: 'cyberpunk' });
    expect(r.appliedHints).toContain('style: cyberpunk');
    // No UUID resolution without a spec.
    expect(r.leonardo.styleIds).toBeUndefined();
  });

  it('does not inject params for unknown modelId', () => {
    const r = buildEnhancedPrompt('a cat', { modelId: 'nonexistent-model' });
    expect(r.appliedHints).toEqual([]);
    expect(r.mmx).toEqual({});
    expect(r.leonardo).toEqual({});
  });
});

describe('buildEnhancedPrompt — MMX branch', () => {
  it('sets aspectRatio + appends keyword from spec', () => {
    const r = buildEnhancedPrompt('a sky', {
      modelId: 'nano-banana-2',
      styleName: 'Dynamic',
    });
    // First aspect ratio in nano-banana-2 spec is "1:1".
    expect(r.mmx.aspectRatio).toBe('1:1');
    expect(r.appliedHints).toContain('aspect ratio: 1:1');
  });

  it('respects explicit aspectRatio override', () => {
    const r = buildEnhancedPrompt('p', {
      modelId: 'nano-banana-2',
      aspectRatio: '16:9',
    });
    expect(r.mmx.aspectRatio).toBe('16:9');
  });

  it('passes count through to mmx.n', () => {
    const r = buildEnhancedPrompt('p', { count: 3 });
    expect(r.mmx.n).toBe(3);
  });

  it('sets promptOptimizer when spec.prompt_enhance is ON', () => {
    const r = buildEnhancedPrompt('a cat', { modelId: 'gpt-image-1.5' });
    expect(r.mmx.promptOptimizer).toBe(true);
  });
});

describe('buildEnhancedPrompt — Leonardo branch', () => {
  it('resolves style UUID from spec.styles[name]', () => {
    const r = buildEnhancedPrompt('a sky', {
      modelId: 'nano-banana-2',
      styleName: 'Dynamic',
    });
    expect(r.leonardo.styleIds).toEqual([NANO_DYNAMIC_UUID]);
  });

  it('does not set styleIds when no spec is given', () => {
    const r = buildEnhancedPrompt('p', { styleName: 'Dynamic' });
    expect(r.leonardo.styleIds).toBeUndefined();
  });

  it('resolves width/height from spec.aspectRatios using the first tier by default', () => {
    const r = buildEnhancedPrompt('p', {
      modelId: 'nano-banana-2',
      aspectRatio: '1:1',
    });
    // First tier of "1:1" in nano-banana-2 is "1K" → [1024, 1024].
    expect(r.leonardo.width).toBe(1024);
    expect(r.leonardo.height).toBe(1024);
  });

  it('respects an explicit dimensionTier', () => {
    const r = buildEnhancedPrompt('p', {
      modelId: 'nano-banana-2',
      aspectRatio: '1:1',
      dimensionTier: '2K',
    });
    expect(r.leonardo.width).toBe(2048);
    expect(r.leonardo.height).toBe(2048);
  });

  it('forwards spec.parameters.quality and prompt_enhance as structured params', () => {
    // gpt-image-1.5 spec: quality=HIGH, prompt_enhance=ON. The legacy
    // `mode` parameter (FAST|QUALITY|ULTRA) was deprecated 2026-05-04
    // and removed from the spec — only `quality` survives.
    const r = buildEnhancedPrompt('a cat', { modelId: 'gpt-image-1.5' });
    expect(r.leonardo.quality).toBe('HIGH');
    expect(r.leonardo.promptEnhance).toBe('ON');
    expect((r.leonardo as Record<string, unknown>).mode).toBeUndefined();
  });

  it('passes count to leonardo.quantity', () => {
    const r = buildEnhancedPrompt('p', { count: 4 });
    expect(r.leonardo.quantity).toBe(4);
  });
});

describe('buildEnhancedPrompt — providers see the same prompt', () => {
  it('the shared prompt string is identical regardless of provider', () => {
    const r = buildEnhancedPrompt('a cat', {
      modelId: 'nano-banana-2',
      styleName: 'Dynamic',
      qualityHint: 'cinematic lighting',
    });
    // The single prompt string is what feeds BOTH providers — guarantees
    // they see the same intent.
    expect(r.prompt).toMatch(/^a cat\. /);
    expect(r.prompt).toMatch(/style: Dynamic/);
    expect(r.prompt).toMatch(/aspect ratio: 1:1/);
    expect(r.prompt).toMatch(/cinematic lighting/);
  });
});

// ---------------------------------------------------------------------------
// V1.0.7-PROMPT-ENG-A1: SLCT four-layer director protocol
// ---------------------------------------------------------------------------

describe('buildEnhancedPrompt — SLCT four-layer director protocol', () => {
  it('appends the full SLCT block when all four layers are provided', () => {
    const r = buildEnhancedPrompt('a portrait', {
      slct: {
        surface: {
          skinCondition: 'weathered texture with enlarged pores',
          emotionalRegister: 'melancholic introspective expression',
        },
        lumina: {
          direction: 'hard directional light from upper right',
          quality: 'cinematic low-key',
        },
        capture: {
          proximity: 'extreme macro closeup',
          optics: '85mm macro lens',
        },
        texture: {
          authenticity: 'raw unretouched surface',
        },
      },
    });
    expect(r.prompt).toMatch(/a portrait\.\s+SLCT\[/);
    expect(r.prompt).toMatch(/S: weathered texture with enlarged pores; melancholic introspective expression/);
    expect(r.prompt).toMatch(/L: hard directional light from upper right; cinematic low-key/);
    expect(r.prompt).toMatch(/C: extreme macro closeup; 85mm macro lens/);
    expect(r.prompt).toMatch(/T: raw unretouched surface/);
    expect(r.appliedHints.find((h) => h.startsWith('SLCT['))).toBeDefined();
  });

  it('drops empty layers — only surfaces, no S block', () => {
    const r = buildEnhancedPrompt('p', {
      slct: { surface: { skinCondition: 'sweaty' } },
    });
    expect(r.prompt).toMatch(/SLCT\[S: sweaty\]/);
    expect(r.prompt).not.toMatch(/L:/);
    expect(r.prompt).not.toMatch(/C:/);
    expect(r.prompt).not.toMatch(/T:/);
  });

  it('drops empty sub-fields within a layer (no dangling ;)', () => {
    const r = buildEnhancedPrompt('p', {
      slct: {
        surface: { skinCondition: 'sweaty', emotionalRegister: '', microDetails: undefined },
      },
    });
    expect(r.prompt).toMatch(/SLCT\[S: sweaty\]/);
    // The layer block should not have empty segments
    expect(r.prompt).not.toMatch(/S:\s*sweaty;\s*;/);
  });

  it('produces an empty fragment when all inputs are empty / undefined', () => {
    const r = buildEnhancedPrompt('p', {
      slct: {
        surface: { skinCondition: '', emotionalRegister: undefined, microDetails: '  ' },
        lumina: undefined,
        capture: { proximity: '', optics: '', angle: '' },
        texture: {},
      },
    });
    expect(r.prompt).toBe('p');
    expect(r.appliedHints.find((h) => h.startsWith('SLCT['))).toBeUndefined();
  });

  it('does not append SLCT when no slct input is provided', () => {
    const r = buildEnhancedPrompt('a cat');
    expect(r.prompt).toBe('a cat');
    expect(r.appliedHints.find((h) => h.startsWith('SLCT['))).toBeUndefined();
  });

  it('orders SLCT after spec hints but before user qualityHint', () => {
    const r = buildEnhancedPrompt('p', {
      modelId: 'nano-banana-2',
      qualityHint: 'user override',
      slct: { surface: { skinCondition: 'glowing' } },
    });
    const slctIdx = r.appliedHints.findIndex((h) => h.startsWith('SLCT['));
    const userHintIdx = r.appliedHints.indexOf('user override');
    expect(slctIdx).toBeGreaterThanOrEqual(0);
    expect(userHintIdx).toBeGreaterThan(slctIdx);
  });
});

// ---------------------------------------------------------------------------
// V1.0.7-PROMPT-ENG-A4: anti-AI-look negative prompts
// ---------------------------------------------------------------------------

describe('buildEnhancedPrompt — anti-AI-look negative prompts', () => {
  it('defaults to an empty negativePrompts list when not requested', () => {
    const r = buildEnhancedPrompt('a cat');
    expect(r.negativePrompts).toEqual([]);
  });

  it('populates the curated list when antiAiLook is true', () => {
    const r = buildEnhancedPrompt('a cat', { antiAiLook: true });
    expect(r.negativePrompts.length).toBeGreaterThan(0);
    expect(r.negativePrompts).toContain('soft diffused lighting');
    expect(r.negativePrompts).toContain('smooth airbrushed skin');
    expect(r.negativePrompts).toContain('plastic skin');
  });

  it('does NOT inject the negatives into the positive prompt', () => {
    const r = buildEnhancedPrompt('a cat', { antiAiLook: true });
    // The positive prompt should remain user-facing only — negatives
    // travel in their own channel.
    expect(r.prompt).toBe('a cat');
    expect(r.prompt).not.toMatch(/Negative prompt:/i);
    expect(r.prompt).not.toMatch(/soft diffused lighting/);
  });

  it('leaves negativePrompts empty when antiAiLook is false', () => {
    const r = buildEnhancedPrompt('a cat', { antiAiLook: false });
    expect(r.negativePrompts).toEqual([]);
  });
});
