/**
 * Story 8-11 — the persisted TUNING DECISION LOG (append-only).
 *
 * Every operator-ACCEPTED posting-time / hook change is recorded here, stamped
 * with when it was decided. The log serves two masters:
 *   - the audit trail the story requires ("the change is recorded") — the
 *     operator can always see what was tuned, when, from what baseline, and
 *     whether the applied value was edited;
 *   - the OAQ-9 experiment registry — each record pins the A/B cell
 *     (pillar × day), the new value, and the prior baseline that
 *     `measurePostingTimeChange` later compares it against (see
 *     `lib/growth/proposals.ts` for the full measurement method).
 *
 * Mirrors the autonomy journal (`lib/autonomy/journal.ts`) exactly: storage via
 * `@/lib/persistence` (Tauri-store / idb-keyval), capped at the most recent
 * {@link TUNING_DECISION_CAP} entries, tolerant reads (a corrupt store yields
 * `[]`, never a crash), and most-recent-first public reads.
 */

import { get, set } from '@/lib/persistence';
import type { AppliedTuningChange } from './proposals';

/** Persistence key for the tuning decision log. */
export const TUNING_DECISION_LOG_KEY = 'aiart4never_tuning_decisions';

/** Hard cap on retained decision records (most-recent kept). */
export const TUNING_DECISION_CAP = 200;

/**
 * One persisted decision: the applied change plus WHEN the operator decided.
 * `decidedAt` (unix ms) is the experiment's start marker — the OAQ-9
 * measurement windows the insight history from here.
 */
export type RecordedTuningChange = AppliedTuningChange & { decidedAt: number };

/**
 * Read the raw stored log in insertion order (oldest-first), tolerating a
 * missing or corrupt value by returning an empty list. Internal — public reads
 * go through {@link readTuningDecisions}, which returns most-recent-first.
 */
async function readRaw(): Promise<RecordedTuningChange[]> {
  try {
    const stored = await get<RecordedTuningChange[]>(TUNING_DECISION_LOG_KEY);
    return Array.isArray(stored) ? stored : [];
  } catch {
    // A corrupt/unavailable store must not crash the weekly run — the log is
    // best-effort audit, not load-bearing plan state.
    return [];
  }
}

/**
 * Append accepted changes to the log, capping at the most recent
 * {@link TUNING_DECISION_CAP} entries (oldest overflow dropped). An empty
 * batch is a no-op read. Returns the persisted (post-cap) list in stored order.
 */
export async function appendTuningDecisions(
  changes: readonly RecordedTuningChange[],
): Promise<RecordedTuningChange[]> {
  const current = await readRaw();
  if (changes.length === 0) return current;
  const next = [...current, ...changes];
  const capped =
    next.length > TUNING_DECISION_CAP ? next.slice(next.length - TUNING_DECISION_CAP) : next;
  await set(TUNING_DECISION_LOG_KEY, capped);
  return capped;
}

/**
 * Read the decision log, MOST-RECENT-FIRST (the last-recorded change is index
 * 0), ready for a "recent tuning decisions" view or the OAQ-9 measurement.
 */
export async function readTuningDecisions(): Promise<RecordedTuningChange[]> {
  const raw = await readRaw();
  return raw.slice().reverse();
}
