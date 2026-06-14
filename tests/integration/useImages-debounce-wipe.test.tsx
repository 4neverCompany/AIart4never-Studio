/**
 * Regression tests for the V1.4.5 data-loss ROOT-CAUSE fix in
 * hooks/useImages.ts — the debounced direct store-write.
 *
 * The bug (present v1.2.5 → v1.4.4): the 200ms-debounced
 * `set('mashup_saved_images', savedImages)` effect was gated ONLY on
 * `isImagesLoaded`, which the !loadTriggered branch sets to true
 * immediately on Studio mount while `savedImages` is still `[]`.
 * Consequences:
 *
 *   1. Studio mount without a Gallery visit → 200ms later the effect
 *      wrote `[]` into the Tauri store, wiping the full library.
 *   2. A Studio-side `saveImage()` (pipeline / useIdeaProcessor)
 *      without a Gallery visit → the effect wrote `[that one image]`
 *      over the full library.
 *
 * All previous fixes (v1.2.7 gate, v1.2.8 merge-on-load, v1.4.4
 * empty-guard in the beforeunload flush) only patched the
 * localStorage path; this direct store-write path was untouched.
 *
 * The fix under test:
 *   - debounce write additionally gated on `loadTriggered` and a
 *     dirty flag (only real mutations arm it, not hydration commits)
 *   - mutations made before hydration auto-trigger the load, and the
 *     load path merges store data UNDER in-memory mutations
 *     (mergeById, in-memory wins), so the eventual write-back
 *     contains the FULL library plus the mutation.
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

vi.mock('@/lib/backup/images', () => ({
  autoBackupImages: vi.fn(async () => undefined),
}))

import { useImages } from '@/hooks/useImages'
import { renderHook, act } from '@testing-library/react'
import { type GeneratedImage } from '@/types/mashup'

const img = (id: string): GeneratedImage =>
  ({
    id,
    url: `https://cdn.example/${id}.jpg`,
    prompt: 'p',
    status: 'ready',
    savedAt: 1000,
  } as GeneratedImage)

const libraryInStore = [img('img-a'), img('img-b'), img('img-c')]

describe('useImages — V1.4.5 debounce-write wipe protection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    for (const k of Object.keys(storeData)) delete storeData[k]
    storeData['mashup_saved_images'] = [...libraryInStore]
    getMock.mockClear()
    setMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('Studio mount without Gallery visit never writes [] to the store', async () => {
    renderHook(() => useImages())
    // The old code wrote `[]` 200ms after mount. Give it ample time.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(setMock).not.toHaveBeenCalled()
    expect(storeData['mashup_saved_images']).toEqual(libraryInStore)
  })

  it('hydration via requestLoad does not write the store back (dirty flag)', async () => {
    const { result } = renderHook(() => useImages())
    await act(async () => {
      result.current.requestLoad()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    // Loading is not a mutation — no write-back of the loaded data.
    expect(setMock).not.toHaveBeenCalled()
    expect(result.current.savedImages).toHaveLength(3)
  })

  it('Studio saveImage without Gallery visit writes the FULL merged library, not [1 image]', async () => {
    const { result } = renderHook(() => useImages())
    await act(async () => {
      result.current.saveImage(img('img-new'))
    })
    // saveImage auto-triggers the store load; let the async load and
    // the 200ms debounce both run.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(setMock).toHaveBeenCalled()
    const written = storeData['mashup_saved_images'] as GeneratedImage[]
    const ids = written.map(i => i.id).sort()
    // The old code wrote `['img-new']` — wiping a, b, c.
    expect(ids).toEqual(['img-a', 'img-b', 'img-c', 'img-new'])
  })

  it('mutation after a completed load persists (no over-gating regression)', async () => {
    const { result } = renderHook(() => useImages())
    await act(async () => {
      result.current.requestLoad()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(result.current.savedImages).toHaveLength(3)
    await act(async () => {
      result.current.deleteImage('img-b', true)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    const written = storeData['mashup_saved_images'] as GeneratedImage[]
    expect(written.map(i => i.id).sort()).toEqual(['img-a', 'img-c'])
  })

  it('hydration FAILURE never lets a mutation overwrite the store (V1.4.5-HYDRATION-FAIL)', async () => {
    // The store read throws (IDB unavailable / corrupted) — distinct
    // from "store is empty". A mutation after the failed load must NOT
    // arm the debounced store-write: the in-memory array is missing
    // the (possibly intact) library, so writing it back would wipe.
    getMock.mockImplementationOnce(async () => {
      throw new Error('IDB unavailable')
    })
    const { result } = renderHook(() => useImages())
    await act(async () => {
      result.current.requestLoad()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    // Hydration failed silently — memory is empty, store untouched.
    expect(result.current.savedImages).toHaveLength(0)
    await act(async () => {
      result.current.saveImage(img('img-new'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    // Without the latch the debounce would write ['img-new'] over the
    // full library. The store must remain intact.
    expect(setMock).not.toHaveBeenCalled()
    expect(storeData['mashup_saved_images']).toEqual(libraryInStore)
    // The mutation itself is still preserved in memory (and reaches
    // localStorage via the beforeunload flush path).
    expect(result.current.savedImages.map(i => i.id)).toEqual(['img-new'])
  })

  it('hydration FAILURE on the localStorage-present path ALSO never overwrites the store', async () => {
    // Coverage for the inner-fallback / non-empty-branch store-read throw
    // (the original + migrated only had a test for the no-localStorage
    // else-branch throw). localStorage HAS a value, so the load enters the
    // non-empty branch: the store read throws → the inner catch retries
    // get() → that throws too → it must PROPAGATE out of the load so
    // hydratedOnce stays false and the persist gate stays shut. A future
    // edit that swallowed either get() here would silently re-open
    // V1.4.5-HYDRATION-FAIL — this test catches that.
    localStorage.setItem('mashup_saved_images', JSON.stringify([img('ls-x')]))
    getMock.mockImplementation(async () => { throw new Error('IDB unavailable') })
    const { result } = renderHook(() => useImages())
    await act(async () => {
      result.current.requestLoad()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    await act(async () => {
      result.current.saveImage(img('img-new'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    // The store must be untouched — no write of the lone in-memory mutation.
    expect(setMock).not.toHaveBeenCalled()
    expect(storeData['mashup_saved_images']).toEqual(libraryInStore)
  })

  it('in-memory mutation made during an in-flight load survives the hydration commit', async () => {
    // Slow down the store read so the mutation lands mid-load.
    let release: (v: unknown) => void = () => {}
    getMock.mockImplementationOnce(
      () => new Promise(res => { release = () => res([...libraryInStore]) }),
    )
    const { result } = renderHook(() => useImages())
    await act(async () => {
      result.current.saveImage(img('img-new')) // triggers load; get() hangs
    })
    expect(result.current.savedImages.map(i => i.id)).toEqual(['img-new'])
    await act(async () => {
      release(null) // store data arrives AFTER the mutation
      await vi.advanceTimersByTimeAsync(1000)
    })
    const ids = result.current.savedImages.map(i => i.id).sort()
    expect(ids).toEqual(['img-a', 'img-b', 'img-c', 'img-new'])
  })
})
