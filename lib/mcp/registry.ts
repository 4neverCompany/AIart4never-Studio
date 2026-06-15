/**
 * M2 — Generic MCP connector registry.
 *
 * Persistence-backed list of {@link McpServerConfig}. This is the source of
 * truth the future in-app Connectors manager reads/writes, and the data the
 * FR-22 agentic-install flow ultimately commits once the operator confirms a
 * connector.
 *
 * Storage goes through `lib/persistence` (Tauri store in the desktop app,
 * idb-keyval fallback in dev/test), under a single key holding the whole
 * array. The async functions are thin CRUD; the interesting logic
 * (`validateServerConfig`, `redactConfig`) is PURE and unit-tested without
 * touching storage.
 *
 * ─── SECURITY POSTURE (FR-22 groundwork) ────────────────────────────────────
 * The registry only *stores* a `trusted` flag — it never decides trust on its
 * own. The agentic-install flow is a LATER increment and must be:
 *   parse a link/command  →  PROPOSE a config to the operator
 *   →  operator confirms the EXACT command/url  →  markTrusted  →  setEnabled.
 * Trust is operator-granted, never inferred. See the `// FR-22:` notes on
 * `saveServer` and `markTrusted`. Anything that logs a config MUST pipe it
 * through `redactConfig` first so bearer tokens / API keys never hit a log.
 */

import { get, set } from '@/lib/persistence';
import type { McpServerConfig } from './types';

/** Storage key holding the full `McpServerConfig[]`. */
export const MCP_SERVERS_KEY = 'aiart4never_mcp_servers';

// ---------------------------------------------------------------------------
// Internal storage helpers
// ---------------------------------------------------------------------------

/** Read the raw array, tolerating a missing / corrupted value. */
async function readAll(): Promise<McpServerConfig[]> {
  const raw = await get<McpServerConfig[]>(MCP_SERVERS_KEY);
  return Array.isArray(raw) ? raw : [];
}

async function writeAll(servers: McpServerConfig[]): Promise<void> {
  await set(MCP_SERVERS_KEY, servers);
}

// ---------------------------------------------------------------------------
// CRUD surface
// ---------------------------------------------------------------------------

/** All persisted connectors, in stored order. */
export async function listServers(): Promise<McpServerConfig[]> {
  return readAll();
}

/** A single connector by id, or `undefined` if not found. */
export async function getServer(id: string): Promise<McpServerConfig | undefined> {
  const servers = await readAll();
  return servers.find((s) => s.id === id);
}

/**
 * Upsert a connector. Matches on `id`: replaces in place if present,
 * otherwise appends.
 *
 * FR-22: this is the commit point of the agentic-install flow. Callers MUST
 * have had the operator confirm the EXACT command/url before reaching here,
 * and MUST NOT install connectors parsed from observed/scraped content without
 * that confirmation. `saveServer` itself does not grant trust — pass
 * `trusted: false` and only flip it via `markTrusted` after operator consent.
 */
export async function saveServer(cfg: McpServerConfig): Promise<McpServerConfig[]> {
  const servers = await readAll();
  const idx = servers.findIndex((s) => s.id === cfg.id);
  if (idx >= 0) {
    servers[idx] = cfg;
  } else {
    servers.push(cfg);
  }
  await writeAll(servers);
  return servers;
}

/** Remove a connector by id. No-op if it doesn't exist. */
export async function removeServer(id: string): Promise<McpServerConfig[]> {
  const servers = await readAll();
  const next = servers.filter((s) => s.id !== id);
  await writeAll(next);
  return next;
}

/** Toggle the `enabled` flag for a connector. Returns the updated config. */
export async function setEnabled(id: string, on: boolean): Promise<McpServerConfig | undefined> {
  const servers = await readAll();
  const target = servers.find((s) => s.id === id);
  if (!target) return undefined;
  target.enabled = on;
  await writeAll(servers);
  return target;
}

/**
 * Mark a connector trusted (trust-on-first-use).
 *
 * FR-22: trust is OPERATOR-GRANTED. This function is the *effect* of an
 * explicit operator confirmation in the install/connect UI — it must never be
 * called automatically from a connect/list/call path, and never from content
 * the agent merely observed. Connecting to or calling a server does NOT imply
 * trust.
 */
export async function markTrusted(id: string): Promise<McpServerConfig | undefined> {
  const servers = await readAll();
  const target = servers.find((s) => s.id === id);
  if (!target) return undefined;
  target.trusted = true;
  await writeAll(servers);
  return target;
}

// ---------------------------------------------------------------------------
// PURE helpers (no storage) — unit-tested directly
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a (possibly partial) connector config WITHOUT touching storage.
 *
 * Rules:
 *  - `id` and `name` must be non-empty strings.
 *  - `transport` must be `'http'` or `'stdio'`.
 *  - `http`  ⇒ a non-empty, parseable `url`.
 *  - `stdio` ⇒ a non-empty `command`.
 *
 * Returns every problem found (not just the first) so a form can show them all.
 */
export function validateServerConfig(partial: Partial<McpServerConfig>): ValidationResult {
  const errors: string[] = [];

  if (!isNonEmptyString(partial.id)) errors.push('id is required');
  if (!isNonEmptyString(partial.name)) errors.push('name is required');

  if (partial.transport !== 'http' && partial.transport !== 'stdio') {
    errors.push("transport must be 'http' or 'stdio'");
  }

  if (partial.transport === 'http') {
    if (!isNonEmptyString(partial.url)) {
      errors.push('http transport requires a url');
    } else if (!isParseableUrl(partial.url)) {
      errors.push('url is not a valid URL');
    }
  }

  if (partial.transport === 'stdio') {
    if (!isNonEmptyString(partial.command)) {
      errors.push('stdio transport requires a command');
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Return a shallow copy of `cfg` with secret-ish header/env values masked,
 * safe to hand to a logger. Keys are preserved (so you can see *that* an
 * `Authorization` header exists) but their values become `'***'`.
 *
 * We mask conservatively: any header/env whose KEY looks secret-ish
 * (authorization, token, secret, key, password, cookie, bearer, api*) OR whose
 * value is long enough to plausibly be a credential is redacted. When in
 * doubt, redact — over-masking a log line is harmless; leaking a token is not.
 */
export function redactConfig(cfg: McpServerConfig): McpServerConfig {
  const redacted: McpServerConfig = { ...cfg };
  if (cfg.headers) redacted.headers = redactRecord(cfg.headers);
  if (cfg.env) redacted.env = redactRecord(cfg.env);
  return redacted;
}

const REDACT_PLACEHOLDER = '***';

/** Key substrings that always trigger redaction, regardless of value length. */
const SECRET_KEY_HINTS = [
  'authorization',
  'auth',
  'token',
  'secret',
  'password',
  'passwd',
  'cookie',
  'bearer',
  'api-key',
  'api_key',
  'apikey',
  'access-key',
  'access_key',
  'x-api-key',
  'key',
];

function redactRecord(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = isSecretish(k, v) ? REDACT_PLACEHOLDER : v;
  }
  return out;
}

function isSecretish(key: string, value: string): boolean {
  const lk = key.toLowerCase();
  if (SECRET_KEY_HINTS.some((hint) => lk.includes(hint))) return true;
  // Heuristic: long opaque values are probably credentials.
  if (typeof value === 'string' && value.length >= 20 && !value.includes(' ')) {
    return true;
  }
  return false;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isParseableUrl(v: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new URL(v);
    return true;
  } catch {
    return false;
  }
}
