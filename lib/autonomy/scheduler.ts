/**
 * M2 autonomy loop — the PURE scheduler.
 *
 * Decides WHEN the loop is due. Every function here is deterministic and takes
 * the current time as an explicit `now: Date` parameter — this module NEVER
 * calls `Date.now()` internally, so tests can drive any wall clock and the
 * "have we already ticked today?" logic is fully reproducible.
 *
 * "Today" is measured in LOCAL time (the operator's machine timezone), because
 * the cadence is a human-facing "post once a day after my morning hour" rule.
 * The local-day key collapses a timestamp to its calendar day so two ticks on
 * the same local day are recognised as duplicates regardless of the hour.
 */

import type { AutonomyConfig, Weekday } from './types';

/**
 * Map JS `Date.getDay()` (0 = Sunday … 6 = Saturday) to the canon `Weekday`
 * union. Index-aligned with `getDay()`, so `WEEKDAYS[now.getDay()]` is the
 * local weekday.
 */
const WEEKDAYS: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** The canon weekday for `now`, in LOCAL time. */
export function weekdayOf(now: Date): Weekday {
  return WEEKDAYS[now.getDay()]!;
}

/**
 * The local-time calendar-day key for `now`, formatted 'YYYY-MM-DD'. Two
 * timestamps share a key iff they fall on the same local calendar day — this
 * is the dedupe unit for "already ticked today".
 */
export function localDayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Is a tick due right now? True ONLY when ALL of:
 *  - the loop is `enabled`;
 *  - the cadence is `'daily'` (manual cadence never auto-ticks);
 *  - the local hour is at/after `tickHourLocal`;
 *  - we have NOT already ticked during today's local day (derived from
 *    `lastTickAt`'s local-day key).
 *
 * Deterministic: depends only on `now`, `lastTickAt`, and `cfg`.
 */
export function shouldTick(
  now: Date,
  lastTickAt: number | null,
  cfg: AutonomyConfig,
): boolean {
  if (!cfg.enabled) return false;
  if (cfg.cadence !== 'daily') return false;
  if (now.getHours() < cfg.tickHourLocal) return false;
  // Already ticked today? Compare the last tick's local-day key to today's.
  if (lastTickAt != null) {
    if (localDayKey(new Date(lastTickAt)) === localDayKey(now)) return false;
  }
  return true;
}

/**
 * Epoch ms of the next due tick relative to `now`.
 *
 * - If today's tick hour hasn't arrived yet (`now.getHours() < tickHourLocal`),
 *   the next tick is TODAY at `tickHourLocal:00:00.000` local.
 * - Otherwise (today's window already open / passed), it's TOMORROW at
 *   `tickHourLocal:00:00.000` local.
 *
 * Independent of `enabled`/`cadence` — it answers "when would a daily tick land"
 * so the UI can show a countdown even while the loop is paused.
 */
export function nextTickAt(now: Date, cfg: AutonomyConfig): number {
  const candidate = new Date(now);
  candidate.setHours(cfg.tickHourLocal, 0, 0, 0);
  if (now.getHours() >= cfg.tickHourLocal) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}
