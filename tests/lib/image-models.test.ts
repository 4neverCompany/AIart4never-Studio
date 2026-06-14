/**
 * Tests for lib/image-models.ts
 *
 * Covers the unified registry + auto-pick behaviour:
 *   - Higgsfield models come first in the list
 *   - When CLI is connected, pickDefaultImageModel returns
 *     a higgsfield: model
 *   - The user's saved default wins over the auto-pick
 *   - When nothing is set, falls back to nano_banana_2 if
 *     CLI is ready, else the first available model
 */

import { describe, it, expect } from 'vitest'
import {
  IMAGE_MODELS,
  getImageModel,
  pickDefaultImageModel,
} from '@/lib/image-models'

describe('lib/image-models', () => {
  describe('IMAGE_MODELS registry', () => {
    it('includes Higgsfield models', () => {
      const hf = IMAGE_MODELS.filter((m) => m.provider === 'higgsfield')
      expect(hf.length).toBeGreaterThanOrEqual(3)
      expect(hf.some((m) => m.id === 'higgsfield:nano_banana_2')).toBe(true)
    })

    it('includes Leonardo models', () => {
      const leo = IMAGE_MODELS.filter((m) => m.provider === 'leonardo')
      expect(leo.length).toBeGreaterThan(0)
    })

    it('puts Higgsfield models first (so they win the default)', () => {
      expect(IMAGE_MODELS[0].provider).toBe('higgsfield')
    })

    it('preserves the legacy LeonardoModelConfig on Leonardo entries', () => {
      const phoenix = getImageModel('nano-banana-2')
      expect(phoenix).toBeDefined()
      expect(phoenix?.leonardoConfig).toBeDefined()
      expect(phoenix?.leonardoConfig?.id).toBe('nano-banana-2')
    })

    it('preserves the HiggsfieldModelMeta on Higgsfield entries', () => {
      const nb2 = getImageModel('higgsfield:nano_banana_2')
      expect(nb2).toBeDefined()
      expect(nb2?.higgsfieldConfig).toBeDefined()
      expect(nb2?.higgsfieldConfig?.slug).toBe('nano_banana_2')
    })
  })

  describe('pickDefaultImageModel (V1.4.0 auto-pick)', () => {
    it("returns the user's explicit default when set", () => {
      const result = pickDefaultImageModel({
        defaultImageModel: 'nano-banana-2',
        higgsfieldEnabled: true,
      })
      expect(result.id).toBe('nano-banana-2')
      expect(result.provider).toBe('leonardo')
    })

    it('prefers Higgsfield flagship when user enabled Higgsfield and no override', () => {
      const result = pickDefaultImageModel({
        higgsfieldEnabled: true,
      })
      expect(result.provider).toBe('higgsfield')
      expect(result.apiModelId).toBe('nano_banana_2')
    })

    it('prefers Higgsfield flagship when user enabled and listed models', () => {
      const result = pickDefaultImageModel({
        higgsfieldEnabled: true,
        higgsfieldImageModels: ['flux_2'],
      })
      expect(result.apiModelId).toBe('flux_2')
    })

    it('uses defaultHiggsfieldImageModel when enabled and listed', () => {
      const result = pickDefaultImageModel({
        defaultHiggsfieldImageModel: 'flux_2',
        higgsfieldEnabled: true,
        higgsfieldImageModels: ['nano_banana_2', 'flux_2'],
      })
      expect(result.id).toBe('higgsfield:flux_2')
    })

    it('keeps Leonardo default when user has NOT enabled Higgsfield (regression)', () => {
      const result = pickDefaultImageModel({
        higgsfieldEnabled: false,
        defaultLeonardoModel: 'nano-banana-2',
      })
      expect(result.id).toBe('nano-banana-2')
      expect(result.provider).toBe('leonardo')
    })

    it('keeps Leonardo default when settings are absent (existing workflow)', () => {
      const result = pickDefaultImageModel({})
      expect(result).toBeDefined()
      expect(result.id).toBeTruthy()
    })

    it('ignores defaultHiggsfieldImageModel when user has NOT enabled', () => {
      const result = pickDefaultImageModel({
        defaultHiggsfieldImageModel: 'flux_2',
        higgsfieldEnabled: false,
        defaultLeonardoModel: 'nano-banana-2',
      })
      expect(result.id).toBe('nano-banana-2')
    })
  })

  describe('V1.4.1 skill bindings for Higgsfield models', () => {
    it('Nano Banana Pro binds to banana-pro-director (SLCT)', () => {
      const nb2 = IMAGE_MODELS.find(m => m.id === 'higgsfield:nano_banana_2')
      expect(nb2?.skillBinding?.skillName).toBe('banana-pro-director')
      expect(nb2?.skillBinding?.slct).toBe(true)
    })

    it('Flux 2 binds to cinema-world-builder (MCSLA)', () => {
      const flux = IMAGE_MODELS.find(m => m.id === 'higgsfield:flux_2')
      expect(flux?.skillBinding?.skillName).toBe('cinema-world-builder')
      expect(flux?.skillBinding?.mcsla).toBe(true)
    })

    it('Seedream 4.5 binds to product-photoshoot (CLI backend enhancement)', () => {
      const sd = IMAGE_MODELS.find(m => m.id === 'higgsfield:seedream_v4_5')
      expect(sd?.skillBinding?.skillName).toBe('product-photoshoot')
    })

    it('Every Higgsfield model has a non-empty skill binding', () => {
      const hfModels = IMAGE_MODELS.filter(m => m.provider === 'higgsfield')
      for (const m of hfModels) {
        expect(m.skillBinding, `model ${m.id} missing skill binding`).toBeDefined()
        expect(m.skillBinding!.skillName).toBeTruthy()
        expect(m.skillBinding!.blurb).toBeTruthy()
      }
    })
  })

  describe('pickHiggsfieldModelForCycle (V1.4.0 round-robin)', () => {
    it('round-robins through the user-configured models', async () => {
      const { pickHiggsfieldModelForCycle } = await import('@/lib/image-models')
      const enabled = ['nano_banana_2', 'flux_2', 'gpt_image_2']
      expect(pickHiggsfieldModelForCycle(0, enabled).apiModelId).toBe('nano_banana_2')
      expect(pickHiggsfieldModelForCycle(1, enabled).apiModelId).toBe('flux_2')
      expect(pickHiggsfieldModelForCycle(2, enabled).apiModelId).toBe('gpt_image_2')
      expect(pickHiggsfieldModelForCycle(3, enabled).apiModelId).toBe('nano_banana_2')
      expect(pickHiggsfieldModelForCycle(4, enabled).apiModelId).toBe('flux_2')
    })

    it('falls back to the default when the list is empty', async () => {
      const { pickHiggsfieldModelForCycle } = await import('@/lib/image-models')
      const result = pickHiggsfieldModelForCycle(0, undefined)
      expect(result).toBeDefined()
      expect(result.apiModelId).toBe('nano_banana_2')
    })
  })
})
