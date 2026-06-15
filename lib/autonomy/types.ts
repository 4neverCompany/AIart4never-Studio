/**
 * M2 keystone — the AUTONOMY LOOP type model.
 *
 * The autonomy loop is what makes the agent run itself on a cadence: on each
 * due tick it consults the canon weekly plan (lib/canon/content-plan), produces
 * OR reuses the day's asset, and drops the result into the human approval queue
 * (an asset persisted with `approved: false`). It MUST NEVER publish — publishing
 * stays operator-gated (the approval gate / lib/publish), and nothing in this
 * module imports or depends on the publish path.
 *
 * Every type here is a plain JSON-serialisable record so the journal
 * (lib/autonomy/journal) can persist results verbatim through @/lib/persistence.
 */

import type { CharacterId } from '@/lib/canon';
import type { WeeklySlot } from '@/lib/canon/types';

/**
 * The canon weekday union, sourced from the canon `WeeklySlot.day` so the
 * autonomy loop and the canon plan agree on the allowed values
 * ('mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun') without redefining
 * them here.
 */
export type Weekday = WeeklySlot['day'];

/**
 * How often the loop ticks. `'daily'` is the only auto cadence (one tick per
 * local day, on/after `tickHourLocal`); `'manual'` means the scheduler never
 * fires on its own — the operator triggers a tick by hand.
 */
export type AutonomyCadence = 'daily' | 'manual';

/** Operator-controlled configuration for the autonomy loop. */
export interface AutonomyConfig {
  /** Master switch. When false the scheduler never ticks. */
  enabled: boolean;
  /** Cadence. Only 'daily' produces auto ticks; 'manual' is operator-driven. */
  cadence: AutonomyCadence;
  /** The Master4never character the loop features (shapes the plan + drafts). */
  activeCharacterId: CharacterId;
  /** Per-tick USD budget handed to the director loop as its `budgetUsd` cap. */
  dailyBudgetUsd: number;
  /** Local hour (0-23) on/after which the daily tick becomes due. */
  tickHourLocal: number;
}

/**
 * What the loop decided for a given day:
 *  - `generate` — a new asset was produced (via the director) and queued;
 *  - `reuse`    — an existing on-canon library asset was chosen and queued;
 *  - `skip`     — no work for this day (no slot, or nothing to do).
 */
export type AutonomyDecision = 'generate' | 'reuse' | 'skip';

/** The outcome of a single tick — append-only audit record. */
export interface AutonomyTickResult {
  /** Epoch ms the tick ran. */
  at: number;
  /** The local weekday the tick planned for. */
  day: Weekday;
  /** The canon pillar this day's slot maps to (absent on a no-slot/skip day). */
  pillarId?: string;
  decision: AutonomyDecision;
  /**
   * The AIart4never Studio asset id that landed in the approval queue. Set for
   * `generate` (the freshly-persisted, `approved:false` asset) and `reuse`
   * (the chosen library asset's id). Absent for `skip` and for errored ticks.
   */
  assetId?: string;
  /** True when an asset was queued for the human approval gate this tick. */
  queued: boolean;
  /** Human-readable note explaining what happened (and any budget stop). */
  note: string;
  /** Set when the tick threw; the scheduler treats this as a non-fatal miss. */
  error?: string;
}

/** Persisted scheduler state — drives `shouldTick` and surfaces the last run. */
export interface AutonomyState {
  /** Epoch ms of the last tick, or null if the loop has never ticked. */
  lastTickAt: number | null;
  /** The most recent tick's result (for the operator's "last run" panel). */
  lastResult?: AutonomyTickResult;
}
