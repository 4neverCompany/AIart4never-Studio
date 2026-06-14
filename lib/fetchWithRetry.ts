import { type Result, ok, err } from './result';
import {
  type ApiSource,
  type ApiError,
  RETRY_BUDGET,
  budgetExhaustedError,
  classifyHttpStatus,
  httpApiError,
  networkApiError,
} from './api-error';

/**
 * Retry a fetch on transient failure (network error or 5xx status).
 *
 * Used at hot pipeline call sites where a single network blip used to
 * abort the whole run. NOT used for non-idempotent calls like
 * /api/social/post — those would risk double-posting.
 *
 * Defaults: 3 attempts total, exponential backoff 250ms → 500ms → 1000ms.
 * 4xx responses are returned as-is (the server is telling us "don't
 * retry, your input is wrong").
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts: { attempts?: number; baseDelayMs?: number } = {},
): Promise<Response> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(input, init);
      if (res.status >= 500 && i < attempts - 1) {
        await sleep(baseDelayMs * 2 ** i);
        continue;
      }
      return res;
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) {
        await sleep(baseDelayMs * 2 ** i);
        continue;
      }
      throw e;
    }
  }
  throw lastError ?? new Error('fetchWithRetry: exhausted attempts');
}

/**
 * V050-003: Result-returning wrapper around fetchWithRetry that knows
 * the per-API retry budget. Use this at integration points where you
 * want typed errors instead of try/catch + Error.message sniffing.
 *
 * - Honors RETRY_BUDGET[source] (Leonardo: 3, pi: 2, social: 1).
 * - Retries on network errors AND on retryable HTTP statuses (5xx, 429).
 * - Auth errors (401/403) are NEVER retried.
 * - Returns the final Response (success OR non-retryable HTTP) as
 *   `ok` so the caller can still inspect the body even on a 4xx.
 *   Network/budget exhaustion failures come back as `err`.
 *
 * If you want the raw "throw on failure" behavior, keep using
 * fetchWithRetry().
 */
export async function fetchApi(
  source: ApiSource,
  input: RequestInfo | URL,
  init?: RequestInit,
  opts: { attempts?: number; baseDelayMs?: number } = {},
): Promise<Result<Response, ApiError>> {
  const attempts = opts.attempts ?? RETRY_BUDGET[source];
  const baseDelayMs = opts.baseDelayMs ?? 250;
  let lastErr: ApiError | undefined;

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(input, init);
      if (res.ok) return ok(res);

      const cls = classifyHttpStatus(res.status);
      if (cls.retryable && i < attempts - 1) {
        lastErr = httpApiError(source, res.status);
        await sleep(baseDelayMs * 2 ** i);
        continue;
      }
      // Non-retryable 4xx (auth/bad-request) — return the Response
      // so the caller can inspect the body. The caller decides
      // whether to coerce to err() based on what they're doing.
      if (!cls.retryable) return ok(res);

      // Retryable but budget exhausted.
      return err(budgetExhaustedError(source, attempts, httpApiError(source, res.status)));
    } catch (e) {
      lastErr = networkApiError(source, e);
      if (i < attempts - 1) {
        await sleep(baseDelayMs * 2 ** i);
        continue;
      }
      return err(budgetExhaustedError(source, attempts, lastErr));
    }
  }
  return err(
    budgetExhaustedError(source, attempts, lastErr) ?? {
      source,
      code: 'unknown',
      retryable: false,
      message: 'fetchApi: exhausted attempts',
    },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
