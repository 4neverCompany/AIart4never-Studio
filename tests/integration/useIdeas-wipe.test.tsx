// @vitest-environment jsdom
/**
 * Regression tests pinning hooks/useIdeas.ts wipe-vector safety BEFORE the
 * usePersistentStore<T> extraction (v1.8.1 followup #2). useIdeas shares
 * the V1.4.7 dirty/in-flight gating with useImages/useSettings/useComparison
 * but is the simplest store-primary variant: a DIRECT (non-debounced) gated
 * `set`, store-under-mutation merge via mergeIdeasById, and NO beforeunload
 * flush / localStorage mirror.
 *
 * The invariants these tests lock (so the refactor can't silently drop one):
 *   1. mount without an edit never writes the store (no flush to poison),
 *   2. hydration alone is not a mutation → no write-back of loaded data,
 *   3. a pre-hydration addIdea auto-hydrates and persists the STORED ideas
 *      folded together with the new one (never the new one over a wiped
 *      store — the BUG-DEV-012 / V1.4.7 class),
 *   4. an edit after hydration persists the full merged list.
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

import { useIdeas } from '@/hooks/useIdeas'
import { type Idea } from '@/types/mashup'
import { renderHook, act } from '@testing-library/react'

const storedIdeas: Idea[] = [
  { id: 'idea-stored-1', concept: 'A stored idea the user already had', createdAt: 1, status: 'idea' },
  { id: 'idea-stored-2', concept: 'Another stored idea', createdAt: 2, status: 'in-work' },
]

describe('useIdeas — wipe-vector protection (pre-refactor pin)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    for (const k of Object.keys(storeData)) delete storeData[k]
    storeData['mashup_ideas'] = JSON.parse(JSON.stringify(storedIdeas))
    getMock.mockClear()
    setMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('Studio mount + unmount without edits never writes the store', async () => {
    const { unmount } = renderHook(() => useIdeas())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    unmount()
    expect(setMock).not.toHaveBeenCalled()
    expect(storeData['mashup_ideas']).toHaveLength(2)
  })

  it('hydration alone never writes the store back (dirty flag)', async () => {
    const { result } = renderHook(() => useIdeas())
    await act(async () => {
      result.current.requestLoad()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(result.current.ideas).toHaveLength(2)
    // Loading is not a mutation — no write-back of the loaded data.
    expect(setMock).not.toHaveBeenCalled()
  })

  it('a pre-hydration addIdea auto-hydrates and persists stored + new (never new-over-wiped)', async () => {
    const { result } = renderHook(() => useIdeas())
    // Add before any Ideas-view visit (no requestLoad yet) — markDirty
    // arms the persist AND flips loadTriggered, so the store hydrates and
    // the new idea folds on top instead of overwriting it.
    await act(async () => {
      result.current.addIdea('A brand new concept')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    // In memory: the two stored ideas survived + the new one is present.
    const concepts = result.current.ideas.map((i) => i.concept)
    expect(result.current.ideas).toHaveLength(3)
    expect(concepts).toContain('A stored idea the user already had')
    expect(concepts).toContain('A brand new concept')
    // Persisted store must hold all three (pre-fix it got just the new one).
    expect(setMock).toHaveBeenCalled()
    const written = storeData['mashup_ideas'] as Idea[]
    expect(written).toHaveLength(3)
    expect(written.map((i) => i.id)).toContain('idea-stored-1')
  })

  it('a FAILED hydration never writes the store, even after a mutation (v1.8.1 hardening)', async () => {
    // Pre-extraction useIdeas had a bare catch{} and no hydration-fail
    // latch: a thrown get() then a mutation wrote [thatOneIdea] over the
    // intact-but-unreadable store. The usePersistentStore hydratedOnceRef
    // gate closes this — a failed load refuses all writes for the session.
    getMock.mockRejectedValueOnce(new Error('store unreadable'))
    const { result } = renderHook(() => useIdeas())
    await act(async () => {
      result.current.addIdea('Edit after a failed load')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(setMock).not.toHaveBeenCalled()
    // The (unreadable here, but intact on disk) store is untouched.
    expect(storeData['mashup_ideas']).toHaveLength(2)
  })

  it('an edit after hydration persists the full merged list', async () => {
    const { result } = renderHook(() => useIdeas())
    await act(async () => {
      result.current.requestLoad()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    await act(async () => {
      result.current.updateIdeaStatus('idea-stored-1', 'done')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    const written = storeData['mashup_ideas'] as Idea[]
    expect(written).toHaveLength(2)
    expect(written.find((i) => i.id === 'idea-stored-1')?.status).toBe('done')
    expect(written.find((i) => i.id === 'idea-stored-2')?.status).toBe('in-work')
  })
})
