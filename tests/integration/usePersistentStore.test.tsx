// @vitest-environment jsdom
/**
 * Wipe-safety contract for hooks/usePersistentStore.ts — the shared state
 * machine extracted from the five hand-rolled persistence hooks (v1.8.1
 * followup #2). These assertions are the net every migration leans on; they
 * port the invariants from useImages-debounce-wipe.test.tsx and
 * useSettings-wipe.test.tsx onto the abstraction directly.
 *
 * The one invariant under test: a store write fires ONLY when a REAL
 * mutation happened (dirtyRef) AND hydration SUCCEEDED (hydratedOnceRef) AND
 * the load is not in flight. Loading is never a write-back; a failed load
 * never writes; a pre-hydration mutation folds the stored value UNDER it
 * (never overwrites the store with the lone mutation).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePersistentStore } from '@/hooks/usePersistentStore'

interface Item { id: string; v?: number }

// id-union, in-memory PATCH wins — the useImages/useIdeas family.
const mergeById = (loaded: Item[] | null, prev: Item[]): Item[] => {
  const byId = new Map<string, Item>()
  for (const i of loaded ?? []) byId.set(i.id, i)
  for (const i of prev) byId.set(i.id, i)
  return Array.from(byId.values())
}
// REPLACE — the useComparison family.
const replace = (loaded: Item[] | null): Item[] => loaded ?? []

const STORED: Item[] = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }]

function harness(over: Partial<Parameters<typeof usePersistentStore<Item[]>>[0]> = {}) {
  const read = vi.fn(async (_key: string): Promise<Item[] | null> => STORED.map((i) => ({ ...i })))
  const write = vi.fn(async (_key: string, _value: Item[]) => {})
  const opts = { key: 'k', initial: [] as Item[], merge: mergeById, read, write, ...over }
  const view = renderHook(() => usePersistentStore<Item[]>(opts))
  return { ...view, read, write }
}

describe('usePersistentStore — wipe-safety contract', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('bare mount (no requestLoad, no mutation) never reads or writes', async () => {
    const { read, write } = harness()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('requestLoad hydrates but a hydration commit is NOT a write-back', async () => {
    const { result, read, write } = harness()
    await act(async () => { result.current.requestLoad() })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(read).toHaveBeenCalledOnce()
    expect(result.current.value.map((i) => i.id)).toEqual(['a', 'b'])
    expect(write).not.toHaveBeenCalled() // loading is not a mutation
    expect(result.current.isLoaded).toBe(true)
  })

  it('a pre-hydration mutation auto-hydrates and persists stored + new (never new-over-wiped)', async () => {
    const { result, write } = harness()
    await act(async () => { result.current.mutate((prev) => [{ id: 'c', v: 3 }, ...prev]) })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    // memory has the stored two folded under the new one…
    expect(result.current.value.map((i) => i.id).sort()).toEqual(['a', 'b', 'c'])
    // …and the persisted write carries all three (pre-fix it got just 'c').
    expect(write).toHaveBeenCalled()
    const lastWrite = write.mock.calls.at(-1)![1] as Item[]
    expect(lastWrite.map((i) => i.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('a post-hydration mutation persists the merged value', async () => {
    const { result, write } = harness()
    await act(async () => { result.current.requestLoad() })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    write.mockClear()
    await act(async () => { result.current.mutate((prev) => [...prev, { id: 'c', v: 3 }]) })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(write).toHaveBeenCalledOnce()
    expect((write.mock.calls.at(-1)![1] as Item[]).map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('a FAILED hydration never writes, even after a subsequent mutation', async () => {
    const onLoadError = vi.fn()
    const read = vi.fn(async () => { throw new Error('store unreadable') })
    const { result, write } = harness({ read, onLoadError })
    await act(async () => { result.current.requestLoad() })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(onLoadError).toHaveBeenCalled()
    // The intact-but-unreadable store must NOT be overwritten by a mutation.
    await act(async () => { result.current.mutate((prev) => [...prev, { id: 'c', v: 3 }]) })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(write).not.toHaveBeenCalled()
  })

  it('REPLACE merge policy swaps in the loaded value (no resurrection of in-memory)', async () => {
    const { result } = harness({ merge: replace })
    await act(async () => { result.current.requestLoad() })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(result.current.value.map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('debounceMs>0 coalesces rapid mutations into a single write of the final value', async () => {
    const { result, write } = harness({ debounceMs: 200 })
    await act(async () => { result.current.requestLoad() })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    write.mockClear()
    await act(async () => {
      result.current.mutate((prev) => [...prev, { id: 'c' }])
      result.current.mutate((prev) => [...prev, { id: 'd' }])
      result.current.mutate((prev) => [...prev, { id: 'e' }])
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(write).not.toHaveBeenCalled() // still within the debounce window
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(write).toHaveBeenCalledOnce()
    expect((write.mock.calls.at(-1)![1] as Item[]).map((i) => i.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('writeNow performs an immediate full-value write (the clear/delete escape hatch)', async () => {
    const { result, write } = harness()
    await act(async () => { result.current.requestLoad() })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    write.mockClear()
    await act(async () => { result.current.writeNow([]) })
    expect(write).toHaveBeenCalled()
    expect(write.mock.calls[0][1]).toEqual([])
    expect(result.current.value).toEqual([])
  })
})

// Extension points used by the heavier consumers (useImages/useSettings).
// These pin the contract independently of those hooks.
describe('usePersistentStore — extension points', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a custom hydrate() owns the load and bypasses the default read/merge', async () => {
    const read = vi.fn(async () => STORED.map((i) => ({ ...i })))
    const hydrate = vi.fn(async (commit: (u: React.SetStateAction<Item[]>) => void) => {
      commit([{ id: 'fromHydrate' }])
    })
    const { result } = renderHook(() =>
      usePersistentStore<Item[]>({ key: 'k', initial: [], merge: mergeById, read, hydrate }),
    )
    await act(async () => { result.current.requestLoad() })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(hydrate).toHaveBeenCalledOnce()
    expect(read).not.toHaveBeenCalled() // default read path skipped
    expect(result.current.value.map((i) => i.id)).toEqual(['fromHydrate'])
  })

  it('a throwing hydrate() leaves hydratedOnce false → no write + onHydrated not called', async () => {
    const onHydrated = vi.fn()
    const write = vi.fn(async (_k: string, _v: Item[]) => {})
    const hydrate = vi.fn(async () => { throw new Error('boom') })
    const { result } = renderHook(() =>
      usePersistentStore<Item[]>({ key: 'k', initial: [], merge: mergeById, write, hydrate, onHydrated }),
    )
    await act(async () => { result.current.requestLoad() })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(onHydrated).not.toHaveBeenCalled()
    await act(async () => { result.current.mutate((p) => [...p, { id: 'x' }]) })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(write).not.toHaveBeenCalled()
  })

  it('onHydrated fires exactly once on a successful load', async () => {
    const onHydrated = vi.fn()
    const { result } = renderHook(() =>
      usePersistentStore<Item[]>({ key: 'k', initial: [], merge: mergeById, read: async () => [], onHydrated }),
    )
    await act(async () => { result.current.requestLoad() })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(onHydrated).toHaveBeenCalledOnce()
  })

  it('shouldSkipWrite vetoes the debounced write at fire time', async () => {
    const write = vi.fn(async (_k: string, _v: Item[]) => {})
    let skip = false
    const { result } = renderHook(() =>
      usePersistentStore<Item[]>({ key: 'k', initial: [], merge: mergeById, read: async () => [], write, debounceMs: 100, shouldSkipWrite: () => skip }),
    )
    await act(async () => { result.current.requestLoad() })
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    skip = true
    await act(async () => { result.current.mutate((p) => [...p, { id: 'x' }]) })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(write).not.toHaveBeenCalled() // vetoed
    skip = false
    await act(async () => { result.current.mutate((p) => [...p, { id: 'y' }]) })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(write).toHaveBeenCalledOnce() // now allowed
  })

  it('afterWrite fires with the written value after each persist', async () => {
    const afterWrite = vi.fn()
    const { result } = renderHook(() =>
      usePersistentStore<Item[]>({ key: 'k', initial: [], merge: mergeById, read: async () => [], afterWrite }),
    )
    await act(async () => { result.current.requestLoad() })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    await act(async () => { result.current.mutate([{ id: 'z' }]) })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(afterWrite).toHaveBeenCalled()
    expect((afterWrite.mock.calls.at(-1)![0] as Item[]).map((i) => i.id)).toEqual(['z'])
  })

  it('mirror.snapshotOnCleanup writes the snapshot on unmount when dirty+hydrated', async () => {
    const writeSync = vi.fn()
    const { result, unmount } = renderHook(() =>
      usePersistentStore<Item[]>({
        key: 'k', initial: [], merge: mergeById, read: async () => [], debounceMs: 200,
        mirror: { writeSync, shouldFlush: (_v, c) => c.dirty && c.hydratedOnce, snapshotOnCleanup: true },
      }),
    )
    await act(async () => { result.current.requestLoad() })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    // no edit yet → unmount must NOT snapshot (not dirty)
    await act(async () => { result.current.mutate([{ id: 'a' }]) }) // arms dirty; schedules a 200ms write
    unmount() // cleanup runs before the 200ms timer fires
    expect(writeSync).toHaveBeenCalledWith([{ id: 'a' }])
  })

  it('mirror.removeSnapshot fires after a successful canonical write', async () => {
    const removeSnapshot = vi.fn()
    const { result } = renderHook(() =>
      usePersistentStore<Item[]>({
        key: 'k', initial: [], merge: mergeById, read: async () => [], write: async () => {}, debounceMs: 100,
        mirror: { writeSync: vi.fn(), shouldFlush: () => false, removeSnapshot },
      }),
    )
    await act(async () => { result.current.requestLoad() })
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    await act(async () => { result.current.mutate([{ id: 'a' }]) })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(removeSnapshot).toHaveBeenCalled()
  })

  it('mirror.writeSync fires on beforeunload only when shouldFlush approves', async () => {
    const writeSync = vi.fn()
    // shouldFlush mirrors useImages: only a non-empty value flushes.
    const { result } = renderHook(() =>
      usePersistentStore<Item[]>({
        key: 'k', initial: [], merge: mergeById, read: async () => [],
        mirror: { writeSync, shouldFlush: (v) => v.length > 0 },
      }),
    )
    await act(async () => { result.current.requestLoad() })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    // empty → no flush
    act(() => { window.dispatchEvent(new Event('beforeunload')) })
    expect(writeSync).not.toHaveBeenCalled()
    // non-empty → flush
    await act(async () => { result.current.mutate([{ id: 'a' }]) })
    act(() => { window.dispatchEvent(new Event('beforeunload')) })
    expect(writeSync).toHaveBeenCalledWith([{ id: 'a' }])
  })
})
