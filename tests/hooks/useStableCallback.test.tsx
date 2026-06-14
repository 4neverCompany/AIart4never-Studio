/**
 * M3.1 (V1.8): useStableCallback / useStableCallbacks — the identity
 * contract that GalleryCard's React.memo and MashupContext's value
 * memo rely on. Pins:
 *   - the returned identity NEVER changes across re-renders;
 *   - calls always dispatch to the LATEST implementation (no stale
 *     closures);
 *   - the bag variant preserves keys, arguments, and return values.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStableCallback, useStableCallbacks } from '@/hooks/useStableCallback';

describe('useStableCallback', () => {
  it('returns the same identity across re-renders', () => {
    const { result, rerender } = renderHook(
      ({ fn }) => useStableCallback(fn),
      { initialProps: { fn: (() => 1) as () => number } },
    );
    const first = result.current;
    rerender({ fn: () => 2 });
    expect(result.current).toBe(first);
  });

  it('dispatches to the latest implementation', () => {
    const { result, rerender } = renderHook(
      ({ fn }) => useStableCallback(fn),
      { initialProps: { fn: (() => 'old') as () => string } },
    );
    expect(result.current()).toBe('old');
    rerender({ fn: () => 'new' });
    expect(result.current()).toBe('new');
  });

  it('forwards arguments and return values', () => {
    const impl = vi.fn((a: number, b: number) => a + b);
    const { result } = renderHook(() => useStableCallback(impl));
    expect(result.current(2, 3)).toBe(5);
    expect(impl).toHaveBeenCalledWith(2, 3);
  });
});

describe('useStableCallbacks (bag variant)', () => {
  it('keeps every key identity stable while dispatching to the latest impls', () => {
    const { result, rerender } = renderHook(
      ({ n }) =>
        useStableCallbacks({
          getN: () => n,
          double: (x: number) => x * 2 + n,
        }),
      { initialProps: { n: 1 } },
    );
    const firstBag = result.current;
    expect(firstBag.getN()).toBe(1);
    expect(firstBag.double(10)).toBe(21);

    rerender({ n: 5 });
    // Same object, same function identities…
    expect(result.current).toBe(firstBag);
    expect(result.current.getN).toBe(firstBag.getN);
    // …but the latest closure values.
    expect(result.current.getN()).toBe(5);
    expect(result.current.double(10)).toBe(25);
  });

  it('preserves the full key set', () => {
    const { result } = renderHook(() =>
      useStableCallbacks({ a: () => 1, b: () => 2, c: () => 3 }),
    );
    expect(Object.keys(result.current).sort()).toEqual(['a', 'b', 'c']);
  });
});
