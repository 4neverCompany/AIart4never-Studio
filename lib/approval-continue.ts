// V030-005: decide whether a bulk approval should auto-start the pipeline.
//
// User flow the task describes:
//   - user approves batch → pipeline auto-fills the rest of the week
//   - if user rejects / approves nothing → pipeline does NOT kick itself off
//
// The decision is isolated here so the panel can stay declarative and the
// rule is covered by tests without mounting React.

export interface AutoContinueInput {
  /** Pipeline run state — we only auto-start when idle. */
  pipelineRunning: boolean;
  /** True iff this call came from a bulk/all action (select ≥2 ids). */
  isBulk: boolean;
  /** Count of posts whose status just flipped to `scheduled`. */
  approvedCount: number;
  /** Is the N-day window already at or over target? */
  weekFilled: boolean;
  /** Count of `Idea` entries still in 'idea' status (fuel for more runs). */
  pendingIdeaCount: number;
}

/**
 * Returns true when the pipeline should kick itself off after a bulk
 * approval:
 *
 *   1. pipeline is currently idle (respect in-flight runs — never fight
 *      a running daemon),
 *   2. the action was a bulk action and at least one post was approved
 *      (single-click approvals should not trigger full runs — the user
 *      is clearly reviewing one at a time), AND
 *   3. there's still work to do — either the week isn't filled yet OR
 *      there are ideas queued that want to be processed.
 *
 * If none of the above, the caller must not auto-start — respect the
 * user's manual control.
 */
export function shouldAutoContinuePipeline(input: AutoContinueInput): boolean {
  if (input.pipelineRunning) return false;
  if (!input.isBulk) return false;
  if (input.approvedCount < 1) return false;
  if (input.weekFilled && input.pendingIdeaCount === 0) return false;
  return true;
}
