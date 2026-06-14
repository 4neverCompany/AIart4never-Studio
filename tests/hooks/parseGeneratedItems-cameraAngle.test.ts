/**
 * V1.7.0-M2.1: the idea-item parser keeps a valid per-item cameraAngle
 * and drops anything that isn't a catalog slug.
 */
import { describe, it, expect } from 'vitest'
import { parseGeneratedItems } from '@/hooks/useImageGeneration'

describe('parseGeneratedItems — cameraAngle (M2.1)', () => {
  it('keeps a valid catalog slug', () => {
    const raw = JSON.stringify([
      { prompt: 'A noir detective', cameraAngle: 'close-up-85' },
    ])
    expect(parseGeneratedItems(raw)[0].cameraAngle).toBe('close-up-85')
  })

  it('drops a hallucinated label or free text', () => {
    const raw = JSON.stringify([
      { prompt: 'Epic battle', cameraAngle: 'Low Angle (dramatic)' },
      { prompt: 'Calm portrait', cameraAngle: 'whatever the model felt like' },
    ])
    const items = parseGeneratedItems(raw)
    expect(items[0].cameraAngle).toBeUndefined()
    expect(items[1].cameraAngle).toBeUndefined()
  })

  it('absent cameraAngle stays undefined (back-compat with old prompts)', () => {
    const raw = JSON.stringify([{ prompt: 'Just a prompt', aspectRatio: '1:1' }])
    expect(parseGeneratedItems(raw)[0].cameraAngle).toBeUndefined()
  })
})
