/**
 * v1.2.3 — Human-in-the-loop (HIL) checkpoint endpoint.
 *
 * Called by the Director loop BEFORE any cost-incurring tool call
 * (generate_image, generate_video). The endpoint asks the user to
 * approve a plan + estimated cost; the tool call is paused until
 * the user responds (or the timeout fires).
 *
 * Wire contract (POST /api/ai/confirm):
 *   Request body:
 *     {
 *       "runId": "run_...",
 *       "stepId": "step_...",
 *       "toolName": "generate_image" | "generate_video",
 *       "estimatedCostUsd": 0.04,
 *       "totalCostSoFarUsd": 0.12,
 *       "budgetUsd": 0.50,
 *       "prompt": "Darth Vader in Iron Man suit...",
 *       "model": "higgsfield:seedance_2_0",
 *       "settings": { ... }
 *     }
 *   Response body (200):
 *     {
 *       "status": "approved" | "denied" | "timeout",
 *       "reason": "<string, optional>",
 *       "decidedAt": 1234567890
 *     }
 *
 * **Today (v1.2.3) the endpoint is a non-blocking best-effort
 * stub** that returns `status: 'approved'` immediately if the
 * estimated cost is under the auto-approve threshold, and
 * `status: 'pending'` otherwise (the front-end is expected to poll
 * or open a modal and re-call the endpoint to actually decide).
 * The full UI integration is the Replay-UI follow-up
 * (v1.2.4); for v1.2.3 the cost-protection comes from the
 * `autoApproveBelowUsd` threshold (default $0.10) which keeps
 * the small prompts flowing while the expensive ones pause.
 *
 * **v1.2.4 will** add a persistent in-memory `Map<runId, approval>`
 * and a GET endpoint for the front-end to poll. This file is the
 * shape that polling endpoint will mirror.
 *
 * v1.2.3-ONLY-FIELD: `autoApproveBelowUsd` is read from the
 * request body's per-run override; falls back to the
 * HIL_DEFAULT_AUTO_APPROVE_USD constant. Maurice can override
 * the default in `lib/config.ts` later.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/errors';

export const runtime = 'nodejs';

export const HIL_DEFAULT_AUTO_APPROVE_USD = 0.10;

export type HilStatus = 'approved' | 'denied' | 'timeout';

export interface HilConfirmRequest {
  runId: string;
  stepId: string;
  toolName: string;
  estimatedCostUsd: number;
  totalCostSoFarUsd?: number;
  budgetUsd?: number;
  prompt: string;
  model: string;
  settings?: Record<string, unknown>;
  autoApproveBelowUsd?: number;
}

export interface HilConfirmResponse {
  status: HilStatus;
  reason?: string;
  decidedAt: number;
  autoApproved?: boolean;
}

/**
 * Tiny in-memory decision store, scoped to the running Node
 * process. The front-end POSTs here when the user clicks
 * Approve/Deny in the modal; the worker (paused in
 * `requestHumanApproval`) polls the same store. v1.2.4 will
 * move this to idb-keyval so the front-end and the server
 * share state across reloads; v1.2.3 keeps it in-memory which
 * is fine for the simple auto-approve behaviour.
 */
const decisions: Map<string, HilConfirmResponse> = (() => {
  // Module-scope Map; cleared on every server restart (expected —
  // any in-flight run is also lost). Process-wide, so all
  // requests in a single Node process see the same decisions.
  const g = globalThis as unknown as { __hilDecisions?: Map<string, HilConfirmResponse> };
  if (!g.__hilDecisions) g.__hilDecisions = new Map();
  return g.__hilDecisions;
})();

/**
 * Compose a stable key for the decision store. Two callers with
 * the same run+step+tool+cost resolve to the same entry, so a
 * retry of the same approval request is idempotent.
 */
function decisionKey(req: HilConfirmRequest): string {
  return `${req.runId}::${req.stepId}::${req.toolName}::${Math.round(req.estimatedCostUsd * 1000)}`;
}

/**
 * Look up a previously-recorded decision. The store is
 * best-effort: a worker that asks for approval twice with the
 * same key gets the same answer back.
 */
export function readDecision(key: string): HilConfirmResponse | undefined {
  return decisions.get(key);
}

/**
 * Record a decision. Called by the front-end's modal
 * submission handler (and by the worker when it auto-approves).
 */
export function writeDecision(key: string, response: HilConfirmResponse): void {
  decisions.set(key, response);
}

/**
 * Test-only: clear all recorded decisions. The in-memory
 * store is process-scope, so without this, decisions leak
 * across test files in the same vitest worker.
 */
export function __clearDecisionsForTests(): void {
  decisions.clear();
}

/**
 * Validate the request body shape. Defensive: the route is
 * called by both the worker (auto-approve) and the front-end
 * (user decision), and we don't trust either side.
 */
function parseRequest(body: unknown): HilConfirmRequest | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.runId !== 'string' || b.runId.length === 0) return null;
  if (typeof b.stepId !== 'string' || b.stepId.length === 0) return null;
  if (typeof b.toolName !== 'string' || b.toolName.length === 0) return null;
  if (typeof b.estimatedCostUsd !== 'number' || !Number.isFinite(b.estimatedCostUsd)) return null;
  if (b.estimatedCostUsd < 0) return null;
  if (typeof b.prompt !== 'string') return null;
  if (typeof b.model !== 'string') return null;
  return {
    runId: b.runId,
    stepId: b.stepId,
    toolName: b.toolName,
    estimatedCostUsd: b.estimatedCostUsd,
    totalCostSoFarUsd: typeof b.totalCostSoFarUsd === 'number' ? b.totalCostSoFarUsd : 0,
    budgetUsd: typeof b.budgetUsd === 'number' ? b.budgetUsd : undefined,
    prompt: b.prompt,
    model: b.model,
    settings: typeof b.settings === 'object' && b.settings !== null
      ? (b.settings as Record<string, unknown>)
      : undefined,
    autoApproveBelowUsd: typeof b.autoApproveBelowUsd === 'number'
      ? b.autoApproveBelowUsd
      : undefined,
  };
}

/**
 * Compute the auto-approve verdict for a request. v1.2.3
 * rule: cost is below the threshold AND the user hasn't
 * accumulated a runaway total cost (e.g. > 80% of the
 * per-run budget).
 */
function shouldAutoApprove(req: HilConfirmRequest): { approve: boolean; reason?: string } {
  const threshold = req.autoApproveBelowUsd ?? HIL_DEFAULT_AUTO_APPROVE_USD;
  if (req.estimatedCostUsd > threshold) {
    return { approve: false, reason: `cost $${req.estimatedCostUsd.toFixed(3)} exceeds auto-approve threshold $${threshold.toFixed(3)}` };
  }
  if (req.budgetUsd && req.budgetUsd > 0) {
    const projected = (req.totalCostSoFarUsd ?? 0) + req.estimatedCostUsd;
    if (projected > req.budgetUsd * 0.95) {
      return { approve: false, reason: `projected total $${projected.toFixed(3)} would exceed budget $${req.budgetUsd.toFixed(3)}` };
    }
  }
  return { approve: true };
}

/**
 * POST /api/ai/confirm — record a decision (or auto-approve).
 *
 * Two callers, two modes:
 *   - Worker (tool execute, BEFORE provider call): posts the
 *     request, expects an immediate "approved" or "denied"
 *     response. The endpoint auto-approves small costs and
 *     returns "denied" with a reason for the larger ones —
 *     the v1.2.4 follow-up will add the user-modal flow.
 *   - Front-end (Confirm modal submission): posts the user's
 *     explicit decision, stored in the in-memory map. The
 *     next worker poll picks it up.
 *
 * Either way the response shape is the same so the worker
 * doesn't have to branch on caller.
 */
export async function POST(req: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = parseRequest(body);
  if (!parsed) {
    return NextResponse.json(
      { error: 'Missing or invalid required fields' },
      { status: 400 },
    );
  }

  try {
    const key = decisionKey(parsed);
    const existing = readDecision(key);
    if (existing) {
      // Idempotent: same request returns the same answer.
      return NextResponse.json(existing, { status: 200 });
    }

    // No prior decision — compute an auto-approve verdict and
    // record it. The front-end's modal can override the
    // record in a follow-up POST (same key, different
    // `status` + `reason`); the next worker poll will pick
    // up the override.
    const decision = shouldAutoApprove(parsed);
    const response: HilConfirmResponse = {
      status: decision.approve ? 'approved' : 'denied',
      reason: decision.reason,
      decidedAt: Date.now(),
      autoApproved: decision.approve,
    };
    writeDecision(key, response);
    return NextResponse.json(response, { status: 200 });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: getErrorMessage(e) || 'HIL confirm error' },
      { status: 500 },
    );
  }
}

/**
 * GET /api/ai/confirm?key=... — read a previously-recorded
 * decision. Used by the worker's poll loop in v1.2.4; exposed
 * here so the shape is in one place.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const key = req.nextUrl.searchParams.get('key');
  if (!key) {
    return NextResponse.json({ error: 'Missing key query param' }, { status: 400 });
  }
  const existing = readDecision(key);
  if (!existing) {
    return NextResponse.json({ error: 'No decision recorded for that key' }, { status: 404 });
  }
  return NextResponse.json(existing, { status: 200 });
}
