// @vitest-environment jsdom
/**
 * V1.8.1 regression: the M3.2b watermark-to-disk migration must PERSIST
 * its result, not just patch in-memory.
 *
 * The migration (hooks/useSettings.ts) writes the watermark image to
 * disk and patches settings to a slim { imageRef + asset URL } record.
 * v1.8.0 shipped it calling setSettings WITHOUT arming dirtyRef — so the
 * 300ms-debounced store write (gated on dirtyRef) never fired. The
 * ~10.7MB data-URL stayed in the store across sessions and the migration
 * re-ran every launch, defeating M3.2b's whole purpose. v1.8.1 arms
 * dirtyRef so the slim record persists exactly once.
 *
 * This test proves the persist fires: it mocks the migrate module to
 * return a slim patch and asserts the store is written with the asset
 * URL (no data-URL) within the debounce window.
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

const ASSET_URL = 'asset://localhost/wm.png'
const IMAGE_REF = { hash: 'abc123', filename: 'wm.png', mimeType: 'image/png', size: 42 }
const shouldMigrateMock = vi.fn()
const migrateMock = vi.fn()
vi.mock('@/lib/watermarks/migrate', () => ({
  shouldMigrateWatermark: (...a: unknown[]) => shouldMigrateMock(...a),
  migrateWatermarkToDisk: (...a: unknown[]) => migrateMock(...a),
}))

import { useSettings } from '@/hooks/useSettings'
import { defaultSettings, type UserSettings } from '@/types/mashup'
import { renderHook, act, waitFor } from '@testing-library/react'

const LEGACY_DATA_URL = 'data:image/png;base64,' + 'A'.repeat(2000)
const legacyWatermark = {
  enabled: true,
  image: LEGACY_DATA_URL,
  position: 'bottom-right' as const,
  opacity: 0.8,
  scale: 0.15,
}

describe('useSettings — V1.8.1 watermark migration persists', () => {
  beforeEach(() => {
    for (const k of Object.keys(storeData)) delete storeData[k]
    getMock.mockClear()
    setMock.mockClear()
    shouldMigrateMock.mockReset()
    migrateMock.mockReset()
    localStorage.clear()
    // Pretend we're inside the Tauri webview so the migration's isTauri
    // guard passes.
    ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  })
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    vi.useRealTimers()
  })

  it('persists the slimmed { imageRef + asset URL } watermark to the store after migration', async () => {
    storeData['mashup_settings'] = {
      ...defaultSettings,
      watermark: legacyWatermark,
    } as Partial<UserSettings>
    shouldMigrateMock.mockReturnValue(true)
    migrateMock.mockResolvedValue({
      watermark: { ...legacyWatermark, image: ASSET_URL, imageRef: IMAGE_REF },
    })

    const { result } = renderHook(() => useSettings())
    act(() => { result.current.requestLoad() })

    // Wait for hydration + the migration's async patch.
    await waitFor(() => expect(migrateMock).toHaveBeenCalledTimes(1))

    // The persist is 300ms-debounced; wait for the store write carrying
    // the slim watermark. Without the dirtyRef fix this never happens.
    await waitFor(
      () => {
        const wmWrites = setMock.mock.calls.filter(
          ([key, val]) =>
            key === 'mashup_settings' &&
            (val as { watermark?: { imageRef?: unknown; image?: string } }).watermark?.imageRef !== undefined,
        )
        expect(wmWrites.length).toBeGreaterThan(0)
      },
      { timeout: 2000 },
    )

    const lastWrite = [...setMock.mock.calls].reverse().find(([k]) => k === 'mashup_settings')!
    const persisted = lastWrite[1] as UserSettings
    expect(persisted.watermark?.imageRef).toEqual(IMAGE_REF)
    expect(persisted.watermark?.image).toBe(ASSET_URL)
    // The fat data-URL must be gone from the persisted store.
    expect(persisted.watermark?.image).not.toContain('data:image')
  })

  it('does NOT migrate (and does not write) when the watermark is already slim', async () => {
    storeData['mashup_settings'] = {
      ...defaultSettings,
      watermark: { ...legacyWatermark, image: ASSET_URL, imageRef: IMAGE_REF },
    } as Partial<UserSettings>
    shouldMigrateMock.mockReturnValue(false)

    const { result } = renderHook(() => useSettings())
    act(() => { result.current.requestLoad() })
    await waitFor(() => expect(result.current.isSettingsLoaded).toBe(true))
    // Give the (skipped) migration + debounce a chance to (not) fire.
    await new Promise((r) => setTimeout(r, 400))
    expect(migrateMock).not.toHaveBeenCalled()
  })
})
