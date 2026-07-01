/**
 * v1.2.3 — Run context for the Director loop.
 *
 * Module-scope "current run" state. Set by `runDirectorLoop`
 * at the top of each invocation and cleared at the end.
 * Tool `execute()` functions (e.g. `generate_image`,
 * `generate_video`) read it to build the HIL approval
 * request and to know how much of the per-run budget
 * has been spent.
 *
 * This is a **request-scoped singleton**, not a process-wide
 * singleton. Two concurrent director runs in the same Node
 * process would race; the engine doesn't run them in
 * parallel today (each request is one worker) so the
 * single-slot model is safe. The atomicity is enforced
 * by a single sync read/write — not by a real lock, since
 * Node's event loop serialises Promise resolution on a
 * single microtask.
 *
 * **Test seam:** `__setCurrentRunContextForTests(null)`
 * clears the slot at the end of a test.
 */

import type { CharacterId } from '@/lib/canon';
import type { McpServerConfig } from '@/lib/mcp';

export interface RunContext {
  /** Stable run id, prefixed with `run_` for log readability. */
  runId: string;
  /** Monotonically increasing step counter, bumped on each onStepFinish. */
  stepCounter: number;
  /** Sum of per-step cost across the log so far. */
  totalCostUsd: number;
  /** Per-run budget cap (USD). */
  budgetUsd: number;
  /** HIL auto-approve threshold override (USD). */
  autoApproveBelowUsd?: number;
  /** 4NE-24: the active canon character for this run. persist_asset stamps its
   *  facet tags (lib/canon/content-plan canonTags) onto saved assets so
   *  reuse-first can find them by character/reality later. */
  characterId?: CharacterId;
  /**
   * AGENTIC-CORE: the operator's resolved, enabled+trusted Higgsfield MCP
   * connector. The chat CLIENT must include it in the `/api/ai/prompt` body
   * (the MCP registry is client-side, so server code never reads it). The
   * loop threads it here so `generate_image` can submit a canon-anchored
   * generation through Higgsfield. Undefined → the tool errors with a clear
   * "No Higgsfield connector configured" message.
   */
  higgsfieldConnector?: McpServerConfig;
  /**
   * Story 2.8 — per-turn resolved canon Elements, keyed by character id. The
   * ONLY writer is the `show_reference_elements` tool (the agent's live,
   * agent-driven Higgsfield lookup). `getElementRef` reads it, so the credit
   * spend path (`submitHiggsfieldGeneration`) anchors to a LIVE, validated
   * Higgsfield Element id — never a hardcoded/stale one, never a string the
   * model typed into its prompt. Keyed (not a scalar) so a multi-character beat
   * anchors each character to its own Element. Populated only when the tool
   * resolves EXACTLY ONE element (single `list` name match, or an explicit
   * `get`); an ambiguous (>1) `list` writes nothing → the spend path fails safe.
   * Reset per turn (not per request) so stale resolutions never leak forward.
   */
  resolvedElements?: Map<CharacterId, { elementId: string; name: string }>;
}

let _current: RunContext | null = null;

export function enterRunContext(ctx: RunContext): void {
  // Story 10.6 (AD-4 / OAQ-8): enforce the one-run-per-worker invariant. A second
  // enter before exitRunContext means two runs overlap in this process — FAIL
  // LOUD rather than silently overwrite `_current`. Silent overwrite would let a
  // tool call from one run read another run's budget / active character /
  // connector / approval state (cross-run bleed), a correctness + governance
  // hazard. This guard never fires under the single-flight engine today; it
  // defends against a future concurrent/multi-flight server or a leaked run.
  if (_current !== null) {
    throw new Error(
      `RunContext concurrency violation: enterRunContext("${ctx.runId}") called ` +
        `while run "${_current.runId}" is still active. Overlapping runs in one ` +
        `worker are not allowed — ensure exitRunContext() (handle.dispose()) runs ` +
        `before starting a new run.`,
    );
  }
  _current = ctx;
}

export function exitRunContext(): void {
  _current = null;
}

export function currentRunContext(): RunContext | null {
  return _current;
}

export function bumpStepCounter(): number {
  if (!_current) return 0;
  _current.stepCounter += 1;
  return _current.stepCounter;
}

export function addToTotalCost(usd: number): number {
  if (!_current) return 0;
  _current.totalCostUsd += usd;
  return _current.totalCostUsd;
}

/**
 * Test-only direct setter. DELIBERATELY BYPASSES the {@link enterRunContext}
 * concurrency guard (it assigns `_current` directly) so tests can force-set or
 * force-clear run-scoped state — including overwriting an active context —
 * without tripping the Story 10.6 guard.
 */
export function __setCurrentRunContextForTests(ctx: RunContext | null): void {
  _current = ctx;
}
