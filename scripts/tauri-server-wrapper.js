#!/usr/bin/env node
/*
 * Tauri desktop server wrapper.
 *
 * This file is the entrypoint the Tauri Rust launcher spawns as the
 * Node sidecar process. It runs BEFORE Next boots, so it can only use
 * plain Node (no TypeScript, no Next imports, no workspace paths).
 *
 * Responsibilities:
 *   1. Load the per-user JSON config from the platform app-data dir and
 *      copy every string entry into `process.env` so that API routes
 *      can read API keys the same way they do on Vercel.
 *   2. Log what we loaded (to stdout — Tauri captures this).
 *   3. `require('./server.js')` — the Next.js standalone server.
 *
 * This file is copied to `resources/app/start.js` by
 * `scripts/copy-standalone-to-resources.ps1` during the Windows build.
 * The Next standalone `server.js` sits in the same directory at runtime,
 * so the `./server.js` require resolves correctly.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ── PROP-006: crash reporter — install BEFORE any other require() ──────────
// Writes a timestamped crash log to MASHUPFORGE_CRASH_DIR so unhandled
// Node exceptions leave a breadcrumb even when the console is hidden.
(function installCrashHandler() {
  const crashDir = process.env.MASHUPFORGE_CRASH_DIR;
  if (!crashDir) return; // not running inside Tauri — skip
  try { fs.mkdirSync(crashDir, { recursive: true }); } catch (_) {}

  function writeCrashLog(type, errOrReason, promise) {
    try {
      const ts = Date.now();
      const msg = errOrReason instanceof Error
        ? errOrReason.stack || errOrReason.message
        : String(errOrReason);
      const lines = [
        'MashupForge sidecar crash report',
        `type: ${type}`,
        `pid: ${process.pid}`,
        `timestamp: ${new Date(ts).toISOString()}`,
        promise ? `promise: ${String(promise)}` : null,
        '---',
        msg,
      ].filter(Boolean).join('\n');
      fs.writeFileSync(path.join(crashDir, `crash-node-${ts}.log`), lines);
    } catch (_) {}
  }

  process.on('uncaughtException', (err) => {
    writeCrashLog('uncaughtException', err, null);
    // Let Node exit naturally after logging
  });
  process.on('unhandledRejection', (reason, promise) => {
    writeCrashLog('unhandledRejection', reason, promise);
    // unhandledRejection is not fatal by default — just log and continue
  });
})();
// ── end crash reporter ──────────────────────────────────────────────────────

function getDesktopConfigPath() {
  const override = process.env.MASHUPFORGE_CONFIG_DIR;
  if (override) return path.join(override, 'config.json');

  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appdata, 'MashupForge', 'config.json');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'MashupForge', 'config.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'MashupForge', 'config.json');
}

function hydrateDesktopEnv() {
  const cfgPath = getDesktopConfigPath();
  if (!fs.existsSync(cfgPath)) {
    return { loaded: false, path: cfgPath, keys: [] };
  }
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { loaded: false, path: cfgPath, keys: [], error: 'config.json must be a JSON object' };
    }
    const keys = [];
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.length > 0) {
        process.env[k] = v;
        keys.push(k);
      }
    }
    return { loaded: true, path: cfgPath, keys };
  } catch (e) {
    return { loaded: false, path: cfgPath, keys: [], error: e && e.message };
  }
}

const result = hydrateDesktopEnv();
if (result.loaded) {
  console.log(`[tauri-wrapper] hydrated ${result.keys.length} env vars from ${result.path}`);
} else if (result.error) {
  console.warn(`[tauri-wrapper] config load error at ${result.path}: ${result.error}`);
} else {
  console.log(`[tauri-wrapper] no config at ${result.path} — starting with inherited env only`);
}

// Hard-pin loopback binding.
//
// Windows Defender Firewall prompts "Allow this app through the firewall"
// the first time an unsigned .exe binds to a non-loopback interface
// (0.0.0.0 or a real NIC). Binding only to 127.0.0.1 / ::1 is exempt from
// the prompt. We therefore force HOSTNAME to loopback AFTER config
// hydration so a stray `"HOSTNAME": "0.0.0.0"` entry in the user's
// config.json cannot accidentally escape the loopback cage and trigger
// the Defender dialog on first launch. Same for HOST, which some Node
// web frameworks prefer.
const LOOPBACK = '127.0.0.1';
for (const key of ['HOSTNAME', 'HOST']) {
  if (process.env[key] && process.env[key] !== LOOPBACK) {
    console.log(
      `[tauri-wrapper] overriding ${key}=${process.env[key]} -> ${LOOPBACK} ` +
      '(desktop mode pins loopback to avoid Windows Firewall prompts)'
    );
  }
  process.env[key] = LOOPBACK;
}
if (!process.env.PORT) process.env.PORT = '0';

// NCA-BUNDLE: point lib/nca-client at the nca.exe shipped inside the
// installer if a user-supplied NCA_BIN isn't already set. The binary is
// produced by the workflow's "Build nca for Windows" step (pinned to
// v0.3.0) and copied into `src-tauri/resources/nca/nca.exe`. After
// Tauri bundles, that lands at `<install-dir>/resources/nca/nca.exe`,
// while THIS wrapper lives at `<install-dir>/resources/app/start.js`,
// so the bundled binary is always one directory up + into `nca/`.
//
// We do not override an explicitly-set NCA_BIN (e.g. config.json
// hydration above could have set it to a custom path the user
// preferred). existsSync gates the assignment so a missing or
// not-yet-built bundle silently falls through to PATH lookup, which
// is what dev / web mode wants.
(function pinBundledNca() {
  if (process.env.NCA_BIN) return;
  try {
    const candidate = path.join(__dirname, '..', 'nca', 'nca.exe');
    if (fs.existsSync(candidate)) {
      process.env.NCA_BIN = candidate;
      console.log(`[tauri-wrapper] using bundled nca: ${candidate}`);
    }
  } catch (_) {
    // not in Tauri or unexpected layout — leave NCA_BIN unset so
    // lib/nca-client falls back to its own /usr/local/bin/nca / PATH
    // resolution. No log: this is the expected dev/web path.
  }
})();

console.log(`[tauri-wrapper] booting Next on ${process.env.HOSTNAME}:${process.env.PORT}`);

require('./server.js');
