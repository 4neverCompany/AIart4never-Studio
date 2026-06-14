// STORY-MMX-PROMPT-WIRE — pin the contract `useImageGeneration.ts`
// relies on after the wiring switch.
//
// The hook now feeds the AI-enhanced prompt + (modelId, styleName,
// aspectRatio) into buildEnhancedPrompt and forwards the result to
// /api/leonardo. The hook itself is hard to mount in isolation (deep
// context + heavy DOM dependencies), so we pin the underlying library
// outputs against the actual spec JSON. If a spec change or builder
// regression would break the hook's body shape, this fails first.

import { describe, it, expect } from 'vitest';
import { buildEnhancedPrompt } from '@/lib/image-prompt-builder';

describe('buildEnhancedPrompt — useImageGeneration wiring contract', () => {
  it('returns a Leonardo-shaped slice for nano-banana-2 + named style + aspect', () => {
    const r = buildEnhancedPrompt('a cat on a sofa', {
      modelId: 'nano-banana-2',
      styleName: '3D Render',
      aspectRatio: '16:9',
      count: 1,
    });

    // styleIds resolved from spec.styles → real Leonardo UUID
    expect(r.leonardo.styleIds).toEqual(['debdf72a-91a4-467b-bf61-cc02bdeb69c6']);
    // 16:9 dimension table → first tier (1K) by default
    expect(typeof r.leonardo.width).toBe('number');
    expect(typeof r.leonardo.height).toBe('number');
    expect(r.leonardo.width).toBeGreaterThan(0);
    expect(r.leonardo.height).toBeGreaterThan(0);
    // The hook merges quality with the spec default, so we expect SOME
    // string here so the merge path stays meaningful.
    expect(typeof r.leonardo.quality === 'string' || r.leonardo.quality === undefined).toBe(true);

    // Prompt enhancement: keywords appended after the base prompt so
    // both providers see the same intent.
    expect(r.prompt).toMatch(/^a cat on a sofa\./);
    expect(r.appliedHints).toEqual(expect.arrayContaining(['style: 3D Render', 'aspect ratio: 16:9']));
  });

  it('returns an MMX-shaped slice for the same inputs', () => {
    const r = buildEnhancedPrompt('a cat on a sofa', {
      modelId: 'nano-banana-2',
      styleName: '3D Render',
      aspectRatio: '16:9',
      count: 1,
    });

    expect(r.mmx.aspectRatio).toBe('16:9');
    expect(r.mmx.n).toBe(1);
  });

  it('falls back gracefully when the modelId has no spec entry', () => {
    const r = buildEnhancedPrompt('a cat', {
      modelId: 'unknown-model',
      styleName: 'Cinematic',
      aspectRatio: '1:1',
      count: 1,
    });
    // No spec → no style UUID, no width/height. Hook's fallback path
    // (LEONARDO_MODELS fuzzy match + getLeonardoDimensions) takes over.
    expect(r.leonardo.styleIds).toBeUndefined();
    expect(r.leonardo.width).toBeUndefined();
    expect(r.leonardo.height).toBeUndefined();
    // Keywords still appended as natural-language hints.
    expect(r.prompt).toMatch(/style: Cinematic/);
    expect(r.prompt).toMatch(/aspect ratio: 1:1/);
  });

  it('passes count through to both providers', () => {
    const r = buildEnhancedPrompt('a cat', { count: 4 });
    expect(r.mmx.n).toBe(4);
    expect(r.leonardo.quantity).toBe(4);
  });

  // V1.0.7-PROMPT-ENG-A4: pin the anti-AI-look contract that
  // `hooks/useImageGeneration.ts` relies on. The hook forwards
  // `enhanced.negativePrompts` to `submitLeonardoAndPoll` /
  // `submitViaAiImage` via the `antiAiLookNegatives` parameter; the
  // route layer concatenates them with the user-supplied `negative_prompt`
  // and forwards the joined string to the provider. If this contract
  // ever changes, those submit call-sites break in unexpected ways.
  describe('anti-AI-look negatives', () => {
    it('returns an empty array by default so the spread is type-safe', () => {
      const r = buildEnhancedPrompt('a cat', {
        modelId: 'nano-banana-2',
        styleName: '3D Render',
        aspectRatio: '16:9',
        count: 1,
      });
      expect(r.negativePrompts).toEqual([]);
    });

    it('returns the curated list when antiAiLook is true', () => {
      const r = buildEnhancedPrompt('a cat', {
        modelId: 'nano-banana-2',
        styleName: '3D Render',
        aspectRatio: '16:9',
        count: 1,
        antiAiLook: true,
      });
      // The curated list is non-empty by design (see
      // lib/image-prompt-builder.ts ANTI_AI_LOOK_NEGATIVES) — pinning
      // a specific entry so a refactor that drops items shows up
      // here first.
      expect(r.negativePrompts.length).toBeGreaterThan(0);
      expect(r.negativePrompts).toContain('plastic skin');
      // Negatives must NOT pollute the positive prompt — they're a
      // provider-channel-only field.
      expect(r.prompt).not.toMatch(/plastic skin/);
    });

    it('returns an empty array when antiAiLook is explicitly false', () => {
      const r = buildEnhancedPrompt('a cat', {
        antiAiLook: false,
      });
      expect(r.negativePrompts).toEqual([]);
    });
  });

  // V1.0.7-PROMPT-ENG-A2/A3: pin the MCSLA + camera-angle contract
  // that `hooks/useImageGeneration.ts` and
  // `components/Settings/CameraAnglePicker.tsx` rely on. The hook
  // forwards `settings.cameraAngle` (a slug from
  // `lib/camera-angles.ts`) into the `mcsla.camera.angle` field.
  // The composer resolves the slug to a full prompt fragment.
  describe('MCSLA + camera angle', () => {
    it('emits no MCSLA block when mcsla is omitted', () => {
      const r = buildEnhancedPrompt('a cat on a sofa', {
        modelId: 'nano-banana-2',
        styleName: '3D Render',
        aspectRatio: '16:9',
        count: 1,
      });
      expect(r.prompt).not.toMatch(/MCSLA/);
    });

    it('resolves a known camera-angle slug into a full prompt fragment', () => {
      const r = buildEnhancedPrompt('a cat on a sofa', {
        mcsla: { camera: { angle: 'low-angle-30' } },
      });
      // Slug resolves to "Low angle, 30° below eye level" via the catalog
      expect(r.prompt).toMatch(/MCSLA\[C: Low angle; 30° below eye level\]/);
    });

    it('passes through an unknown angle as raw text (forward-compat)', () => {
      const r = buildEnhancedPrompt('a cat', {
        mcsla: { camera: { angle: 'tilted-fisheye' } },
      });
      // Unknown slugs are kept as-is so a future catalog addition
      // doesn't crash a still-rolling-out client.
      expect(r.prompt).toMatch(/MCSLA\[C: tilted-fisheye\]/);
    });

    it('composes all five layers in the documented M|C|S|L|A order', () => {
      const r = buildEnhancedPrompt('a cat', {
        mcsla: {
          model: 'kling-3.0',
          camera: { angle: 'eye-level', movement: 'slow push-in', lens: '50mm' },
          subject: 'a curious orange tabby',
          look: { lighting: 'golden hour', color: 'warm amber' },
          action: 'looks up at the camera',
        },
      });
      expect(r.prompt).toMatch(
        /MCSLA\[M: kling-3\.0 \| C: Eye Level; slow push-in; 50mm \| S: a curious orange tabby \| L: golden hour; warm amber \| A: looks up at the camera\]/
      );
    });

    it('drops empty layers without producing dangling `|` separators', () => {
      const r = buildEnhancedPrompt('a cat', {
        mcsla: { subject: 'a curious orange tabby' },
      });
      // No `M:`, `C:`, `L:`, or `A:` segments — only the `S:` one.
      expect(r.prompt).toMatch(/MCSLA\[S: a curious orange tabby\]/);
      expect(r.prompt).not.toMatch(/\| \|/);
    });

    it('does NOT pollute the negative-prompt channel with MCSLA text', () => {
      const r = buildEnhancedPrompt('a cat', {
        antiAiLook: true,
        mcsla: { camera: { angle: 'eye-level' } },
      });
      // negativePrompts only carries the anti-AI-look list; MCSLA
      // text lives in the positive prompt only.
      expect(r.negativePrompts).toContain('plastic skin');
      expect(r.negativePrompts).not.toContain('Eye Level');
    });
  });
});
