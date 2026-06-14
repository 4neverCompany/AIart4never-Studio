/**
 * V050-003: typed Result envelope. Replaces ad-hoc try/catch + throw at
 * external-API boundaries so call sites can branch on `result.ok`
 * without re-deriving "is this retryable, was this fatal" from a thrown
 * Error message.
 *
 * Phase 1 introduces the primitive + helpers. Phase 2 sweeps each
 * external integration (Leonardo, pi.dev, social, trending) onto it.
 *
 * Conventions:
 *  - `ok: true`  → success. `value` is the unwrapped payload.
 *  - `ok: false` → failure. `error` is a typed error (see api-error.ts
 *                  for the canonical ApiError union).
 *  - Discriminated by `ok` so `if (r.ok) { r.value }` narrows correctly.
 */

export type Result<T, E = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Map a successful Result through a transformation. Pass-through on err. */
export function mapResult<T, U, E>(
  r: Result<T, E>,
  f: (value: T) => U,
): Result<U, E> {
  return r.ok ? ok(f(r.value)) : r;
}

/**
 * Unwrap a Result, throwing the contained error on failure. Use only
 * when the call site truly cannot proceed without the value AND the
 * error type is acceptable to throw (i.e. an Error subclass). Prefer
 * branching on `r.ok` everywhere else.
 */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw r.error instanceof Error
    ? r.error
    : new Error(typeof r.error === 'string' ? r.error : JSON.stringify(r.error));
}

/** Helper for `try/catch`-bridging legacy throwing functions onto Result. */
export async function tryAsync<T>(
  fn: () => Promise<T>,
): Promise<Result<T, unknown>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(e);
  }
}
