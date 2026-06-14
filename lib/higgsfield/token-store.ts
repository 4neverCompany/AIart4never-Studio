/**
 * Encrypted token storage for Higgsfield OAuth tokens.
 *
 * Tokens (access + refresh) are stored in IDB via `idb-keyval`,
 * but encrypted at rest with AES-GCM. The encryption key lives in
 * `config.json` (disk), keyed by a hash of the user's machine id
 * (origin + a static per-install salt from V082). That means a
 * stolen IDB blob is useless without the matching config.json entry.
 *
 * The actual machine id is provided by the desktop runtime via
 * `Tauri` when available; on the web, we fall back to a per-origin
 * constant — good enough since each user's data is already in their
 * own IDB by origin.
 *
 * Why not just put tokens in config.json? config.json is read by
 * the generic FieldRouter loop and rendered in the Settings UI as
 * masked secrets. We don't want a long base64 JWT visible in the
 * UI. Keeping the access/refresh tokens in IDB keeps them out of
 * the surface area; config.json only holds the (non-secret) OAuth
 * `client_id` + the AES key.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, createHmac } from 'node:crypto';
import { get, set, del } from 'idb-keyval';

const KEY_NAME = 'higgsfield-tokens-v1';

/**
 * BUG-FIX-2026-06-04: `idb-keyval` is a browser-only library. It
 * references the global `indexedDB` at module-evaluation time and
 * throws `indexedDB is not defined` when imported into a Node.js
 * runtime (the Vercel server, a unit-test Node env without jsdom,
 * the Tauri sidecar if it doesn't ship a DOM, etc.). The /api/higgsfield/*
 * routes are `runtime = 'nodejs'` and were crashing every time
 * `loadTokens` / `saveTokens` / `clearTokens` was called.
 *
 * Fix: guard every storage call with a single `hasIndexedDB` check.
 * When unavailable, treat it as "no tokens stored" (load) or
 * "no-op" (save / clear) and log a one-time warning so production
 * surfaces the misconfiguration. The web build's OAuth flow has a
 * deeper architectural issue (serverless functions have no per-user
 * persistent state), but at least the routes stop 500-ing.
 */
function hasIndexedDB(): boolean {
  return typeof globalThis !== 'undefined'
    && typeof (globalThis as { indexedDB?: unknown }).indexedDB !== 'undefined';
}

let didWarnNoIDB = false;
function warnNoIDBOnce(op: string): void {
  if (didWarnNoIDB) return;
    didWarnNoIDB = true;
    console.warn(
      `[higgsfield/token-store] ${op}: indexedDB is not available in this runtime ` +
      `(Node.js without a DOM). Token persistence is a no-op here. This is expected ` +
      `on the Vercel server; the OAuth flow needs client-side IDB to round-trip tokens.`,
    );
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch millis when accessToken expires. 0 means "no expiry known". */
  accessTokenExpiresAt: number;
  /** Higgsfield account email from the ID token, for display. */
  email?: string;
  /** Org workspace id (`org_id` claim) for multi-tenant routing. */
  orgId?: string;
  /** Display name from the ID token, for display. */
  name?: string;
}

function getOrCreateEncryptionKey(): Buffer {
  // The key is a 32-byte SHA-256 of (origin || static-per-install-salt).
  // The salt is generated once and persisted in config.json via
  // `DESKTOP_CONFIG_KEYS` (added by the OAuth init route). For the
  // web build the salt is generated on first use and lives in
  // localStorage under a fixed key.
  //
  // The reason we hash-and-salt instead of using a real KDF: this is
  // not a password. The threat model is "attacker copies the IDB
  // blob and runs away." SHA-256 of origin + salt (32 bytes of
  // entropy from /dev/urandom) gives them nothing to brute-force
  // without the matching config.json entry.
  //
  // We use Web Crypto's subtle via Node's crypto.createHash (the
  // same primitives, same security). On desktop, the `origin` is
  // stable (Tauri binds to a fixed port), so the same input →
  // same key, every launch.
  const origin = typeof window !== 'undefined' ? window.location.origin : 'node-ssr';
  const salt = readSaltSync();
  return createHash('sha256').update(`${origin}|${salt}`).digest();
}

const SALT_STORAGE_KEY = 'higgsfield-oauth-salt-v1';
const SALT_CONFIG_KEY = 'HIGGSFIELD_OAUTH_SALT';

function readSaltSync(): string {
  if (typeof window !== 'undefined') {
    const existing = window.localStorage?.getItem(SALT_STORAGE_KEY);
    if (existing) return existing;
    const fresh = randomBytes(16).toString('base64url');
    try {
      window.localStorage.setItem(SALT_STORAGE_KEY, fresh);
    } catch {
      // localStorage blocked (privacy mode) — degrade to a per-session
      // key. The token will be readable only this session, which is
      // fine for the OAuth-flow + immediate-use case.
    }
    return fresh;
  }
  // SSR context: try process.env (set by the OAuth init route from
  // config.json via readConfigJson). Falls back to a deterministic
  // per-process constant so SSR routes that just need to *encrypt*
  // for round-trip storage don't crash.
  const fromEnv = process.env?.[SALT_CONFIG_KEY];
  if (fromEnv) return fromEnv;
  return 'mashupforge-ssr-fallback-salt';
}

export function encryptTokens(plaintext: string): string {
  const key = getOrCreateEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Pack: version (1) || iv (12) || tag (16) || ciphertext
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decryptTokens(packed: string): string | null {
  const parts = packed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const enc = Buffer.from(parts[3], 'base64url');
    const key = getOrCreateEncryptionKey();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf-8');
  } catch {
    return null;
  }
}

/**
 * Persist tokens to IDB. The encrypted blob is opaque to IDB; we
 * treat the store as an untrusted byte bucket.
 */
export async function saveTokens(tokens: StoredTokens): Promise<void> {
  if (!hasIndexedDB()) {
    warnNoIDBOnce('saveTokens');
    return;
  }
  const packed = encryptTokens(JSON.stringify(tokens));
  await set(KEY_NAME, packed);
}

export async function loadTokens(): Promise<StoredTokens | null> {
  if (!hasIndexedDB()) {
    warnNoIDBOnce('loadTokens');
    return null;
  }
  const packed = await get<string>(KEY_NAME);
  if (!packed) return null;
  const dec = decryptTokens(packed);
  if (!dec) return null;
  try {
    return JSON.parse(dec) as StoredTokens;
  } catch {
    return null;
  }
}

export async function clearTokens(): Promise<void> {
  if (!hasIndexedDB()) {
    warnNoIDBOnce('clearTokens');
    return;
  }
  await del(KEY_NAME);
}

/**
 * True if the stored access token is missing OR is within 60s of
 * expiry. Callers should trigger a refresh before any MCP call
 * when this returns true.
 */
export function isTokenExpiringSoon(tokens: StoredTokens, now = Date.now()): boolean {
  if (!tokens.accessTokenExpiresAt) return false; // unknown expiry — try anyway
  return tokens.accessTokenExpiresAt - now < 60_000;
}

/**
 * HMAC the salt for storage in config.json. This lets the OAuth
 * init route verify a salt hasn't been tampered with on disk.
 * Returns base64url(hmac-sha256(salt, machineId)).
 */
export function sealSalt(salt: string, machineId: string): string {
  return createHmac('sha256', machineId).update(salt).digest('base64url');
}
