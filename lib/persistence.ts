'use client';

// BUG-DEV-012 — fixes WebView2 per-executable-path IndexedDB partitioning.
//
// WebView2 places its user-data folder (which contains IndexedDB) under the
// exe directory by default. When the install folder is moved, WebView2 spins
// up a brand-new empty partition at the new location and every saved image,
// scheduled post, idea, and collection appears to vanish (GitHub issue #12).
//
// Fix: persist user data through `@tauri-apps/plugin-store` instead of
// `idb-keyval`. The plugin writes to Tauri's `app_data_dir`, which on
// Windows resolves to `%APPDATA%\com.4nevercompany.mashupforge\` via the
// bundle identifier — independent of where the exe lives. Moving the
// install folder no longer touches the data location.
//
// This module is a drop-in replacement for the `{ get, set }` surface that
// the hooks previously imported from `idb-keyval`, so call sites change one
// line. In non-Tauri runtimes (Next.js dev server in plain browser, jsdom
// test environment) the wrapper falls back to `idb-keyval` so existing dev
// workflows and tests keep working untouched.
//
// On first launch after upgrading, a one-time migration copies any
// pre-existing IDB values for the well-known data keys into the store. The
// IDB entries are left in place as a passive rollback path — clearing the
// store re-runs the migration on the next launch.

import { get as idbGet, set as idbSet } from 'idb-keyval';

const STORE_PATH = 'mashupforge.json';
const MIGRATION_FLAG_KEY = '__idb_migrated_v1';

/**
 * Keys whose values are user-visible state that must survive folder moves.
 * Anything not on this list (pipeline checkpoints, transient log buffers)
 * stays in IDB by virtue of using `idb-keyval` directly.
 */
const MIGRATION_KEYS = [
  'mashup_settings',
  'mashup_saved_images',
  'mashup_ideas',
  'mashup_collections',
  'mashup_comparison_results',
] as const;

type StoreLike = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
};

let storePromise: Promise<StoreLike> | null = null;

function isTauri(): boolean {
  return typeof window !== 'undefined'
    && '__TAURI_INTERNALS__' in (window as unknown as Record<string, unknown>);
}

async function getStore(): Promise<StoreLike> {
  if (storePromise) return storePromise;
  storePromise = (async () => {
    const { load } = await import('@tauri-apps/plugin-store');
    const store = await load(STORE_PATH) as unknown as StoreLike;

    const flag = await store.get(MIGRATION_FLAG_KEY);
    if (flag === undefined) {
      for (const key of MIGRATION_KEYS) {
        const existing = await store.get(key);
        if (existing !== undefined) continue;
        try {
          const idbValue = await idbGet(key);
          if (idbValue !== undefined) await store.set(key, idbValue);
        } catch {
          // IDB unavailable (private mode, quota error) — skip this key.
        }
      }
      await store.set(MIGRATION_FLAG_KEY, { at: Date.now() });
      await store.save();
    }
    return store;
  })().catch((err) => {
    // Reset the cached promise so a later call gets a chance to retry
    // after a transient failure (Tauri APIs not yet ready, etc).
    storePromise = null;
    throw err;
  });
  return storePromise;
}

/**
 * Read a value persisted under `key`. Returns `undefined` if the key has
 * never been written.
 *
 * In Tauri, reads come from `app_data_dir/mashupforge.json`. In non-Tauri
 * runtimes (dev/test) it falls back to `idb-keyval` so the developer
 * experience and the unit-test suite remain unchanged.
 *
 * Default `T = any` matches `idb-keyval`'s signature so this is a true
 * drop-in for call sites that didn't pass an explicit generic.
 */
 
export async function get<T = any>(key: string): Promise<T | undefined> {
  if (!isTauri()) return idbGet<T>(key);
  try {
    const store = await getStore();
    return await store.get<T>(key);
  } catch {
    return idbGet<T>(key);
  }
}

/**
 * Persist `value` under `key`. In Tauri, this writes through
 * `@tauri-apps/plugin-store` which uses a 100ms autoSave debounce by
 * default. In non-Tauri runtimes it writes to IDB through `idb-keyval`.
 */
 
export async function set(key: string, value: any): Promise<void> {
  if (!isTauri()) return idbSet(key, value);
  try {
    const store = await getStore();
    await store.set(key, value);
  } catch {
    return idbSet(key, value);
  }
}

// Test-only hook to reset the cached store promise between tests.
export function __resetStoreForTests(): void {
  storePromise = null;
}
