/**
 * Tests for the higgsfield branch of lib/image-prompt-builder.ts.
 *
 * The existing image-prompt-builder.test.ts covers the mmx +
 * leonardo slices. This file focuses on the new higgsfield slice:
 *   - The spec's `apiName` becomes the Higgsfield `model` slug.
 *   - higgsfieldOptions (aspect ratio, resolution, quality) are
 *     forwarded verbatim.
 *   - When the caller passes no higgsfieldOptions, the prompt
 *     builder still produces a valid result with model=spec.apiName.
 *   - The three slices don't interfere (mmx + leonardo unaffected
 *     by higgsfield inputs).
 */

import { describe, it, expect } from 'vitest';
import { buildEnhancedPrompt } from '@/lib/image-prompt-builder';

describe('buildEnhancedPrompt — higgsfield slice', () => {
  it('uses the spec apiName as the higgsfield model', () => {
    const result = buildEnhancedPrompt('a quiet beach at sunrise', {
      modelId: 'higgsfield-nano-banana-pro',
    });
    expect(result.higgsfield.model).toBe('nano_banana_2');
  });

  it('forwards caller-supplied higgsfield options', () => {
    const result = buildEnhancedPrompt('a quiet beach at sunrise', {
      modelId: 'higgsfield-nano-banana-pro',
      higgsfieldOptions: {
        aspectRatio: '9:16',
        resolution: '4k',
        quality: 'high',
        seed: 42,
      },
    });
    expect(result.higgsfield.model).toBe('nano_banana_2');
    expect(result.higgsfield.aspectRatio).toBe('9:16');
    expect(result.higgsfield.resolution).toBe('4k');
    expect(result.higgsfield.quality).toBe('high');
    expect(result.higgsfield.seed).toBe(42);
  });

  it('falls back to the prompt-injected aspect ratio when no higgsfieldOptions passed', () => {
    const result = buildEnhancedPrompt('a quiet beach at sunrise', {
      modelId: 'higgsfield-nano-banana-pro',
      aspectRatio: '4:5',
    });
    expect(result.higgsfield.aspectRatio).toBe('4:5');
  });

  it('does not pollute leonardo styles + dimensions when only higgsfield inputs are passed', () => {
    const result = buildEnhancedPrompt('a quiet beach at sunrise', {
      modelId: 'higgsfield-nano-banana-pro',
      higgsfieldOptions: { aspectRatio: '1:1', resolution: '2k' },
    });
    // No style UUIDs leak through to leonardo (Higgsfield specs have
    // no styles map, so the prompt builder never tries to resolve one).
    expect(result.leonardo.styleIds).toBeUndefined();
    // The higgsfield slice carries the caller's exact values.
    expect(result.higgsfield.aspectRatio).toBe('1:1');
    expect(result.higgsfield.resolution).toBe('2k');
  });

  it('image count flows into all three slices', () => {
    const result = buildEnhancedPrompt('a quiet beach at sunrise', {
      modelId: 'higgsfield-nano-banana-pro',
      count: 2,
    });
    expect(result.mmx.n).toBe(2);
    expect(result.leonardo.quantity).toBe(2);
    expect(result.higgsfield.quantity).toBe(2);
  });

  it('works for video model specs too (seedance 2.0)', () => {
    const result = buildEnhancedPrompt('drone shot over a mountain valley at sunrise', {
      modelId: 'higgsfield-seedance-2-0',
      higgsfieldOptions: {
        aspectRatio: '9:16',
        duration: 8,
        mode: 'std',
        genre: 'epic',
      },
    });
    expect(result.higgsfield.model).toBe('seedance_2_0');
    expect(result.higgsfield.aspectRatio).toBe('9:16');
    expect(result.higgsfield.duration).toBe(8);
    expect(result.higgsfield.mode).toBe('std');
    expect(result.higgsfield.genre).toBe('epic');
  });

  it('empty higgsfieldOptions is a no-op on caller fields (model still resolves)', () => {
    const result = buildEnhancedPrompt('a quiet beach at sunrise', {
      modelId: 'higgsfield-nano-banana-pro',
      higgsfieldOptions: {},
    });
    expect(result.higgsfield.model).toBe('nano_banana_2');
    // aspectRatio will fall through to the spec's first aspect
    // ratio (1:1 for nano-banana-pro) — the prompt builder does
    // that for ALL three slices for consistency, which is the
    // intended behaviour.
    expect(result.higgsfield.aspectRatio).toBe('1:1');
    expect(result.higgsfield.resolution).toBeUndefined();
    expect(result.higgsfield.quality).toBeUndefined();
  });
});
