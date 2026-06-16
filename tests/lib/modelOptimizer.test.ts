import { describe, it, expect } from 'vitest';
import { enhancePromptForModel } from '@/lib/modelOptimizer';

describe('enhancePromptForModel', () => {
  it('returns the base prompt unchanged', async () => {
    const result = await enhancePromptForModel('a knight on a hill', 'nano-banana');
    expect(result.prompt).toBe('a knight on a hill');
  });

  it('strips negativePrompt for gpt-image-1.5 even when caller supplies one', async () => {
    const result = await enhancePromptForModel('x', 'gpt-image-1.5', {
      negativePrompt: 'blurry',
    });
    expect(result.negativePrompt).toBeUndefined();
  });

  it('passes through negativePrompt for models that support it', async () => {
    const result = await enhancePromptForModel('x', 'nano-banana', {
      negativePrompt: 'blurry, low-res',
    });
    expect(result.negativePrompt).toBe('blurry, low-res');
  });

  it('passes through caller-supplied style', async () => {
    const result = await enhancePromptForModel('x', 'nano-banana', { style: 'Cinematic' });
    expect(result.style).toBe('Cinematic');
  });

  it('uses caller aspectRatio when provided', async () => {
    const result = await enhancePromptForModel('x', 'nano-banana', { aspectRatio: '16:9' });
    expect(result.aspectRatio).toBe('16:9');
  });

  it('falls back to model default aspectRatio when caller omits it', async () => {
    // MashupForge rip: the Leonardo catalog is gone; minimax-image-01 is
    // the kept entry in LEONARDO_MODELS and its first aspectRatio is 1:1.
    const result = await enhancePromptForModel('x', 'minimax-image-01');
    expect(result.aspectRatio).toBe('1:1');
  });

  it('returns aspectRatio undefined for an unknown model with no caller hint', async () => {
    const result = await enhancePromptForModel('x', 'definitely-not-a-real-model');
    expect(result.aspectRatio).toBeUndefined();
  });

  it('omits style when caller provides none (no synthetic default injected)', async () => {
    const result = await enhancePromptForModel('x', 'nano-banana');
    expect(result.style).toBeUndefined();
  });

  // STYLE-AI-FIX (2026-05-20): capability-aware style stripping. Mirrors the
  // existing negativePrompt strip — models whose JSON spec declares
  // `capabilities.styles: false` must not receive a style downstream, so the
  // preview panel and the generation path can't surface a style the API
  // would silently ignore. MashupForge rip: the gpt-image-* Leonardo specs
  // are deleted; minimax-image-01 (capabilities.styles: false) is the kept
  // styles:false model that pins this contract.
  describe('STYLE-AI-FIX — capability-aware style stripping', () => {
    it('strips style for minimax-image-01 (capabilities.styles: false)', async () => {
      const result = await enhancePromptForModel('x', 'minimax-image-01', {
        style: 'Cinematic',
      });
      expect(result.style).toBeUndefined();
    });

    it('preserves style for an unregistered model (no spec → defaults to supports)', async () => {
      // A model with no JSON spec defaults to "supports styles" so we
      // don't regress on stragglers (the pre-fix pass-through behaviour).
      const result = await enhancePromptForModel('x', 'some-future-model', {
        style: 'Cinematic',
      });
      expect(result.style).toBe('Cinematic');
    });
  });
});
