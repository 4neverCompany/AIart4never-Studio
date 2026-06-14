// @vitest-environment jsdom
/**
 * Regression tests for the V1.4.7-SETTINGS-WIPE fix in hooks/useSettings.ts
 * — Maurice's "page reload loses the watermark" report (2026-06-10).
 *
 * useSettings had the same wipe vector PR #59 closed in useImages, with an
 * extra twist: THREE writers were gated only on isSettingsLoaded (which the
 * !loadTriggered mount branch flips to true while `settings` is still
 * defaultSettings):
 *
 *   1. the 300ms debounced IDB write (persisted near-defaults over the
 *      user's stored settings),
 *   2. the unmount/dep-change cleanup localStorage write,
 *   3. the beforeunload localStorage flush.
 *
 * Writers 2+3 are the reload killer: a defaults-shaped snapshot lands in
 * localStorage, and the next load treats localStorage as an in-flight
 * PATCH that wins over the store (mergeSettings semantics) — the user's
 * watermark is replaced by the default one on every reload.
 *
 * The fix mirrors useImages: dirtyRef (only updateSettings/clearSettings
 * arm the writers), loadInFlightRef, hydratedOnceRef (localStorage writers
 * refuse until hydrated), and pendingOpsRef (pre-hydration edits replay on
 * top of the hydrated state).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const storeData: Record<string, unknown> = {}
const getMock = vi.fn(async (key: string) => storeData[key] ?? null)
const setMock = vi.fn(async (key: string, value: unknown) => {
  storeData[key] = value
})

vi.mock('@/lib/persistence', () => ({
  get: (key: string) => getMock(key),
  set: (key: string, value: unknown) => setMock(key, value),
}))

import { useSettings } from '@/hooks/useSettings'
import { defaultSettings, type UserSettings } from '@/types/mashup'
import { renderHook, act } from '@testing-library/react'

// The user's stored settings: a custom watermark + channel name, the
// fields Maurice reported losing on reload.
const customWatermark = {
  enabled: true,
  image: 'data:image/png;base64,USERWM',
  position: 'top-left' as const,
  opacity: 0.8,
  scale: 0.05,
}
const storedSettings: Partial<UserSettings> = {
  ...defaultSettings,
  watermark: customWatermark,
  channelName: 'MauriceChannel',
}

describe('useSettings — V1.4.7 reload wipe protection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    for (const k of Object.keys(storeData)) delete storeData[k]
    storeData['mashup_settings'] = JSON.parse(JSON.stringify(storedSettings))
    getMock.mockClear()
    setMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('Studio mount + unmount without edits never writes store or localStorage', async () => {
    const { unmount } = renderHook(() => useSettings())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    unmount()
    expect(setMock).not.toHaveBeenCalled()
    expect(localStorage.getItem('mashup_settings')).toBeNull()
    expect((storeData['mashup_settings'] as UserSettings).watermark).toEqual(customWatermark)
  })

  it('beforeunload on a no-edit session writes NOTHING (the reload-poison path)', async () => {
    const { result } = renderHook(() => useSettings())
    await act(async () => {
      result.current.requestLoad()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    // Settings hydrated; user just reloads without editing anything.
    act(() => {
      window.dispatchEvent(new Event('beforeunload'))
    })
    // Pre-fix this wrote the full current state to localStorage even
    // with zero edits; pre-hydration it wrote DEFAULTS, which the next
    // load merged OVER the store (patch wins) — watermark reset.
    expect(localStorage.getItem('mashup_settings')).toBeNull()
    expect((storeData['mashup_settings'] as UserSettings).watermark).toEqual(customWatermark)
  })

  it('unmount during an in-flight load never poisons localStorage with defaults', async () => {
    // Store read hangs — the reload-then-quickly-navigate scenario.
    getMock.mockImplementationOnce(() => new Promise(() => {}))
    const { result, unmount } = renderHook(() => useSettings())
    await act(async () => {
      // A pre-hydration edit (this is what armed the old cleanup writer).
      result.current.updateSettings({ channelName: 'NewName' })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    unmount()
    // The old cleanup wrote defaults+edit to localStorage here; the next
    // load would have merged that snapshot over the store.
    expect(localStorage.getItem('mashup_settings')).toBeNull()
    expect((storeData['mashup_settings'] as UserSettings).watermark).toEqual(customWatermark)
  })

  it('a pre-hydration edit auto-hydrates and persists the FULL settings + the edit', async () => {
    const { result } = renderHook(() => useSettings())
    // Edit before any Gallery/Settings visit (no requestLoad yet).
    await act(async () => {
      result.current.updateSettings({ channelName: 'NewName' })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    // The edit must be visible in memory…
    expect(result.current.settings.channelName).toBe('NewName')
    // …the hydrated watermark must have survived the edit…
    expect(result.current.settings.watermark).toEqual(customWatermark)
    // …and the persisted store must contain BOTH (pre-fix it got
    // defaults + the one edited field: watermark wiped).
    expect(setMock).toHaveBeenCalled()
    const written = storeData['mashup_settings'] as UserSettings
    expect(written.channelName).toBe('NewName')
    expect(written.watermark).toEqual(customWatermark)
  })

  it('hydration alone never writes the store back (dirty flag)', async () => {
    const { result } = renderHook(() => useSettings())
    await act(async () => {
      result.current.requestLoad()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(result.current.settings.watermark).toEqual(customWatermark)
    // Loading is not a mutation — no write-back of the loaded data.
    expect(setMock).not.toHaveBeenCalled()
  })

  it('an edit after hydration persists normally (no over-gating regression)', async () => {
    const { result } = renderHook(() => useSettings())
    await act(async () => {
      result.current.requestLoad()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    await act(async () => {
      result.current.updateSettings({ channelName: 'AfterLoad' })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    const written = storeData['mashup_settings'] as UserSettings
    expect(written.channelName).toBe('AfterLoad')
    expect(written.watermark).toEqual(customWatermark)
  })

  it('a THROWING (rejected) store read keeps the persist gate shut — no write after a later edit', async () => {
    // Coverage hole the usePersistentStore migration review flagged: the
    // suite's only failure test uses a HANGING read (never resolves); this
    // covers a REJECTED read, exercising the catch / onLoadError /
    // hydratedOnce-stays-false branch. A regression that set hydratedOnce
    // true on failure (re-opening the V1.6 wipe) would otherwise pass green.
    // localStorage is empty (beforeEach) → load takes the no-localStorage
    // else branch → its single get() throws → propagates → hydratedOnce false.
    getMock.mockImplementationOnce(async () => { throw new Error('IDB unavailable') })
    const { result } = renderHook(() => useSettings())
    await act(async () => {
      result.current.requestLoad()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    // Hydration failed → error surfaced, store untouched.
    expect(result.current.saveState.kind).toBe('error')
    expect((storeData['mashup_settings'] as UserSettings).watermark).toEqual(customWatermark)
    setMock.mockClear()
    // An edit after the failed load must NOT write the (intact) store.
    await act(async () => {
      result.current.updateSettings({ channelName: 'AfterFail' })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(setMock).not.toHaveBeenCalled()
    expect((storeData['mashup_settings'] as UserSettings).watermark).toEqual(customWatermark)
  })

  it('clearSettings before hydration stays cleared after the hydration commit', async () => {
    ;(storeData['mashup_settings'] as Partial<UserSettings>).cameraAngle = 'low-angle'
    const { result } = renderHook(() => useSettings())
    await act(async () => {
      result.current.clearSettings(['cameraAngle'])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    // The hydrated store value for cameraAngle must NOT resurrect the
    // cleared key (pending-op replay wins).
    expect(result.current.settings.cameraAngle).toBeUndefined()
  })
})
