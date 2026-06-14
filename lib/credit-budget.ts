/**
 * V1.0.7-PROMPT-ENG-D: Higgsfield per-cycle credit budget.
 *
 * Tracks how many credits the user has spent this cycle against an
 * optional monthly cap. When the cap is hit and the user hasn't
 * toggled the override, `submitHiggsfieldImage` refuses the call
 * and the UI shows a blocking banner.
 *
 * Storage: `lib/persistence.ts` — same Tauri-store + IDB-fallback
 * plumbing that `mashup_settings` uses. The key is
 * `mashup_credit_usage`. Shape is opaque to the rest of the app;
 * callers should always go through `loadCreditUsage` /
 * `saveCreditUsage` so the shape can evolve.
 *
 * Cycle: v1 uses a manual-reset cycle. `cycleStartMs` is set the
 * first time the user enables tracking; clicking "Reset cycle" in
 * Settings sets it to now(). Calendar-month / 30-day rolling cycles
 * are v2 (would need a cron or on-launch rollover hook).
 *
 * Cost: v1 charges a flat 1 credit per call. Real model-aware costs
 * (Nano Banana 2 = X, Seedance 2.0 = Y) would require the model
 * specs to carry credit costs, which is out of scope for this PR.
 * The increment is parameterised by the caller so a future
 * `incrementCredits(estimatedCost)` change is one line.
 */

import { get, set } from './persistence';

const CREDIT_USAGE_KEY = 'mashup_credit_usage';

export interface CreditUsage {
  /** Total credits used in the current cycle. Persisted as number. */
  used: number;
  /** Wall-clock ms when the current cycle started. Lets the UI show
   *  "since 2 weeks ago" without computing it. */
  cycleStartMs: number;
  /** True when the user has explicitly overridden the cap for the
   *  current cycle. Persists across page reloads but clears on
   *  reset. When true, the budget gate is bypassed. */
  override: boolean;
}

const EMPTY_USAGE: CreditUsage = {
  used: 0,
  cycleStartMs: 0,
  override: false,
};

/** Read the current credit usage. Returns an empty record when
 *  nothing has been persisted yet (the UI should treat this as
 *  "0 used, no cycle started yet"). */
export async function loadCreditUsage(): Promise<CreditUsage> {
  const raw = await get<Partial<CreditUsage>>(CREDIT_USAGE_KEY);
  if (!raw) return { ...EMPTY_USAGE };
  return {
    used: typeof raw.used === 'number' && raw.used >= 0 ? raw.used : 0,
    cycleStartMs: typeof raw.cycleStartMs === 'number' ? raw.cycleStartMs : 0,
    override: raw.override === true,
  };
}

/** Write the current credit usage. Caller is responsible for
 *  merging — we just persist the whole record. */
export async function saveCreditUsage(usage: CreditUsage): Promise<void> {
  await set(CREDIT_USAGE_KEY, usage);
}

/** V1.0.7-PROMPT-ENG-D: window-level event the banner / Settings UI
 *  listen to so they re-read after a successful generation. Fires
 *  on every credit mutation (increment / reset / override). */
export const CREDIT_USAGE_CHANGED_EVENT = 'mashup:credit-usage-changed';

function emitChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CREDIT_USAGE_CHANGED_EVENT));
}

/** Atomically add `delta` to the running total. The first increment
 *  in a fresh app install also sets `cycleStartMs` (which is the
 *  signal the UI uses to know "tracking has begun"). */
export async function incrementCredits(delta: number): Promise<CreditUsage> {
  const cur = await loadCreditUsage();
  const next: CreditUsage = {
    used: cur.used + (delta > 0 ? delta : 0),
    cycleStartMs: cur.cycleStartMs || Date.now(),
    override: cur.override,
  };
  await saveCreditUsage(next);
  emitChanged();
  return next;
}

/** Zero the counter and start a fresh cycle. `override` is reset
 *  to false on a new cycle (per-cycle escape hatch — see handoff
 *  §7.3). */
export async function resetCycle(): Promise<CreditUsage> {
  const next: CreditUsage = {
    used: 0,
    cycleStartMs: Date.now(),
    override: false,
  };
  await saveCreditUsage(next);
  emitChanged();
  return next;
}

/** Flip the override flag without changing the running total or
 *  the cycle. Used by the "Override for this cycle" button. */
export async function setOverride(flag: boolean): Promise<CreditUsage> {
  const cur = await loadCreditUsage();
  const next: CreditUsage = { ...cur, override: flag };
  await saveCreditUsage(next);
  emitChanged();
  return next;
}

/** Pure check: is a new call allowed given the cap + current usage?
 *  Exposed as a pure function so the unit tests don't have to mock
 *  persistence.
 *
 *  Rules (in order):
 *   1. No cap set  → always allowed (the user hasn't enabled the gate).
 *   2. Override on → always allowed.
 *   3. usage.used < cap → allowed, percent = used / cap.
 *   4. usage.used >= cap → BLOCKED.
 */
export interface BudgetCheck {
  allowed: boolean;
  percent: number;            // 0..1 (or 0 when no cap)
  reason?: 'no-cap' | 'override' | 'within-budget' | 'cap-exceeded';
}

export function checkBudget(
  cap: number | undefined,
  usage: CreditUsage,
): BudgetCheck {
  if (cap === undefined || cap <= 0) {
    return { allowed: true, percent: 0, reason: 'no-cap' };
  }
  if (usage.override) {
    return { allowed: true, percent: Math.min(1, usage.used / cap), reason: 'override' };
  }
  const percent = Math.min(1, usage.used / cap);
  if (usage.used >= cap) {
    return { allowed: false, percent, reason: 'cap-exceeded' };
  }
  return { allowed: true, percent, reason: 'within-budget' };
}

/** Convenience: human-readable "X of Y credits used" string. */
export function formatUsage(usage: CreditUsage, cap: number | undefined): string {
  if (cap === undefined || cap <= 0) {
    return `${usage.used} credits used (no cap)`;
  }
  return `${usage.used} / ${cap} credits used`;
}
