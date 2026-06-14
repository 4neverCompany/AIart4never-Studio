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
}

let _current: RunContext | null = null;

export function enterRunContext(ctx: RunContext): void {
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

export function __setCurrentRunContextForTests(ctx: RunContext | null): void {
  _current = ctx;
}
