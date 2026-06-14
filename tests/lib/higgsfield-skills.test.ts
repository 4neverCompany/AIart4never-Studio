/**
 * Tests for Higgsfield skill injection behavior.
 *
 * Covers:
 *   - activeSkillNamesForBinding always includes cinema-world-builder
 *   - Model-specific skill is added for banana family
 *   - Returns empty for undefined binding
 *   - IMAGE_MODELS registry has correct skillBinding per model family
 *   - hfSkillNames dedup logic matches the useImageGeneration pattern
 */

import { describe, it, expect } from 'vitest'
import { activeSkillNamesForBinding } from '@/lib/higgsfield/skills'
import { IMAGE_MODELS } from '@/lib/image-models'

describe('activeSkillNamesForBinding', () => {
  it('always includes cinema-world-builder for any binding', () => {
    const binding = { skillName: 'banana-pro-director', blurb: 'SLCT framework' }
    const names = activeSkillNamesForBinding(binding)
    expect(names).toContain('cinema-world-builder')
  })

  it('includes the model-specific skill alongside cinema-world-builder', () => {
    const binding = { skillName: 'banana-pro-director', blurb: 'SLCT framework' }
    const names = activeSkillNamesForBinding(binding)
    expect(names).toContain('banana-pro-director')
    expect(names.length).toBe(2)
  })

  it('returns empty array when binding is undefined', () => {
    const names = activeSkillNamesForBinding(undefined)
    expect(names).toHaveLength(0)
  })

  it('does not duplicate when skillName is cinema-world-builder (dedup handled by caller)', () => {
    const binding = { skillName: 'cinema-world-builder', blurb: 'MCSLA' }
    const names = activeSkillNamesForBinding(binding)
    // The function returns ['cinema-world-builder', 'cinema-world-builder'].
    // Callers are responsible for dedup (see useImageGeneration .filter).
    expect(names[0]).toBe('cinema-world-builder')
    expect(names[1]).toBe('cinema-world-builder')
  })
})

describe('IMAGE_MODELS skill bindings (gap-1 injection path)', () => {
  it('nano_banana_2 uses banana-pro-director (SLCT framework)', () => {
    const model = IMAGE_MODELS.find(m => m.id === 'higgsfield:nano_banana_2')
    expect(model).toBeDefined()
    expect(model?.skillBinding?.skillName).toBe('banana-pro-director')
    expect(model?.skillBinding?.slct).toBe(true)
  })

  it('nano_banana_flash uses banana-pro-director (same family as nano_banana_2)', () => {
    const model = IMAGE_MODELS.find(m => m.id === 'higgsfield:nano_banana_flash')
    if (!model) return // model may not exist in all catalog variants
    expect(model.skillBinding?.skillName).toBe('banana-pro-director')
  })

  it('flux_2 uses cinema-world-builder (MCSLA structure)', () => {
    const model = IMAGE_MODELS.find(m => m.id === 'higgsfield:flux_2')
    expect(model).toBeDefined()
    expect(model?.skillBinding?.skillName).toBe('cinema-world-builder')
    expect(model?.skillBinding?.mcsla).toBe(true)
  })

  it('every Higgsfield model has a non-empty skillBinding', () => {
    const hfModels = IMAGE_MODELS.filter(m => m.provider === 'higgsfield')
    expect(hfModels.length).toBeGreaterThan(0)
    for (const m of hfModels) {
      expect(m.skillBinding).toBeDefined()
      expect(m.skillBinding?.skillName.length).toBeGreaterThan(0)
    }
  })

  it('Leonardo models have no skillBinding (not Higgsfield-specific)', () => {
    const leoModels = IMAGE_MODELS.filter(m => m.provider === 'leonardo')
    for (const m of leoModels) {
      expect(m.skillBinding).toBeUndefined()
    }
  })

  it('hfSkillNames dedup logic produces unique names (mirrors useImageGeneration)', () => {
    // Reproduce the exact filter logic from useImageGeneration.ts
    const binding = { skillName: 'cinema-world-builder', blurb: '' }
    const raw = ['cinema-world-builder', binding.skillName]
    const deduped = raw.filter((n, idx, arr) => arr.indexOf(n) === idx)
    expect(deduped).toEqual(['cinema-world-builder'])
    expect(deduped.length).toBe(1)
  })
})
