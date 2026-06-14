// BUG-ACL-006: app version surface for the Settings modal.
//
// Two sources of truth:
//   1. `package.json#version` — pulled in at build time (resolveJsonModule).
//      Always available, never throws, identical across web + desktop.
//   2. Tauri's `app.getVersion()` — the running .exe's version metadata.
//      Authoritative on desktop but throws `plugin:app|version not allowed
//      by ACL` on Windows when the ACL bug bites (BUG-ACL-006 / BUG-ACL-005
//      family).
//
// We expose the package.json value as a synchronous constant so the
// Settings footer can render *something* on every render (no spinner,
// no flicker), and provide an async upgrade path that overlays the
// runtime value when it's available. Callers fall back to APP_VERSION
// on any failure — the runtime ACL throw must NOT leave the footer
// blank.

import packageJson from '../package.json';

export const APP_VERSION: string = packageJson.version;

/**
 * Async resolution of the running app's version. On desktop this is the
 * Tauri-reported version (which can drift from package.json if a release
 * was packaged from a stale build); on web (or when the ACL bug denies
 * the call) this returns APP_VERSION.
 */
export async function getAppVersion(): Promise<string> {
  try {
    const appMod = await import('@tauri-apps/api/app');
    return await appMod.getVersion();
  } catch {
    return APP_VERSION;
  }
}
