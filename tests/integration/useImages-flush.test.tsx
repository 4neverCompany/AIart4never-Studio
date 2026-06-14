// @vitest-environment jsdom
//
// BUG-CRIT-006 / BUG-DES-002 / V1.2.7-HOTFIX / V1.4.4-DATALOSS-FIX:
// useImages flush-on-unload safety net.
//
// Bug (v1.2.5): useImages persists savedImages with a 200ms
// debounce. A manual Post Now (postedAt/postError patch) that
// lands <200ms before the user reloads loses the IDB write —
// the badge "resets on reload."
//
// Fix (v1.2.5): hooks/useImages.ts adds a `beforeunload`
// listener that synchronously writes the latest savedImages
// to localStorage.
//
// New bug (v1.2.7-HOTFIX): the listener was registered as
// soon as `isImagesLoaded` flipped to `true`, which happens
// immediately on mount BEFORE the actual store-load runs.
// On the next page navigation (e.g. OAuth "Connect Higgsfield"
// redirect), the listener fired with the initial in-memory
// `[]` state and wrote that empty value to localStorage.
// The next page's load effect found the empty array and
// clobbered the store with `[]` — wiping the user's images.
//
// Fix (v1.2.7-HOTFIX): gate the listener on `loadTriggered`.
//
// New bug (v1.4.4): the `loadTriggered` gate ALSO killed the
// safety net for the common case — user generates an image in
// Studio (never visits the Gallery, so requestLoad() never
// fires), closes the app within the 200ms debounce window, the
// image is lost.
//
// Fix (V1.4.4-DATALOSS-FIX): the listener is registered
// UNCONDITIONALLY, but the flush function refuses to write an
// empty array. Both protections hold:
//   - Empty state never pollutes localStorage (v1.2.5 / v1.2.7
//     clobber protection)
//   - Any non-empty state survives shutdown (v1.4.4 fix)
//
// This test pins the v1.4.4 contract so a future refactor can't
// silently re-introduce either data-loss bug.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useImages } from '@/hooks/useImages';

// Mock idb-keyval so the hook doesn't try to hit a real IDB
// during the test. The flush path doesn't touch IDB anyway
// (it writes to localStorage), but the load path calls `get`
// on mount.
vi.mock('idb-keyval', () => ({
  get: vi.fn().mockResolvedValue(undefined),
  set: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  localStorage.clear();
  cleanup();
});

afterEach(() => {
  localStorage.clear();
});

describe('V1.4.4-DATALOSS-FIX — beforeunload flush is unconditional but refuses empty state', () => {
  it('registers the beforeunload listener on mount (no loadTriggered gate)', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');

    renderHook(() => useImages());
    await act(async () => {
      await Promise.resolve();
    });

    const beforeunloadCalls = addSpy.mock.calls.filter(([type]) => type === 'beforeunload');
    expect(beforeunloadCalls.length).toBe(1);

    addSpy.mockRestore();
  });

  it('flush with empty state writes NOTHING (v1.2.5/v1.2.7 clobber protection)', async () => {
    renderHook(() => useImages());
    await act(async () => {
      await Promise.resolve();
    });

    // No images saved, no requestLoad — the OAuth-redirect
    // scenario that wiped stores in v1.2.5. The listener is
    // active, but firing it must not write the in-memory `[]`.
    act(() => {
      window.dispatchEvent(new Event('beforeunload'));
    });

    expect(localStorage.getItem('mashup_saved_images')).toBeNull();
  });

  it('flush preserves a non-empty state even WITHOUT requestLoad (the v1.4.4 Studio scenario)', async () => {
    const { result } = renderHook(() => useImages());
    await act(async () => {
      await Promise.resolve();
    });

    // User generates an image in Studio — saveImage fires, but the
    // Gallery (and therefore requestLoad()) was never visited.
    act(() => {
      result.current.saveImage({
        id: 'img-studio-1',
        prompt: 'studio test',
        url: 'https://example.test/s.png',
      });
    });
    expect(result.current.savedImages).toHaveLength(1);

    // App closes within the 200ms debounce window.
    act(() => {
      window.dispatchEvent(new Event('beforeunload'));
    });

    const persisted = localStorage.getItem('mashup_saved_images');
    expect(persisted).not.toBeNull();
    const parsed = JSON.parse(persisted!) as Array<{ id: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.id).toBe('img-studio-1');
  });

  it('writes savedImages to localStorage when beforeunload fires (after requestLoad)', async () => {
    const { result } = renderHook(() => useImages());
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      result.current.requestLoad();
    });
    await vi.waitFor(() => expect(result.current.isImagesLoaded).toBe(true));

    act(() => {
      result.current.saveImage({
        id: 'img-flush-1',
        prompt: 'flush test',
        url: 'https://example.test/x.png',
        postedAt: 1234567890,
      });
    });

    // Sanity: the image is in state.
    expect(result.current.savedImages).toHaveLength(1);
    expect(result.current.savedImages[0]!.id).toBe('img-flush-1');
    expect(result.current.savedImages[0]!.postedAt).toBe(1234567890);

    // localStorage should be empty BEFORE beforeunload fires —
    // the 200ms debounce hasn't elapsed and the flush is the
    // only sync path to localStorage.
    expect(localStorage.getItem('mashup_saved_images')).toBeNull();

    // Fire beforeunload.
    act(() => {
      window.dispatchEvent(new Event('beforeunload'));
    });

    // The flush should have written the latest savedImages.
    const persisted = localStorage.getItem('mashup_saved_images');
    expect(persisted).not.toBeNull();
    const parsed = JSON.parse(persisted!) as Array<{ id: string; postedAt?: number }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.id).toBe('img-flush-1');
    expect(parsed[0]!.postedAt).toBe(1234567890);
  });

  it('flush always writes the latest value (savedImagesRef pattern)', async () => {
    const { result } = renderHook(() => useImages());
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      result.current.requestLoad();
    });
    await vi.waitFor(() => expect(result.current.isImagesLoaded).toBe(true));

    act(() => {
      result.current.saveImage({
        id: 'a',
        prompt: 'p',
        url: 'https://example.test/a.png',
      });
    });
    act(() => {
      result.current.saveImage({
        id: 'b',
        prompt: 'p',
        url: 'https://example.test/b.png',
      });
    });

    act(() => {
      window.dispatchEvent(new Event('beforeunload'));
    });

    const parsed = JSON.parse(localStorage.getItem('mashup_saved_images')!) as Array<{ id: string }>;
    const ids = parsed.map((p) => p.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });
});
