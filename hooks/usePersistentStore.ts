'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
// BUG-DEV-012: persistence goes through `@/lib/persistence` (Tauri plugin-
// store in prod, idb-keyval fallback off-Tauri). Keys are unchanged so the
// migration runner in persistence.ts still detects pre-fix IDB values.
import { get as defaultGet, set as defaultSet } from '@/lib/persistence';

/**
 * usePersistentStore — the shared, wipe-safe persistence state machine that
 * useImages / useSettings / useComparison / useIdeas / useCollections each
 * hand-rolled (and that a missing gate in any one silently wiped user data:
 * the v1.2.5→v1.4.4 "images gone" reports, the V1.4.7 reload-wipe, the
 * V1.8.1 watermark-migration bug). Extracting the gating ONCE means the
 * fix can never again be present in four hooks and absent in the fifth.
 *
 * THE NON-NEGOTIABLE INVARIANT (the entire BUG-DEV-012 / reload-wipe
 * defense, enforced in this ONE place): the persist effect may only write
 * the store when ALL of these hold —
 *   - loadTriggered            → hydration has been (or is being) requested
 *   - isLoaded                 → hydration actually FINISHED (gate re-closes
 *                                synchronously while a real load is running)
 *   - dirtyRef.current         → a REAL mutation happened (a hydration commit
 *                                NEVER arms this), so loading can't write back
 *                                its own result or the initial value
 *   - hydratedOnceRef.current  → hydration SUCCEEDED (not merely "finished") —
 *                                a thrown load leaves this false so a later
 *                                mutation can't overwrite the intact-but-
 *                                unreadable store with just that mutation
 * plus an in-timer re-check of loadInFlightRef for the debounced path, so a
 * timer that survives React's effect-cleanup still refuses to fire mid-load.
 *
 * This is the LEAN core: it carries exactly what the two cleanest consumers
 * (useIdeas, useComparison) need — a required per-store `merge` policy, an
 * optional `migrateOnLoad` value-shape transform, a 0-or-N-ms write cadence,
 * a `writeNow` escape hatch for intentionally-immediate full-value writes,
 * and save-state callbacks. The heavier consumers (useImages' localStorage
 * mirror + disk-offload, useSettings' pendingOps replay + marker-pair guard,
 * useCollections' inverse-safety model) are deliberately NOT folded in here
 * yet — they need additional, separately-tested extension points (an opt-in
 * MirrorAdapter, a write-during-load consolidation hook) and live as bespoke
 * hooks until those are added under their own regression nets. See the
 * v1.8.1 followup design doc for the full migration order.
 */
export interface PersistentStoreOptions<T> {
  /** The persistence key (also the IDB key the migration runner keys off). */
  key: string;
  /** Initial in-memory value before hydration (e.g. [] or defaultSettings). */
  initial: T;
  /**
   * Per-store merge policy for the DEFAULT load path. REQUIRED unless a
   * custom `hydrate` is provided (which owns the load and ignores `merge`).
   * Folds the freshly-loaded store value
   * together with any in-memory mutations made before hydration finished.
   * The merge families MUST stay distinct per hook and CANNOT be one-size:
   *   - id-union, in-memory PATCH wins (useImages/useIdeas) — the loaded
   *     store folds UNDER a pre-hydration mutation (a Studio image saved
   *     before the Gallery was ever opened survives).
   *   - REPLACE (useComparison) — `(_loaded, prev) => loaded ?? prev` style
   *     is wrong; comparison wants `(loaded) => loaded ?? []` so a deleted
   *     result is not resurrected by a stale in-memory copy.
   * Baking any single policy into the core re-opens V1.4.5 (replace would
   * drop the pre-hydration image) or changes another hook's semantics.
   */
  merge?: (loaded: T | null, prev: T) => T;
  /**
   * Optional value-shape transform applied to the loaded payload on EVERY
   * hydration, before the merge commit (e.g. normalizeOnLoad's tag rewrite +
   * transient-status reset). Identity by default.
   */
  migrateOnLoad?: (loaded: T) => T;
  /**
   * Write cadence. 0 (default) => write synchronously inside the persist
   * effect (useIdeas / useComparison's immediate `set`). >0 => coalesce
   * rapid mutations into one write N ms after the last change (useImages 200,
   * useSettings 300), with the in-timer loadInFlight re-check.
   */
  debounceMs?: number;
  /** Store read. Default: `get(key)` from @/lib/persistence. */
  read?: (key: string) => Promise<T | null>;
  /** Store write. Default: `set(key, value)` from @/lib/persistence. */
  write?: (key: string, value: T) => Promise<void>;
  /** Fired when a debounced write is scheduled (save-state surfacing). */
  onSaving?: () => void;
  /** Fired after a canonical store write resolves. */
  onSaved?: () => void;
  /** Fired if a canonical store write rejects. */
  onSaveError?: (e: unknown) => void;
  /** Fired if hydration throws (surface a load-error pill). */
  onLoadError?: (e: unknown) => void;
  /**
   * Fired exactly once after a SUCCESSFUL hydration (right after
   * hydratedOnceRef flips true). A reactive success signal for consumers
   * whose post-hydration effects must NOT run after a failed load (e.g.
   * useImages' once-per-session slim migration) — flip a state flag here and
   * gate the effect on it, instead of reading hydratedOnceRef during render.
   */
  onHydrated?: () => void;

  // ── Extension points for the heavier consumers (useImages/useSettings) ──
  // All optional; omitting every one of them gives the exact lean path that
  // useIdeas/useComparison use (read → migrateOnLoad → merge, gated write,
  // no mirror). These let a hook keep its irreducibly-bespoke logic in the
  // hook while still sharing the wipe-safe gate state machine.

  /**
   * Custom load override. When provided, FULLY owns hydration: it reads the
   * source(s) (store + any localStorage patch), performs any consolidation
   * write-back, and commits the value via the cancellation-guarded `commit`
   * setter. The store still owns the gates around it (loadTriggered /
   * isLoaded / loadInFlightRef) and flips hydratedOnceRef true IFF this
   * resolves WITHOUT throwing — so a bespoke load MUST throw on a real
   * hydration failure (never swallow it) to keep the persist gate closed.
   * Use this instead of forcing marker-pair guards / migrations / pendingOps
   * replay through the generic `merge` signature. When omitted, the default
   * `read → migrateOnLoad → merge` path runs.
   */
  hydrate?: (commit: (updater: React.SetStateAction<T>) => void) => Promise<void>;
  /**
   * In-timer veto for the debounced write, re-checked at fire time AFTER the
   * loadInFlight/hydratedOnce gates (e.g. useImages' migratingRef: suppress
   * store writes while the once-per-session slim migration walks the array).
   */
  shouldSkipWrite?: () => boolean;
  /**
   * Fired synchronously right after a canonical store write is INITIATED
   * (not awaited) — e.g. useImages' autoBackupImages. Receives the value
   * that was written.
   */
  afterWrite?: (value: T) => void;
  /** Opt-in localStorage crash-recovery mirror (beforeunload flush). */
  mirror?: MirrorAdapter<T>;
}

/**
 * Optional localStorage crash-recovery mirror. Strictly opt-in: hooks without
 * one (useIdeas/useComparison) get no localStorage write and no beforeunload
 * listener. The store NEVER auto-adds this — adding a mirror to a hook that
 * never had one manufactures a brand-new wipe surface unless shouldFlush is
 * gated correctly. The load-side consume of the mirror lives in the hook's
 * `hydrate` callback (it's part of the bespoke load), so this adapter only
 * covers the WRITE side (the beforeunload snapshot).
 */
export interface MirrorAdapter<T> {
  /** Synchronous localStorage write of the crash-recovery snapshot. */
  writeSync: (value: T) => void;
  /**
   * Gate: should the beforeunload flush actually write? Receives the value
   * and the live gate context. useImages uses `(v) => v.length > 0` (the
   * empty-array short-circuit — register unconditionally, never write []).
   * useSettings uses `(_v, c) => c.dirty && c.hydratedOnce`.
   */
  shouldFlush: (
    value: T,
    ctx: { dirty: boolean; hydratedOnce: boolean; loadInFlight: boolean },
  ) => boolean;
  // NOTE: the listener is registered UNCONDITIONALLY on mount (matching
  // useImages' V1.4.4 fix). There is intentionally no registerWhen gate —
  // `shouldFlush` is the single fire-time gate, and it already subsumes any
  // "is the store loaded" condition (e.g. useSettings' `dirty && hydratedOnce`
  // can only be true after a successful load). A registered-but-inert
  // listener is observationally identical to an unregistered one.

  /**
   * When true, the debounced-write effect's CLEANUP also writes the snapshot
   * (the V1.2.5-HOTFIX soft-nav safety net: an unmount/dep-change before the
   * debounce fires leaves a localStorage snapshot the next load migrates).
   * Gated by the SAME `shouldFlush` PLUS an implicit `!loadInFlight` (the
   * store adds it). useImages omits this (beforeunload only); useSettings
   * sets it.
   */
  snapshotOnCleanup?: boolean;
  /**
   * Called after a SUCCESSFUL canonical store write resolves — the mirror's
   * chance to drop its now-superseded localStorage snapshot (useSettings'
   * V1.6 removeItem, so a stale one-commit-old snapshot can never outrank the
   * just-persisted state on the next load). The mirror owns the key.
   */
  removeSnapshot?: () => void;
}

export interface PersistentStore<T> {
  /** Current in-memory value. */
  value: T;
  /**
   * Raw state setter — does NOT arm the dirty flag. Use AFTER markDirty()
   * for a burst of updates that should coalesce into one persist (e.g.
   * comparison placeholders + per-model results all under one markDirty).
   */
  setValue: React.Dispatch<React.SetStateAction<T>>;
  /** markDirty() + setValue(updater): the common single-mutation path. */
  mutate: (updater: React.SetStateAction<T>) => void;
  /**
   * Arm the dirty flag AND force hydration. Coupling "a mutation happened"
   * with "hydrate NOW" is what makes the eventual write hold the FULL merged
   * value instead of the lone mutation. Exposed for bespoke effects (e.g. a
   * migration that patches `value` and must arm the persist).
   */
  markDirty: () => void;
  /**
   * Ungated imperative write of a FULL value (never a partial/defaults
   * snapshot). For intentionally-immediate writers like clear/delete: the
   * value is complete, so bypassing the dirty/hydration gate is safe. Also
   * arms dirtyRef so the persist effect won't double-fight it.
   */
  writeNow: (value: T) => void;
  /** Public "hydration finished" flag (drives splash/gating in callers). */
  isLoaded: boolean;
  /** Start (lazy) hydration — called by the view that needs the data. */
  requestLoad: () => void;
  /** Commit-phase mirror of `value` for sync reads (flush/migration). */
  valueRef: React.MutableRefObject<T>;
  /** "Hydration SUCCEEDED" — for bespoke effects that must gate on it. */
  hydratedOnceRef: React.MutableRefObject<boolean>;
}

export function usePersistentStore<T>(
  opts: PersistentStoreOptions<T>,
): PersistentStore<T> {
  const {
    key,
    initial,
    merge,
    migrateOnLoad,
    debounceMs = 0,
    read = defaultGet as (k: string) => Promise<T | null>,
    write = defaultSet as (k: string, v: T) => Promise<void>,
    onSaving,
    onSaved,
    onSaveError,
    onLoadError,
    onHydrated,
    hydrate,
    shouldSkipWrite,
    afterWrite,
    mirror,
  } = opts;

  const [value, setValue] = useState<T>(initial);
  const [isLoaded, setIsLoaded] = useState(false);
  // V1.2.1 lazy-load gate: bare mount does no I/O; the view that needs the
  // data calls requestLoad(), and any real mutation forces it via markDirty.
  const [loadTriggered, setLoadTriggered] = useState(false);

  // V1.4.5/V1.4.7 gates — see the invariant in the file docblock.
  const dirtyRef = useRef(false);
  const loadInFlightRef = useRef(false);
  const hydratedOnceRef = useRef(false);

  // V105.1-REACT-19: mirror state into a ref AFTER commit (never during
  // render) so the debounce timer / bespoke effects read the latest value.
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setLoadTriggered(true);
  }, []);

  const mutate = useCallback(
    (updater: React.SetStateAction<T>) => {
      markDirty();
      setValue(updater);
    },
    [markDirty],
  );

  const requestLoad = useCallback(() => setLoadTriggered(true), []);

  // Stable option refs so the load/persist effects don't re-fire when the
  // caller passes fresh closures each render (callers routinely do).
  const cfg = useRef({ merge, migrateOnLoad, read, write, onSaving, onSaved, onSaveError, onLoadError, onHydrated, hydrate, shouldSkipWrite, afterWrite, mirror });
  useEffect(() => {
    cfg.current = { merge, migrateOnLoad, read, write, onSaving, onSaved, onSaveError, onLoadError, onHydrated, hydrate, shouldSkipWrite, afterWrite, mirror };
  });

  const writeNow = useCallback(
    (full: T) => {
      // Explicit full-value write (clear/delete). Arm dirty so the persist
      // effect doesn't fight it, set memory, and write the store directly.
      dirtyRef.current = true;
      setLoadTriggered(true);
      setValue(full);
      void cfg.current.write(key, full).then(
        () => cfg.current.onSaved?.(),
        (e) => cfg.current.onSaveError?.(e),
      );
    },
    [key],
  );

  // ── Hydration ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!loadTriggered) {
      // BRANCH A — bare mount, no I/O. Flip isLoaded→true so the app's
      // global isLoaded isn't stuck on this store. Deferred per the
      // react-hooks/set-state-in-effect convention; stale-guarded so a
      // loadTriggered flip before the microtask fires does NOT set
      // loaded=true over the in-flight load's false (the V1.4.5 gate).
      let stale = false;
      queueMicrotask(() => {
        if (!stale) setIsLoaded(true);
      });
      return () => {
        stale = true;
      };
    }
    // BRANCH B — close the persist gate SYNCHRONOUSLY (NOT deferred) in the
    // same commit loadTriggered flips, before any mutation effect can
    // schedule a write against the not-yet-hydrated value. Documented
    // project exception (same as useImages/useSettings).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoaded(false);
    let cancelled = false;
    loadInFlightRef.current = true;
    // Cancellation-guarded committer handed to a custom hydrate(): a setValue
    // after unmount/effect-re-run is a no-op, so the bespoke load can call it
    // freely without threading `cancelled` through every branch.
    const commit = (u: React.SetStateAction<T>) => {
      if (!cancelled) setValue(u);
    };
    (async () => {
      try {
        if (cfg.current.hydrate) {
          // Bespoke load owns reading + consolidation + commit. It MUST
          // throw on a real failure so hydratedOnceRef stays false.
          await cfg.current.hydrate(commit);
        } else {
          const raw = await cfg.current.read(key);
          const loaded = raw != null && cfg.current.migrateOnLoad
            ? cfg.current.migrateOnLoad(raw)
            : raw;
          // `merge` is required on the default path (asserted): a store with
          // neither `hydrate` nor `merge` is a programmer error.
          commit((prev) => cfg.current.merge!(loaded, prev));
        }
        // SUCCEEDED, not merely "finished": set true only at the end of a
        // clean read (NEVER in finally). A thrown load leaves this false
        // so the persist effect refuses to write for the rest of the
        // session (V1.4.5-HYDRATION-FAIL / V1.6).
        hydratedOnceRef.current = true;
        if (!cancelled) cfg.current.onHydrated?.();
      } catch (e) {
        // !cancelled-guarded like the original useSettings load catch — don't
        // surface a load error (setState) on an unmounted/superseded load.
        if (!cancelled) cfg.current.onLoadError?.(e);
      } finally {
        loadInFlightRef.current = false;
        if (!cancelled) setIsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadTriggered, key]);

  // ── Persist ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!loadTriggered || !isLoaded) return; // gates 1+2
    if (!dirtyRef.current) return; // gate 3 — a hydration commit is never a write-back
    if (!hydratedOnceRef.current) return; // gate 4 — never write after a FAILED load

    if (debounceMs <= 0) {
      // Synchronous in-effect write (useIdeas / useComparison). The effect
      // entry gates already exclude the mid-load window (isLoaded is false
      // while a real load runs), so no in-timer re-check is needed here.
      if (cfg.current.shouldSkipWrite?.()) return;
      cfg.current.onSaving?.();
      void cfg.current.write(key, value).then(
        () => cfg.current.onSaved?.(),
        (e) => cfg.current.onSaveError?.(e),
      );
      cfg.current.afterWrite?.(value);
      return;
    }

    cfg.current.onSaving?.();
    const timer = setTimeout(() => {
      // Belt-and-suspenders: React's scheduling can let a timer survive the
      // effect cleanup; refuse to fire mid-load or after a failed hydration.
      if (loadInFlightRef.current || !hydratedOnceRef.current) return;
      // In-timer veto AFTER the load/hydration gates (e.g. migratingRef).
      if (cfg.current.shouldSkipWrite?.()) return;
      void cfg.current.write(key, valueRef.current).then(
        () => {
          // V1.6: the canonical write supersedes any crash-recovery snapshot
          // the cleanup wrote earlier — drop it so a stale one can't outrank
          // this state as an "in-flight patch" on the next load.
          cfg.current.mirror?.removeSnapshot?.();
          cfg.current.onSaved?.();
        },
        (e) => cfg.current.onSaveError?.(e),
      );
      cfg.current.afterWrite?.(valueRef.current);
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      // V1.2.5-HOTFIX soft-nav snapshot: an unmount / dep-change before the
      // debounce fires leaves a localStorage snapshot for the next load.
      // Same `shouldFlush` gate as beforeunload PLUS an implicit !loadInFlight
      // (never snapshot a not-yet-hydrated value).
      const m = cfg.current.mirror;
      if (
        m?.snapshotOnCleanup
        && !loadInFlightRef.current
        && m.shouldFlush(valueRef.current, {
          dirty: dirtyRef.current,
          hydratedOnce: hydratedOnceRef.current,
          loadInFlight: loadInFlightRef.current,
        })
      ) {
        m.writeSync(valueRef.current);
      }
    };
  }, [value, isLoaded, loadTriggered, debounceMs, key]);

  // ── beforeunload crash-recovery flush (opt-in via `mirror`) ────────────
  // Only mounted when a MirrorAdapter is supplied. The flush reads the
  // latest value via valueRef and the live gate context, and writes the
  // localStorage snapshot ONLY when the adapter's shouldFlush approves —
  // so a defaults-shaped / empty / pre-hydration snapshot never lands (the
  // V1.2.5/V1.4.7 wipe defense on the mirror side).
  useEffect(() => {
    if (!cfg.current.mirror) return;
    // Registered ONCE on mount (empty deps), like useImages' V1.4.4 flush.
    // The flush re-reads cfg.current.mirror + valueRef + the ref-based gate
    // context at FIRE time, so it always sees the latest value/state without
    // re-registering — and shouldFlush is the sole write gate.
    const flush = () => {
      const m = cfg.current.mirror;
      if (!m) return;
      const cur = valueRef.current;
      if (
        m.shouldFlush(cur, {
          dirty: dirtyRef.current,
          hydratedOnce: hydratedOnceRef.current,
          loadInFlight: loadInFlightRef.current,
        })
      ) {
        m.writeSync(cur);
      }
    };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, []);

  return {
    value,
    setValue,
    mutate,
    markDirty,
    writeNow,
    isLoaded,
    requestLoad,
    valueRef,
    hydratedOnceRef,
  };
}
