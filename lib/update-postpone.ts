// FEAT-006 / SHOULDFIX-001: pure decision logic for the UpdateChecker
// postpone watchdog. Lives outside the component so vitest can cover the
// critical "should we install now?" rule without jsdom + RTL.
//
// The watchdog itself (effect subscribing to pipeline-busy + setInterval
// as a defensive backstop) lives in components/UpdateChecker.tsx; this
// module exposes the constants + predicate it depends on.

// Max time to postpone an install when a pipeline run is in flight.
// After this elapses, install fires regardless — the update is always
// more important than the in-flight idea after 2h of waiting.
export const PIPELINE_POSTPONE_MAX_MS = 120 * 60 * 1000;

// Poll cadence while postponed. Cheap — just reads a module-level flag.
export const PIPELINE_POSTPONE_POLL_MS = 60 * 1000;

/** Deadline the watchdog transitions to when it enters 'postponed' state. */
export function computePostponeDeadline(now: number): number {
  return now + PIPELINE_POSTPONE_MAX_MS;
}

/**
 * Decision: should the watchdog fire the install now?
 * True iff pipeline is idle OR the 120-min cap has elapsed.
 */
export function shouldFireInstall(now: number, deadline: number, isBusy: boolean): boolean {
  return !isBusy || now >= deadline;
}
