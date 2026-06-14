/**
 * Desktop-mode environment hydration.
 *
 * When MashupForge runs inside the Tauri desktop bundle, the Next.js server
 * is spawned as a sidecar and has no Vercel dashboard to read API keys from.
 * Instead, we load a per-user JSON config file from the platform-standard
 * app-data dir and copy every string entry into `process.env` BEFORE the
 * Next server boots. API routes then read keys via `process.env.X` exactly
 * as they would on Vercel.
 *
 * Platform paths:
 *   Windows: %APPDATA%\MashupForge\config.json
 *   macOS:   ~/Library/Application Support/MashupForge/config.json
 *   Linux:   $XDG_CONFIG_HOME/MashupForge/config.json  (or ~/.config/...)
 *
 * The env var MASHUPFORGE_CONFIG_DIR overrides the resolved dir — useful
 * for tests and for the Tauri launcher to force a specific location.
 *
 * This module is imported from the Tauri server wrapper (`scripts/tauri-
 * server-wrapper.js`), not from Next itself. The wrapper calls
 * `hydrateDesktopEnv()` at process start, then requires `server.js`.
 *
 * HIGGSFIELD-OAUTH-KEY-CRUD: OAuth client_id + AES salt are written
 * to config.json by /api/higgsfield/oauth/authorize. `readDesktopConfigValue`
 * and `writeDesktopConfigValue` give routes a single-key read / atomic
 * write without re-parsing the whole file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface HydrateResult {
  loaded: boolean;
  path: string;
  keys: string[];
  error?: string;
}

export function getDesktopConfigPath(): string {
  const override = process.env.MASHUPFORGE_CONFIG_DIR;
  if (override) return join(override, 'config.json');

  const platform = process.platform;
  if (platform === 'win32') {
    const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appdata, 'MashupForge', 'config.json');
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'MashupForge', 'config.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'MashupForge', 'config.json');
}

/**
 * Read a single key from config.json. Returns undefined if the file
 * doesn't exist or the key is missing/empty. On the web build the
 * function is harmless — config.json is not present so the early
 * return fires.
 */
export function readDesktopConfigValue(key: string): string | undefined {
  const path = getDesktopConfigPath();
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const v = (parsed as Record<string, unknown>)[key];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a single key to config.json. Creates the parent dir + file
 * if missing. Loads the existing JSON, merges the new value, writes
 * back atomically (write to a temp file in the same dir, then
 * rename) so a partial write can't corrupt the file.
 *
 * Empty string is treated as "delete" — matches the convention from
 * the FieldRouter PATCH endpoint that empties secrets to remove them.
 */
export function writeDesktopConfigValue(key: string, value: string): void {
  const path = getDesktopConfigPath();
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt config — back it up and start fresh so we don't
      // overwrite the user's other keys silently.
      try {
        writeFileSync(`${path}.broken-${Date.now()}`, readFileSync(path));
      } catch { /* ignore */ }
      current = {};
    }
  }
  if (value.length === 0) {
    delete current[key];
  } else {
    current[key] = value;
  }
  // Ensure dir exists, then atomic-ish write (write to temp + rename).
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf8');
  // POSIX rename is atomic; on Windows renameSync overwrites if dest
  // exists, which is the behaviour we want here.
  const { renameSync } = require('node:fs') as typeof import('node:fs');
  renameSync(tmp, path);
}

export function hydrateDesktopEnv(): HydrateResult {
  const path = getDesktopConfigPath();

  if (!existsSync(path)) {
    return { loaded: false, path, keys: [] };
  }

  try {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { loaded: false, path, keys: [], error: 'config.json must be a JSON object' };
    }

    const keys: string[] = [];
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // Only copy primitive string values — nested objects / arrays would
      // not round-trip through process.env cleanly anyway.
      if (typeof v === 'string' && v.length > 0) {
        process.env[k] = v;
        keys.push(k);
      }
    }
    return { loaded: true, path, keys };
  } catch (e) {
    return { loaded: false, path, keys: [], error: (e as Error).message };
  }
}
