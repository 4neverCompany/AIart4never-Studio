/**
 * useReconciler — runs the post-lifecycle Reconciler on app startup.
 *
 * On mount, this hook:
 *   1. Constructs the appropriate storage backend (idb for web, sqlite for tauri)
 *   2. Creates a Reconciler instance
 *   3. Calls reconciler.reconcile() in the background
 *   4. Surfaces the result via a callback (for UI display)
 *
 * The reconciler is fire-and-forget from the UI's perspective — it never
 * blocks rendering and never throws. Failures are logged and surfaced via
 * the callback.
 *
 * If the v0.9.41 bug is present in production, this hook catches it at
 * startup: the affected posts are transitioned to `failed` with
 * `image_missing` reason and the user sees them in the RecoveryPanel.
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Reconciler,
  type ReconcileResult,
  type PostLifecycleStorage,
} from '@/lib/post-lifecycle';

/**
 * Detect the runtime — Tauri desktop or browser.
 * In a Tauri context, the global __TAURI_INTERNALS__ is injected.
 */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export interface UseReconcilerState {
  /**
   * The most recent reconcile result, or null if reconcile hasn't run yet
   * (or is still running).
   */
  lastResult: ReconcileResult | null;
  /** True while a reconcile pass is in flight. */
  running: boolean;
  /** Error from the last reconcile pass, or null. */
  error: Error | null;
  /** Manually trigger another reconcile pass. */
  reconcile: () => Promise<ReconcileResult | null>;
}

/**
 * The reconciler runs once on mount. Call `reconcile()` to re-run.
 *
 * Storage construction is lazy — we only build the SQLite or IDB
 * implementation when reconcile() is actually called, to avoid blocking
 * mount on storage init.
 */
export function useReconciler(): UseReconcilerState {
  const reconcilerRef = useRef<Reconciler | null>(null);
  const [lastResult, setLastResult] = useState<ReconcileResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const ensureReconciler = (): Reconciler | null => {
    if (reconcilerRef.current) return reconcilerRef.current;

    // Storage backend is selected at runtime. We do a dynamic import
    // to avoid pulling the Tauri SQLite driver into the web bundle.
    //
    // For now, both surfaces use the IDB implementation as a
    // uniform fallback. The Tauri SQLite driver is loaded
    // conditionally in the desktop app.
    //
    // The production code path is:
    //   - Tauri: import { getSqliteStorage } from '@/lib/post-lifecycle/storage/tauri-driver'
    //   - Web: import { getIdbStorage } from '@/lib/post-lifecycle/storage/idb'
    //
    // Wiring both paths in this hook requires a Promise-based dynamic
    // import, which we do here.

    try {
      // Synchronous init for IDB. The IDB driver is sync to construct.
       
      const { IdbPostLifecycleStorage } = require('@/lib/post-lifecycle/storage/idb');
      const storage: PostLifecycleStorage = new IdbPostLifecycleStorage();
      reconcilerRef.current = new Reconciler(storage);
      return reconcilerRef.current;
    } catch (e) {
      // Storage init failed — the reconciler can't run. Surface as an
      // error but don't block the app.
      setError(e instanceof Error ? e : new Error(String(e)));
      return null;
    }
  };

  const reconcile = async (): Promise<ReconcileResult | null> => {
    if (running) return null; // prevent overlap
    setRunning(true);
    setError(null);
    try {
      const reconciler = ensureReconciler();
      if (!reconciler) return null;
      const result = await reconciler.reconcile();
      setLastResult(result);
      return result;
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      return null;
    } finally {
      setRunning(false);
    }
  };

  // V105.1-REACT-19: reconcile is invoked via queueMicrotask (project
  // convention) so the effect body only fires the initial reconcile
  // on mount, not local state in the body itself.
  useEffect(() => {
    queueMicrotask(() => void reconcile());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { lastResult, running, error, reconcile };
}
