'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { usePersistentStore } from './usePersistentStore';
// BUG-DEV-012: persistence goes through `@/lib/persistence` (tauri-plugin-
// store in production, idb-keyval fallback in dev/test). On Tauri these hit
// %APPDATA%\com.4nevercompany.mashupforge\mashupforge.json and survive
// folder moves. `get`/`set` are used inside the bespoke `hydrate` load below.
import { get, set } from '@/lib/persistence';
import { type UserSettings, type WatermarkSettings, defaultSettings } from '../types/mashup';
import { applySettingsMigrations } from '../lib/pipeline-daemon-utils';
import {
  shouldMigrateWatermark,
  migrateWatermarkToDisk,
} from '@/lib/watermarks/migrate';

// Deep-merge a loaded payload into the current settings, preserving defaults
// for any fields that are missing or explicitly undefined in the payload.
// Nested objects (watermark, apiKeys) are merged one level deep so a partial
// save doesn't clobber defaults for fields that were never written.
export function mergeSettings(prev: UserSettings, patch: Partial<UserSettings>): UserSettings {
  // Strip top-level undefined values so they don't override existing defaults.
  const clean = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<UserSettings>;
  const merged = { ...prev, ...clean };
  if (clean.watermark && typeof clean.watermark === 'object') {
    merged.watermark = { ...prev.watermark, ...clean.watermark };
  }
  if (clean.apiKeys && typeof clean.apiKeys === 'object') {
    merged.apiKeys = { ...prev.apiKeys, ...clean.apiKeys };
  }
  // TODO: if UserSettings gains additional nested-object fields beyond
  // watermark and apiKeys, add explicit deep-merge cases above — otherwise
  // they will silently shallow-merge and partial saves will clobber defaults.
  return merged;
}

// FEAT-002b S1: surface IndexedDB write failures so the SettingsModal
// can render a red error pill.
export type SettingsSaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string };

const LOAD_ERROR_MSG =
  'Settings failed to load — changes are not being saved. Restart the app.';

// ─── Storage contract (PROP-010 / FIX-102) ─────────────────────────────────
//
// IDB (`mashup_settings`) is the single canonical store for UserSettings.
// localStorage is NOT a parallel store — it is a one-way crash-recovery
// buffer for the 300ms debounce window (the store's `mirror`):
//   1. Persist  → IDB only (debounced 300ms).
//   2. Unload / soft-nav → mirror writes localStorage (beforeunload +
//      debounce-effect cleanup snapshot), gated on dirty && hydrated.
//   3. Load     → the bespoke `hydrate` below reads localStorage as an
//      in-flight PATCH, merges it OVER the store value, writes the
//      consolidated result back, and DELETES localStorage. The V1.6
//      removeSnapshot (after a canonical write) also drops it so a stale
//      snapshot can't outrank a just-persisted state.
//
// v1.8.1 (followup #2b): the wipe-safe gate state machine (dirty /
// loadInFlight / hydratedOnce, lazy load, the 300ms gated write, the mirror)
// now lives in usePersistentStore. This hook keeps the SETTINGS-SPECIFIC
// logic — the marker-pair guard, mergeSettings ordering, applySettingsMigrations,
// pendingOps replay, and the watermark-to-disk migration — bespoke.
// ──────────────────────────────────────────────────────────────────────────
export function useSettings() {
  const [saveState, setSaveState] = useState<SettingsSaveState>({ kind: 'idle' });
  // Reactive "hydration SUCCEEDED" flag (set via the store's onHydrated), used
  // to fire the watermark migration only after a clean load.
  const [hydratedOk, setHydratedOk] = useState(false);

  // V1.4.7-SETTINGS-WIPE: pendingOps — mutations made BEFORE hydration are
  // recorded and replayed ON TOP of the hydrated state, so neither side
  // clobbers the other. The decision "record or not" reads a LOCAL hydrated
  // flag (set in `hydrate` on success) rather than the store's ref, so
  // updateSettings/clearSettings stay stable + lint-clean.
  const localHydratedRef = useRef(false);
  const pendingOpsRef = useRef<Array<
    | { type: 'patch'; patch: Partial<UserSettings> }
    | { type: 'clear'; keys: (keyof UserSettings)[] }
  >>([]);

  // Replay pre-hydration mutations on top of a hydrated base state.
  const replayPendingOps = useCallback((base: UserSettings): UserSettings => {
    let next = base;
    for (const op of pendingOpsRef.current) {
      if (op.type === 'patch') {
        next = mergeSettings(next, op.patch);
      } else {
        const clone = { ...next } as Record<string, unknown>;
        for (const key of op.keys) delete clone[key as string];
        next = clone as unknown as UserSettings;
      }
    }
    return next;
  }, []);

  const store = usePersistentStore<UserSettings>({
    key: 'mashup_settings',
    initial: defaultSettings,
    debounceMs: 300,
    // Bespoke load (PROP-010 / V1.2.8 / V1.6). localStorage is an in-flight
    // PATCH; the store is authoritative. A thrown store read PROPAGATES (we
    // never swallow it) so the store leaves hydratedOnceRef false and the
    // persist gate stays shut (V1.6 / V1.4.7-SETTINGS-WIPE). The local
    // hydrated flag flips true only on a clean finish (mirrors the store).
    hydrate: async (commit) => {
      const storedSettings = localStorage.getItem('mashup_settings');
      if (storedSettings) {
        let parsed: Partial<UserSettings> | null = null;
        try {
          parsed = JSON.parse(storedSettings) as Partial<UserSettings>;
        } catch {
          // bad JSON — clear and fall through to store-only
          localStorage.removeItem('mashup_settings');
        }

        if (parsed !== null) {
          const idbSettings = await get('mashup_settings');
          const idbIsObj = idbSettings && typeof idbSettings === 'object';
          if (Object.keys(parsed).length > 0) {
            // Merge into the store value. localStorage is a patch; store is
            // authoritative for absent keys.
            const storeValue = (idbIsObj ? idbSettings : {}) as Partial<UserSettings>;
            // V1.6 marker-pair guard: if the snapshot carries
            // useDirectorPipeline but NOT directorPipelineUserSet while the
            // store HAS the marker, the snapshot's value can only be a stale
            // migration artifact (the sole writer — the Settings toggle —
            // stamps both keys atomically). Drop it so a one-commit-stale
            // crash-recovery snapshot can't overwrite an explicit opt-out and
            // inherit the store's marker.
            if (
              'useDirectorPipeline' in parsed
              && !('directorPipelineUserSet' in parsed)
              && storeValue.directorPipelineUserSet === true
            ) {
              delete parsed.useDirectorPipeline;
            }
            const merged = mergeSettings(
              mergeSettings(defaultSettings, storeValue),
              parsed,
            );
            await set('mashup_settings', merged);
            localStorage.removeItem('mashup_settings');
            commit(prev => replayPendingOps(applySettingsMigrations(mergeSettings(prev, merged))));
          } else {
            // empty object — clear and load from store
            localStorage.removeItem('mashup_settings');
            if (idbIsObj) {
              commit(prev => replayPendingOps(applySettingsMigrations(mergeSettings(prev, idbSettings as Partial<UserSettings>))));
            } else {
              commit(prev => replayPendingOps(applySettingsMigrations(prev)));
            }
          }
        } else {
          const idbSettings = await get('mashup_settings');
          if (idbSettings && typeof idbSettings === 'object') {
            commit(prev => replayPendingOps(applySettingsMigrations(mergeSettings(prev, idbSettings as Partial<UserSettings>))));
          } else {
            commit(prev => replayPendingOps(applySettingsMigrations(prev)));
          }
        }
      } else {
        const idbSettings = await get('mashup_settings');
        if (idbSettings && typeof idbSettings === 'object') {
          commit(prev => replayPendingOps(applySettingsMigrations(mergeSettings(prev, idbSettings as Partial<UserSettings>))));
        } else {
          // Fresh install: still run migrations so the auto-everywhere map is
          // materialized (PipelinePanel grid shows active state immediately).
          commit(prev => replayPendingOps(applySettingsMigrations(prev)));
        }
      }
      // V1.6: "hydration SUCCEEDED" — set the LOCAL flag only at the end of a
      // clean load (a throw above skips this). The store flips its own
      // hydratedOnceRef when this resolves; both drive the same invariant.
      localHydratedRef.current = true;
    },
    onHydrated: () => setHydratedOk(true),
    onSaving: () => setSaveState({ kind: 'saving' }),
    onSaved: () => setSaveState({ kind: 'saved', at: Date.now() }),
    onSaveError: (e) => setSaveState({
      kind: 'error',
      message: e instanceof Error ? e.message : 'Settings save failed',
    }),
    onLoadError: () => setSaveState({ kind: 'error', message: LOAD_ERROR_MSG }),
    // localStorage crash-recovery mirror (PROP-010 contract above).
    mirror: {
      writeSync: (s) => {
        try { localStorage.setItem('mashup_settings', JSON.stringify(s)); } catch { /* quota — silent */ }
      },
      // V1.4.7-SETTINGS-WIPE: only flush a REAL pending edit of the hydrated
      // state. A defaults-shaped / no-edit snapshot must never land — the
      // next load treats localStorage as a patch that outranks the store.
      shouldFlush: (_s, ctx) => ctx.dirty && ctx.hydratedOnce,
      // V1.2.5-HOTFIX: also snapshot on the debounce-effect cleanup (soft-nav).
      snapshotOnCleanup: true,
      // V1.6: a canonical store write supersedes the snapshot — drop it.
      removeSnapshot: () => {
        try { localStorage.removeItem('mashup_settings'); } catch { /* ignore */ }
      },
    },
  });

  const settings = store.value;
  const isSettingsLoaded = store.isLoaded;
  const setSettings = store.setValue;
  const { markDirty, requestLoad } = store;

  // Always-current local mirror for the watermark migration's `current` read.
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // V1.7.1-M3.2b-WATERMARK-DISK: once-per-session migration from the legacy
  // in-store data-URL watermark to a disk-backed file. Bespoke: gated on
  // hydration success (reactive hydratedOk) + Tauri runtime + the
  // shouldMigrateWatermark marker. Best-effort: a failed disk write leaves
  // the legacy data-URL alone.
  useEffect(() => {
    if (!hydratedOk) return;
    if (typeof window === 'undefined') return;
    const tauriInternals = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    const tauriLegacy = (window as unknown as { __TAURI__?: unknown }).__TAURI__;
    const isTauri = !!(tauriInternals || tauriLegacy);
    if (!isTauri) return;
    const current = settingsRef.current;
    if (!shouldMigrateWatermark(current, isTauri)) return;
    let cancelled = false;
    (async () => {
      const patch = await migrateWatermarkToDisk(current);
      if (cancelled || !patch || !patch.watermark) return;
      // V1.8.1: arm the persist gate so the slimmed {imageRef + asset URL}
      // record actually persists (the 300ms write refuses unless dirty). Then
      // patch settings via the normal setState path.
      markDirty();
      setSettings((prev) => {
        const prevWm: WatermarkSettings = prev.watermark ?? {
          enabled: false,
          image: null,
          position: 'bottom-right',
          opacity: 0.8,
          scale: 0.15,
        };
        const merged: WatermarkSettings = {
          enabled: patch.watermark!.enabled ?? prevWm.enabled,
          image: patch.watermark!.image ?? prevWm.image,
          position: patch.watermark!.position ?? prevWm.position,
          opacity: patch.watermark!.opacity ?? prevWm.opacity,
          scale: patch.watermark!.scale ?? prevWm.scale,
          imageRef: patch.watermark!.imageRef ?? prevWm.imageRef,
        };
        return { ...prev, watermark: merged };
      });
    })();
    return () => { cancelled = true; };
  }, [hydratedOk, markDirty, setSettings]);

  // Stable identity across renders (setSettings + markDirty are both stable),
  // so downstream consumers can safely include updateSettings in dep arrays
  // (PROP-014). updateSettings/clearSettings arm the persist via markDirty and
  // record pre-hydration edits into pendingOps for replay.
  const updateSettings = useCallback((
    newSettings: Partial<UserSettings> | ((prev: UserSettings) => Partial<UserSettings>),
  ) => {
    setSettings((prev) => {
      const patch = typeof newSettings === 'function' ? newSettings(prev) : newSettings;
      // V1.4.7-SETTINGS-WIPE: record pre-hydration edits (RESOLVED patch is
      // idempotent under StrictMode double-invoke) for replay on top of the
      // hydrated state.
      if (!localHydratedRef.current) {
        pendingOpsRef.current.push({ type: 'patch', patch });
      }
      return mergeSettings(prev, patch);
    });
    markDirty();
  }, [setSettings, markDirty]);

  // V1.1.1-CAMERA-ANGLE-CLEAR: explicit key-removal path (mergeSettings strips
  // `undefined` patches, so it can't clear a field). Multiple keys per call.
  const clearSettings = useCallback((keys: (keyof UserSettings)[]) => {
    setSettings((prev) => {
      if (!localHydratedRef.current) {
        pendingOpsRef.current.push({ type: 'clear', keys });
      }
      const next = { ...prev } as Record<string, unknown>;
      for (const key of keys) {
        delete next[key as string];
      }
      return next as unknown as UserSettings;
    });
    markDirty();
  }, [setSettings, markDirty]);

  return { settings, updateSettings, clearSettings, isSettingsLoaded, saveState, requestLoad };
}
