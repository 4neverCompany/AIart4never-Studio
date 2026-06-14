// @vitest-environment jsdom
/**
 * Regression tests for hooks/useComparison.ts persistence — written as part
 * of the v1.8.1 usePersistentStore migration (the hook had NO wipe test, the
 * V1.4.7-COMPARISON-WIPE guarantee existed only as a code comment).
 *
 * The wipe the V1.4.7 comment described: a Studio mount flips
 * isComparisonLoaded→true while comparisonResults is still [], and the
 * persist effect wrote that [] over the stored comparison library. The
 * migrated hook routes persistence through usePersistentStore, whose
 * dirtyRef gate makes a hydration commit never a write-back.
 *
 * Comparison-specific wiring under test: REPLACE-on-load (a deleted result
 * is not resurrected by a stale in-memory copy), and the writeNow escape
 * hatch for the intentionally-immediate clear/delete writers.
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

import { useComparison } from '@/hooks/useComparison'
import { type GeneratedImage, type UserSettings } from '@/types/mashup'
import { renderHook, act } from '@testing-library/react'

const storedResults: GeneratedImage[] = [
  { id: 'comp-1', url: 'http://x/1.png', prompt: 'p1', status: 'ready', modelInfo: { provider: 'leonardo', modelId: 'm', modelName: 'M' } },
  { id: 'comp-2', url: 'http://x/2.png', prompt: 'p2', status: 'ready', modelInfo: { provider: 'leonardo', modelId: 'm', modelName: 'M' } },
]

const deps = {
  settings: {} as UserSettings,
  saveImage: vi.fn(),
  applyWatermark: vi.fn(async (s: string) => s),
}

describe('useComparison — wipe-vector protection (V1.4.7-COMPARISON-WIPE)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    for (const k of Object.keys(storeData)) delete storeData[k]
    storeData['mashup_comparison_results'] = JSON.parse(JSON.stringify(storedResults))
    getMock.mockClear()
    setMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('Studio mount without an edit never writes [] over the stored results', async () => {
    const { unmount } = renderHook(() => useComparison(deps))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    unmount()
    expect(setMock).not.toHaveBeenCalled()
    expect(storeData['mashup_comparison_results']).toHaveLength(2)
  })

  it('requestLoad hydrates (REPLACE) and a hydration commit is NOT a write-back', async () => {
    const { result } = renderHook(() => useComparison(deps))
    await act(async () => {
      result.current.requestLoad()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(result.current.comparisonResults.map((r) => r.id)).toEqual(['comp-1', 'comp-2'])
    expect(result.current.isComparisonLoaded).toBe(true)
    // The reload-poison the V1.4.7 comment named: loading must not write back.
    expect(setMock).not.toHaveBeenCalled()
  })

  it('clearComparison writes an empty store (explicit immediate full-value write)', async () => {
    const { result } = renderHook(() => useComparison(deps))
    await act(async () => {
      result.current.requestLoad()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    setMock.mockClear()
    await act(async () => {
      result.current.clearComparison()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(setMock).toHaveBeenCalled()
    expect(storeData['mashup_comparison_results']).toEqual([])
    expect(result.current.comparisonResults).toEqual([])
  })

  it('deleteComparisonResult persists the FULL filtered list', async () => {
    const { result } = renderHook(() => useComparison(deps))
    await act(async () => {
      result.current.requestLoad()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    await act(async () => {
      result.current.deleteComparisonResult('comp-1')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    const written = storeData['mashup_comparison_results'] as GeneratedImage[]
    expect(written.map((r) => r.id)).toEqual(['comp-2'])
    expect(result.current.comparisonResults.map((r) => r.id)).toEqual(['comp-2'])
  })
})
