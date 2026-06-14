/**
 * V1.7.0-M2.1: contextual camera angle helpers.
 * Covers the catalog menu, id validation, and the settings-lock-vs-
 * AI-choice resolution precedence.
 */
import { describe, it, expect } from 'vitest'
import {
  buildCameraAngleMenu,
  isCameraAngleId,
  resolveEffectiveCameraAngle,
  CAMERA_ANGLES,
} from '@/lib/camera-angles'

describe('buildCameraAngleMenu', () => {
  it('lists every catalog slug with its register and intent', () => {
    const menu = buildCameraAngleMenu()
    for (const a of CAMERA_ANGLES) {
      expect(menu).toContain(a.id)
    }
    // one line per angle
    expect(menu.split('\n')).toHaveLength(CAMERA_ANGLES.length)
  })
})

describe('isCameraAngleId', () => {
  it('accepts real slugs', () => {
    expect(isCameraAngleId('low-angle-30')).toBe(true)
    expect(isCameraAngleId('eye-level')).toBe(true)
  })
  it('rejects labels, free text, and non-strings', () => {
    expect(isCameraAngleId('Low Angle (30°)')).toBe(false) // label, not id
    expect(isCameraAngleId('cinematic dramatic angle')).toBe(false)
    expect(isCameraAngleId('')).toBe(false)
    expect(isCameraAngleId(undefined)).toBe(false)
    expect(isCameraAngleId(42)).toBe(false)
  })
})

describe('resolveEffectiveCameraAngle (lock precedence)', () => {
  it('settings lock wins over the AI per-item choice', () => {
    expect(resolveEffectiveCameraAngle('macro', 'low-angle-30')).toBe('macro')
  })
  it('uses the AI per-item choice when settings is unset', () => {
    expect(resolveEffectiveCameraAngle(undefined, 'low-angle-30')).toBe('low-angle-30')
    expect(resolveEffectiveCameraAngle('', 'pov')).toBe('pov')
  })
  it('ignores invalid ids on either side', () => {
    expect(resolveEffectiveCameraAngle('not-a-real-angle', 'pov')).toBe('pov')
    expect(resolveEffectiveCameraAngle(undefined, 'garbage')).toBeUndefined()
    expect(resolveEffectiveCameraAngle(undefined, undefined)).toBeUndefined()
  })
})
