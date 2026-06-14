/**
 * V1.1.3-CORS (2026-06-07): TypeScript mirror of the Rust
 * `resolve_camofox_cors_origins` helper in
 * `src-tauri/src/lib.rs`. Exists so the CORS-proxy
 * (`scripts/camofox-cors-proxy.mjs`), the Vercel-Web trending
 * route, and any future Tauri-Command-Bridge code can all agree
 * on the parsing rules.
 *
 * IMPORTANT: keep this module in lockstep with the Rust function
 * — the same set of rules (rejects `*`, validates http(s) scheme,
 * falls back to the 2-origin default on empty input) must apply
 * in both places. The vitest test
 * `tests/lib/camofox/cors-config.test.ts` exercises the
 * TypeScript side; the Rust integration test
 * `src-tauri/tests/camofox_lifecycle.rs` exercises the Rust side.
 */

/**
 * The default whitelist when `CAMOFOX_CORS_ORIGINS` is unset.
 * Keep in sync with `DEFAULT_CAMOFOX_CORS_ORIGINS` in `lib.rs`.
 */
export const DEFAULT_CAMOFOX_CORS_ORIGINS: readonly string[] = [
  'http://localhost:3000',
  'https://mashupforge.vercel.app',
] as const;

/**
 * Parsed output of `parseCorsOrigins`. `origins` is the
 * sanitized, post-filter list (never contains `*` and never
 * contains non-http(s) schemes). `isDefault` is true when the
 * default whitelist was used because the input was empty or
 * all-rejected.
 */
export interface ParsedCorsOrigins {
  origins: string[];
  isDefault: boolean;
  rawInput: string | null;
}

/**
 * Parse the `CAMOFOX_CORS_ORIGINS` env-var content (the raw
 * value, NOT the env-var lookup) into a sanitized origin list.
 * Rules (mirror the Rust side exactly):
 *
 *  1. `null` / empty / whitespace-only → use the default whitelist.
 *  2. Comma-separated, trim each entry, drop empty entries.
 *  3. Reject `*` (wildcard — would let any origin instruct the
 *     user's local camofox instance to navigate and exfiltrate
 *     state).
 *  4. Reject any entry that doesn't start with `http://` or
 *     `https://` (file://, ftp://, null, custom schemes).
 *  5. If the filter empties the list (e.g. user only set `*`),
 *     fall back to the default whitelist rather than emit
 *     nothing (which would silently 403 every browser request).
 *
 * The `rawInput` is the trimmed string the caller passed in
 * (env-var value or user override), preserved for diagnostics.
 * Never logged on its own — log sites should redact tokens
 * (none expected here, but the rule is enforced).
 */
export function parseCorsOrigins(rawValue: string | null | undefined): ParsedCorsOrigins {
  if (rawValue === null || rawValue === undefined) {
    return {
      origins: [...DEFAULT_CAMOFOX_CORS_ORIGINS],
      isDefault: true,
      rawInput: null,
    };
  }
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return {
      origins: [...DEFAULT_CAMOFOX_CORS_ORIGINS],
      isDefault: true,
      rawInput: '',
    };
  }
  const filtered = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => s !== '*')
    .filter((s) => s.startsWith('http://') || s.startsWith('https://'));
  if (filtered.length === 0) {
    return {
      origins: [...DEFAULT_CAMOFOX_CORS_ORIGINS],
      isDefault: true,
      rawInput: trimmed,
    };
  }
  return {
    origins: filtered,
    isDefault: false,
    rawInput: trimmed,
  };
}

/**
 * Read the env-var and parse it. The Node-side and browser-side
 * entry points differ (Node has `process.env`, browser doesn't),
 * so we accept the raw value and let the caller source it.
 */
export function resolveCorsOrigins(rawEnvValue: string | null | undefined): ParsedCorsOrigins {
  return parseCorsOrigins(rawEnvValue);
}

/**
 * Format the parsed list back to a comma-separated string for
 * forwarding to the sidecar process (or for writing to a config
 * file). The format is stable so a roundtrip
 * `parse(format(x)) === x` for any valid `x`.
 */
export function formatCorsOrigins(parsed: ParsedCorsOrigins): string {
  return parsed.origins.join(',');
}
