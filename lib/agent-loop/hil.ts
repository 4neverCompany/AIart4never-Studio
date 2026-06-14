/**
 * v1.2.3 — Human-in-the-loop (HIL) guard.
 *
 * Called by `generate_image` and `generate_video` tool
 * `execute()` BEFORE the provider call. Posts a
 * /api/ai/confirm request with the planned call, awaits
 * the verdict, and either proceeds or throws an
 * `HilDeniedError`.
 *
 * The endpoint (`app/api/ai/confirm/route.ts`) implements
 * an auto-approve rule for low-cost calls and a deny for
 * anything above the threshold. v1.2.4 will add a UI modal
 * + long-poll so the user can explicitly approve or deny;
 * today the "denied" verdict is the safety net that
 * prevents runaway credit burn.
 *
 * The guard is **fire-and-await** (one HTTP round-trip per
 * call), not a long-poll. The cost is ~5-30ms on a healthy
 * network, which is well within the per-step cost the
 * budget tracker already counts.
 *
 * The guard is **skipped** in test contexts (when
 * `process.env.NODE_ENV === 'test'` or when the explicit
 * `_skipHilForTest` flag is set on the call). Tests can
 * stub the HTTP call via `__setHilFetchForTests`.
 */

import type { HilStatus } from '@/app/api/ai/confirm/route';

export interface HilGuardInput {
  runId: string;
  stepId: string;
  toolName: 'generate_image' | 'generate_video';
  estimatedCostUsd: number;
  totalCostSoFarUsd?: number;
  budgetUsd?: number;
  prompt: string;
  model: string;
  settings?: Record<string, unknown>;
  /** Per-call override of the auto-approve threshold. */
  autoApproveBelowUsd?: number;
  /** Test-only: bypass the HTTP call entirely. */
  _skipHilForTest?: boolean;
}

export interface HilGuardResult {
  status: HilStatus;
  reason?: string;
  autoApproved?: boolean;
  /** Wall-clock time the guard spent waiting for the verdict. */
  elapsedMs: number;
}

/** Thrown by `requireApproval` when the endpoint returns `denied`. */
export class HilDeniedError extends Error {
  readonly status: 'denied' | 'timeout';
  readonly reason: string;
  constructor(status: 'denied' | 'timeout', reason: string) {
    super(`HIL ${status}: ${reason}`);
    this.name = 'HilDeniedError';
    this.status = status;
    this.reason = reason;
  }
}

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Test seam: tests inject a stub fetch to avoid the real HTTP
 * call. Production code never touches this.
 */
let _fetchOverride: FetchLike | null = null;
export function __setHilFetchForTests(fn: FetchLike | null): void {
  _fetchOverride = fn;
}

const DEFAULT_FETCH: FetchLike =
  typeof fetch !== 'undefined'
    ? (async (input, init) => {
        const res = await fetch(input, init as RequestInit);
        return {
          ok: res.ok,
          status: res.status,
          text: () => res.text(),
        };
      })
    : async () => {
        throw new Error('HIL guard: no fetch implementation available (node < 18?)');
      };

/**
 * Resolve the base URL for the HIL endpoint. The relative
 * path `/api/ai/confirm` is valid when the caller is the
 * Next.js server itself (route is co-located). When the
 * caller is a Tauri webview, we use the same origin as
 * the page (which is bundled into the Tauri webview's
 * localhost). When the caller is a node-side test, we
 * honour the explicit override.
 */
function resolveBaseUrl(): string {
  // The route is /api/ai/confirm — co-located in this same
  // Next.js process. The HIL POST is a same-origin fetch
  // from the worker running inside the route handler stack.
  if (typeof process !== 'undefined' && process.env.HIL_BASE_URL) {
    return process.env.HIL_BASE_URL;
  }
  return '';
}

/**
 * The main entry point. Returns a `HilGuardResult` on
 * approval; throws `HilDeniedError` on deny/timeout.
 */
export async function requireApproval(input: HilGuardInput): Promise<HilGuardResult> {
  const startedAt = Date.now();

  // Test bypass: skip the HTTP call and return a synthetic
  // approved result. Tests can also set a custom fetch to
  // exercise the full HTTP path.
  if (input._skipHilForTest) {
    return {
      status: 'approved',
      autoApproved: true,
      elapsedMs: 0,
    };
  }

  // Test env: skip the HTTP call UNLESS the test has
  // explicitly injected a stub fetch to exercise the path.
  // Without this, every test would auto-approve and the
  // tests for denied/timeout verdicts would all fail.
  if (process.env.NODE_ENV === 'test' && !_fetchOverride) {
    return {
      status: 'approved',
      autoApproved: true,
      elapsedMs: 0,
    };
  }

  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}/api/ai/confirm`;
  const f = _fetchOverride ?? DEFAULT_FETCH;

  const body = JSON.stringify({
    runId: input.runId,
    stepId: input.stepId,
    toolName: input.toolName,
    estimatedCostUsd: input.estimatedCostUsd,
    totalCostSoFarUsd: input.totalCostSoFarUsd ?? 0,
    budgetUsd: input.budgetUsd,
    prompt: input.prompt,
    model: input.model,
    settings: input.settings,
    autoApproveBelowUsd: input.autoApproveBelowUsd,
  });

  const res = await f(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) {
    // The endpoint is unreachable / 5xx. Fail closed: throw
    // a `HilDeniedError` so the tool call aborts. This is
    // safer than proceeding (which would be a silent
    // bypass of the credit guard) and louder than
    // auto-approving (which would mask the outage).
    throw new HilDeniedError(
      'denied',
      `HIL endpoint returned HTTP ${res.status}: ${await res.text().catch(() => '<no body>')}`,
    );
  }

  const text = await res.text();
  let parsed: { status: HilStatus; reason?: string; autoApproved?: boolean };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HilDeniedError('denied', `HIL endpoint returned non-JSON: ${text.slice(0, 100)}`);
  }

  const result: HilGuardResult = {
    status: parsed.status,
    reason: parsed.reason,
    autoApproved: parsed.autoApproved,
    elapsedMs: Date.now() - startedAt,
  };

  if (parsed.status === 'denied' || parsed.status === 'timeout') {
    throw new HilDeniedError(parsed.status, parsed.reason ?? 'no reason given');
  }

  return result;
}
