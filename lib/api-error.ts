/**
 * V050-003: typed errors for the three external-API surfaces the studio
 * talks to. Replaces ad-hoc `throw new Error('...')` + Error.message
 * sniffing at call sites.
 *
 * The discriminator is `source` so callers can pattern-match per API
 * (e.g. only retry Leonardo 429s). The
 * `retryable` flag is derived by classifyHttpStatus() and is the
 * canonical "should I try again" signal — call sites should not
 * re-derive it from the http status.
 *
 * M3.3-P3 commit c: `'pi'` removed from ApiSource / RETRY_BUDGET /
 * labelFor with the pi routes.
 */

export type ApiSource = 'leonardo' | 'social' | 'trending';

export type ApiErrorCode =
  | 'http'           // HTTP non-2xx response
  | 'network'        // fetch threw (DNS / connection / abort)
  | 'timeout'        // request exceeded budget
  | 'parse'          // body returned but couldn't be parsed
  | 'rate_limit'     // 429 specifically — retryable but with backoff
  | 'auth'           // 401/403 — not retryable, user must fix creds
  | 'budget_exhausted' // retry budget hit; promoted to fatal
  | 'unknown';

export interface ApiError {
  source: ApiSource;
  code: ApiErrorCode;
  /** True if a retry has any chance of succeeding (transient failure). */
  retryable: boolean;
  /** HTTP status if applicable. Undefined for network/parse errors. */
  status?: number;
  /** Human-readable message for logs and toasts. */
  message: string;
  /** Raw cause for debugging. Not surfaced to users. */
  cause?: unknown;
}

/**
 * Per-API retry budget. Total attempts INCLUDING the first try.
 * Budgets reflect the brief: Leonardo can handle real waits; social
 * is non-idempotent so we attempt once and surface the failure.
 */
export const RETRY_BUDGET: Record<ApiSource, number> = {
  leonardo: 3,
  social: 1,
  trending: 2,
};

/** Map an HTTP status to {retryable, code} per the canonical table. */
export function classifyHttpStatus(
  status: number,
): { retryable: boolean; code: ApiErrorCode } {
  if (status === 429) return { retryable: true, code: 'rate_limit' };
  if (status === 401 || status === 403) return { retryable: false, code: 'auth' };
  if (status >= 500) return { retryable: true, code: 'http' };
  if (status >= 400) return { retryable: false, code: 'http' };
  return { retryable: false, code: 'http' };
}

/** Build an ApiError for an HTTP response. */
export function httpApiError(
  source: ApiSource,
  status: number,
  message?: string,
): ApiError {
  const { retryable, code } = classifyHttpStatus(status);
  return {
    source,
    code,
    retryable,
    status,
    message: message ?? `${source} HTTP ${status}`,
  };
}

/** Build an ApiError for a thrown network/fetch error. */
export function networkApiError(source: ApiSource, cause: unknown): ApiError {
  const message =
    cause instanceof Error ? cause.message : String(cause ?? 'network error');
  return {
    source,
    code: 'network',
    retryable: true,
    message: `${source} network: ${message}`,
    cause,
  };
}

/** Build an ApiError when the retry budget is exhausted. */
export function budgetExhaustedError(
  source: ApiSource,
  attempts: number,
  lastError?: ApiError,
): ApiError {
  return {
    source,
    code: 'budget_exhausted',
    retryable: false,
    message: `${source} failed after ${attempts} attempt${attempts === 1 ? '' : 's'}${
      lastError ? ` (last: ${lastError.message})` : ''
    }`,
    cause: lastError,
  };
}

/**
 * Render an ApiError for a user-facing toast. Keep it actionable —
 * tell the user what to do next, not just what went wrong.
 */
export function toastMessageForApiError(error: ApiError): string {
  switch (error.code) {
    case 'auth':
      return `${labelFor(error.source)} rejected your credentials. Open Settings to update them.`;
    case 'rate_limit':
      return `${labelFor(error.source)} rate-limited the request. Wait a moment and try again.`;
    case 'network':
      return `Couldn't reach ${labelFor(error.source)}. Check your connection.`;
    case 'budget_exhausted':
      return `${labelFor(error.source)} kept failing. ${error.cause && (error.cause as ApiError).code === 'auth' ? 'Check credentials.' : 'Try again later.'}`;
    case 'timeout':
      return `${labelFor(error.source)} took too long. Try again in a moment.`;
    case 'parse':
      return `${labelFor(error.source)} returned an unexpected response.`;
    default:
      return `${labelFor(error.source)}: ${error.message}`;
  }
}

function labelFor(source: ApiSource): string {
  switch (source) {
    case 'leonardo': return 'Leonardo';
    case 'social':   return 'Social post';
    case 'trending': return 'Trending';
  }
}
