/**
 * 4NE-26 — Deterministic request hashing.
 *
 * `stableHash` produces a stable, run-independent fingerprint of an
 * {@link ApprovalRequest}'s MATERIAL fields. This hash is the binding between
 * an {@link import('./types').ApprovalToken} and the exact request it approved:
 * a side-effecting layer recomputes the hash of what it is about to do and
 * rejects a token whose hash doesn't match.
 *
 * Determinism is the whole point — the function MUST be pure: no `Date`, no
 * `Math.random`, and object keys canonicalised (sorted) so two structurally
 * equal payloads with different key order hash identically. We deliberately
 * hash ONLY `kind`, `target`, and `payloadPreview`; `summary` and `requestId`
 * are human/correlation-only and excluded so a re-worded prompt or a new
 * correlation id doesn't invalidate an otherwise-identical approval.
 *
 * Hash function: FNV-1a 32-bit, hex-truncated to 8 chars — the same non-crypto
 * family already used by `lib/watermarks/storage.ts` (`hashBytes`, over bytes).
 * That existing helper hashes raw bytes for content-addressed filenames; here
 * we need a *string* hash over a canonical JSON of structured fields, so we add
 * a small string variant rather than reshaping the bytes-oriented one. Both are
 * FNV-1a, so the choice of algorithm is consistent across the codebase.
 */

import type { ApprovalRequest } from './types';

/**
 * Canonically stringify an arbitrary JSON-ish value with object keys sorted, so
 * the output depends only on structure + values, never on insertion order.
 *
 * - Primitives: `JSON.stringify` directly (stable for string/number/boolean/null).
 * - Arrays: order is significant (preserved); elements canonicalised recursively.
 * - Objects: keys sorted lexicographically; `undefined`-valued keys dropped (to
 *   match `JSON.stringify`, which omits them, so `{a:undefined}` ≡ `{}`).
 * - `undefined` at the top level → the literal token `null` (it can't be a JSON
 *   value, and we need a deterministic stand-in).
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'number' || t === 'boolean' || t === 'string') {
    return JSON.stringify(value);
  }
  if (t === 'bigint') {
    // bigint isn't JSON-serialisable; encode deterministically as a tagged string.
    return JSON.stringify(`__bigint__${(value as bigint).toString()}`);
  }
  if (t === 'function' || t === 'symbol') {
    // Non-data values can't meaningfully bind a token; collapse to null.
    return 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  }

  // Plain object: sort keys, drop undefined values (matching JSON.stringify).
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/**
 * FNV-1a 32-bit string hash, hex-padded to 8 chars. Non-cryptographic — it
 * exists to bind a token to a request, not to resist an adversary forging a
 * collision. Pure and stable across runs (depends only on the input string).
 */
export function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime (0x01000193) via shift-adds, kept unsigned each step.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Deterministic hash over an {@link ApprovalRequest}'s MATERIAL fields:
 * `kind`, `target`, and `payloadPreview` (canonically stringified). `summary`
 * and `requestId` are intentionally excluded — see module docs.
 *
 * Pure: identical material always yields the same hash across processes/runs.
 */
export function stableHash(req: ApprovalRequest): string {
  // Build the canonical material object explicitly so the hash depends ONLY on
  // the fields we declare material — never on extra properties a caller might
  // have spread onto the request object.
  const material = {
    kind: req.kind,
    target: req.target,
    payloadPreview: req.payloadPreview,
  };
  return fnv1a32(canonicalize(material));
}
