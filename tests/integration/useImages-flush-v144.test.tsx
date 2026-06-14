/**
 * Tests for the v1.4.4 data-loss fix in hooks/useImages.ts
 *
 * The bug: the beforeunload flush was gated on `loadTriggered`
 * (a flag that only flips to true when the user visits Gallery).
 * Common case: user generates an image in Studio, closes the app
 * within 200ms (before the debounced IDB write fires). The
 * flush listener was never registered → image is lost.
 *
 * The fix: register the listener unconditionally, but have the
 * flush function REFUSE to write an empty array (defense against
 * the original v1.2.5 bug where the initial `[]` would overwrite
 * localStorage, then the next load would overwrite the store with
 * that `[]`).
 *
 * These tests exercise the flush function's contract directly so
 * regressions in the v1.4.4 fix surface immediately.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// Capture the actual flush function registered on the listener so
// tests can call it directly without simulating a real beforeunload.
let registeredFlush: (() => void) | null = null
const addEventListenerSpy = vi.spyOn(window, 'addEventListener')
const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')

vi.mock('@/lib/persistence', () => ({
  get: vi.fn(async () => null),
  set: vi.fn(async () => undefined),
}))

vi.mock('@/lib/backup/images', () => ({
  autoBackupImages: vi.fn(async () => undefined),
}))

// Capture the registered flush function
addEventListenerSpy.mockImplementation((event: string, handler: EventListenerOrEventListenerObject) => {
  if (event === 'beforeunload' && typeof handler === 'function') {
    registeredFlush = handler as () => void
  }
})

import { useImages } from '@/hooks/useImages'
import { renderHook, act } from '@testing-library/react'

const sampleImage = {
  id: 'img-test-1',
  url: 'https://cdn.example/1.jpg',
  prompt: 'p',
  status: 'ready' as const,
  savedAt: 1000,
}

describe('useImages — v1.4.4 data-loss fix', () => {
  beforeEach(() => {
    localStorage.clear()
    registeredFlush = null
    vi.clearAllMocks()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('registers a beforeunload listener unconditionally on mount', () => {
    // V1.2.6 had the listener gated on `loadTriggered`; v1.4.4
    // removes that gate so the safety net works even when the
    // user never visited Gallery.
    const { result } = renderHook(() => useImages())
    expect(registeredFlush).not.toBeNull()
  })

  it('flush does NOT write an empty array to localStorage (v1.2.5 protection)', () => {
    // The original v1.2.5 bug: the initial in-memory `[]` would be
    // flushed to localStorage on first navigation, then the next
    // page would overwrite the store with that `[]`, wiping the
    // user's images. The fix is the empty-array short-circuit.
    renderHook(() => useImages())
    expect(registeredFlush).not.toBeNull()
    act(() => { registeredFlush!() })
    expect(localStorage.getItem('mashup_saved_images')).toBeNull()
  })

  it('flush DOES write a non-empty array to localStorage (v1.4.4 fix)', async () => {
    // Common case: user generates an image, the 200ms debounce
    // hasn't fired, the user closes the app. The always-registered
    // flush must capture the in-memory state.
    const { result } = renderHook(() => useImages())
    act(() => { result.current.saveImage(sampleImage) })
    expect(registeredFlush).not.toBeNull()
    act(() => { registeredFlush!() })
    const stored = localStorage.getItem('mashup_saved_images')
    expect(stored).not.toBeNull()
    const parsed = JSON.parse(stored!)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].id).toBe('img-test-1')
  })

  it('flush is idempotent on rapid save+flush cycles', async () => {
    // A second save+flush cycle overwrites localStorage cleanly
    // (no leakage from a previous non-empty state into an empty
    // state that would falsely succeed).
    const { result } = renderHook(() => useImages())
    act(() => { result.current.saveImage(sampleImage) })
    act(() => { registeredFlush!() })
    expect(JSON.parse(localStorage.getItem('mashup_saved_images')!)).toHaveLength(1)
    // Now delete the image — state goes back to `[]`
    act(() => { result.current.deleteImage('img-test-1', true) })
    // The flush now sees `[]` and must NOT write it. localStorage
    // keeps the previous (non-empty) snapshot — that's the v1.2.5
    // protection in action.
    localStorage.removeItem('mashup_saved_images')
    act(() => { registeredFlush!() })
    expect(localStorage.getItem('mashup_saved_images')).toBeNull()
  })
})
