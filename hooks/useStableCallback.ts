'use client';

/**
 * M3.1 (V1.8): identity-stable event-callback helpers.
 *
 * The render-perf problem: MashupContext's value object — and most
 * handler props below it — were re-created on every provider render,
 * so `React.memo` on expensive children (GalleryCard) could never
 * bail out and every pipeline tick re-rendered the whole tree.
 * Stabilizing every source hook with `useCallback` would mean
 * threading exhaustive dep lists through ~7 large hooks; instead we
 * stabilize at the boundary with the classic "useEvent" pattern: a
 * ref always holds the LATEST implementation, while the function
 * identity handed out never changes.
 *
 * Semantics (same as React's experimental `useEffectEvent` /
 * ahooks' `useMemoizedFn`):
 *   - The returned function is referentially stable for the lifetime
 *     of the component.
 *   - Calling it invokes the implementation from the most recent
 *     committed render (no stale closures).
 *   - NOT for functions called during render — event handlers,
 *     effects, and async flows only. (A render-phase call could
 *     observe the previous render's implementation.)
 *   - Caution for useLayoutEffect callers: layout effects flush
 *     child-first, so a DESCENDANT's layout effect that calls a
 *     wrapper during the same commit as a provider re-render sees
 *     the previous commit's implementation (the provider's layout
 *     effect hasn't refreshed the ref yet). No current consumer does
 *     this (verified 2026-06-11); prefer useEffect for such calls.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// Next.js renders 'use client' components on the server too;
// useLayoutEffect there logs a warning. The standard isomorphic
// fallback is fine because on the server nothing ever fires events.
const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Stable-identity wrapper for a single callback. The wrapper always
 * dispatches to the latest implementation.
 *
 * Implementation note: the stable identity comes from a `useState`
 * lazy initializer (runs exactly once, identity guaranteed for the
 * component's lifetime) rather than `useCallback([])` — the repo's
 * react-hooks lint config forbids both non-inline useCallback args
 * and ref reads during render, and useMemo's cache is allowed to be
 * discarded by React, which would break the identity GUARANTEE this
 * module exists to provide. The wrapper only dereferences the ref at
 * call time (event/effect phase), never during render.
 */
 
export function useStableCallback<T extends (...args: any[]) => any>(fn: T): T {
  const implRef = useRef(fn);
  useIsomorphicLayoutEffect(() => {
    implRef.current = fn;
  });
  const [stable] = useState(
    () => ((...args: Parameters<T>) => implRef.current(...args)) as T,
  );
  return stable;
}

/**
 * Stable-identity wrapper for a BAG of callbacks (the MashupContext
 * case: ~40 function fields in one object). Returns an object with
 * the same keys whose function identities never change.
 *
 * The key set is fixed on the first render — keys added on later
 * renders are ignored (and undefined-at-first-render keys would
 * throw when called). Pass the complete bag from render one.
 */
 
export function useStableCallbacks<T extends Record<string, (...args: any[]) => any>>(
  fns: T,
): T {
  const implRef = useRef(fns);
  useIsomorphicLayoutEffect(() => {
    implRef.current = fns;
  });

  const [stable] = useState(() => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(fns)) {
      out[key] = (...args: unknown[]) =>
        (implRef.current as Record<string, (...a: unknown[]) => unknown>)[key](...args);
    }
    return out as T;
  });
  return stable;
}
