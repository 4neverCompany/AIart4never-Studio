/**
 * M2 keystone — the AUTONOMY LOOP public surface.
 *
 * The autonomy loop makes the agent run itself on a cadence: it consults the
 * canon weekly plan, produces or reuses the day's asset, and drops it into the
 * human approval queue (persisted `approved:false`). It NEVER publishes —
 * publishing stays operator-gated and nothing here imports `lib/publish`.
 *
 *   - types     — config, decision, tick-result, state.
 *   - scheduler — PURE timing (`shouldTick`, `nextTickAt`, day helpers).
 *   - loop      — the orchestrator (`runAutonomyTick`, `runAutonomyOnceIfDue`).
 *   - journal   — append-only persisted audit (`appendTick`, `readJournal`).
 */

export type {
  AutonomyCadence,
  AutonomyConfig,
  AutonomyDecision,
  AutonomyTickResult,
  AutonomyState,
  Weekday,
} from './types';

export { localDayKey, weekdayOf, shouldTick, nextTickAt } from './scheduler';

export {
  runAutonomyTick,
  runAutonomyOnceIfDue,
  type AutonomyTickDeps,
} from './loop';

export {
  AUTONOMY_JOURNAL_KEY,
  JOURNAL_CAP,
  appendTick,
  readJournal,
} from './journal';
