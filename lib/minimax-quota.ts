/**
 * MiniMax monthly token-quota tracker (FR-21 / spend & quota).
 *
 * The MiniMax Token Plan is a FLAT subscription with a monthly token
 * allowance — not pay-per-call. So the meter that matters for this
 * product is TOKENS consumed per billing cycle against the tier's
 * monthly allowance, NOT dollars. This module persists the running
 * monthly token total, auto-rolls it over at each calendar month, and
 * answers "are we within quota / how close are we?" so the autonomy
 * loop can throttle BEFORE the subscription is exhausted (hitting the
 * allowance means MiniMax itself starts refusing calls mid-month).
 *
 * Reuse note: this mirrors lib/credit-budget.ts (persisted counter +
 * cap + override + change-event) but meters tokens with automatic
 * calendar-month rollover instead of Higgsfield image credits with a
 * manual reset. The per-call token counts come from the same
 * `LanguageModelUsage { inputTokens, outputTokens }` shape that
 * lib/agent-loop/budget.ts already consumes.
 *
 * Storage: lib/persistence.ts (Tauri-store + IDB fallback), key
 * `aiart4never_minimax_quota`. Shape is opaque to the rest of the app;
 * always go through the exported helpers so it can evolve.
 */

import { get, set } from './persistence';

const QUOTA_KEY = 'aiart4never_minimax_quota';

export interface MinimaxQuotaUsage {
  /** Cumulative tokens (input + output) used in the current billing period. */
  tokensUsed: number;
  /** Billing period this counter belongs to, "YYYY-MM" (UTC). Drives
   *  automatic rollover: a load in a new month returns a zeroed period. */
  period: string;
  /** Wall-clock ms when the current period started (for "since …" UI). */
  cycleStartMs: number;
  /** User has explicitly overridden the cap for this period (escape
   *  hatch — clears on rollover). When true, the gate is bypassed. */
  override: boolean;
}

/** MiniMax Token-Plan tiers. `custom` = the operator set an explicit cap. */
export type MinimaxTier = 'plus' | 'max' | 'ultra' | 'custom';

/**
 * Monthly M3-token allowance per Token-Plan tier.
 *
 * `ultra` (~12.5B M3 tokens/month) is from the operator's live account.
 * `plus` / `max` are CONSERVATIVE ESTIMATES pending confirmation — the
 * operator can always override with a `custom` cap in Settings, so a
 * wrong estimate only affects the default warn/stop point, never the
 * actual subscription.
 */
export const MINIMAX_TIER_ALLOWANCE: Readonly<
  Record<Exclude<MinimaxTier, 'custom'>, number>
> = Object.freeze({
  plus: 2_000_000_000, // ~2B  — estimate, confirm against the live plan
  max: 5_000_000_000, // ~5B  — estimate, confirm against the live plan
  ultra: 12_500_000_000, // ~12.5B — verified (operator account)
});

/** Default warn threshold: surface a banner once this fraction of the
 *  monthly allowance is consumed, before the hard stop at 100%. */
export const DEFAULT_WARN_THRESHOLD = 0.9;

/** Window event the banner / Settings UI listen to so they re-read
 *  after a recorded call, a reset, or an override toggle. */
export const MINIMAX_QUOTA_CHANGED_EVENT = 'aiart4never:minimax-quota-changed';

/** Compute the "YYYY-MM" (UTC) billing period for a timestamp. */
export function periodFor(nowMs: number): string {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function emitChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(MINIMAX_QUOTA_CHANGED_EVENT));
}

/**
 * Resolve a tier (+ optional custom cap) to a monthly token allowance.
 * Returns 0 for "no cap" (custom tier with no/zero cap set) — callers
 * treat 0 as "tracking only, never block".
 */
export function resolveAllowance(
  tier: MinimaxTier | undefined,
  customCap?: number,
): number {
  if (tier === 'custom' || tier === undefined) {
    return typeof customCap === 'number' && customCap > 0 ? customCap : 0;
  }
  return MINIMAX_TIER_ALLOWANCE[tier] ?? 0;
}

/**
 * Read the current month's usage. Auto-rolls-over: if the persisted
 * record belongs to an earlier month (or nothing is persisted), returns
 * a zeroed record for the current period. The rollover is not persisted
 * until the next {@link recordTokens} write — reads stay pure.
 */
export async function loadQuotaUsage(nowMs: number = Date.now()): Promise<MinimaxQuotaUsage> {
  const period = periodFor(nowMs);
  const raw = await get<Partial<MinimaxQuotaUsage>>(QUOTA_KEY);
  if (!raw || raw.period !== period) {
    return { tokensUsed: 0, period, cycleStartMs: nowMs, override: false };
  }
  return {
    tokensUsed:
      typeof raw.tokensUsed === 'number' && raw.tokensUsed >= 0 ? raw.tokensUsed : 0,
    period,
    cycleStartMs:
      typeof raw.cycleStartMs === 'number' && raw.cycleStartMs > 0
        ? raw.cycleStartMs
        : nowMs,
    override: raw.override === true,
  };
}

/** Persist the whole record. Caller owns the merge. */
export async function saveQuotaUsage(usage: MinimaxQuotaUsage): Promise<void> {
  await set(QUOTA_KEY, usage);
}

/**
 * Record the token usage of one LLM call against the current month.
 * Negative / non-finite inputs are clamped to 0 (the SDK can return
 * `usage: undefined`). Auto-rolls-over across a month boundary.
 */
export async function recordTokens(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  nowMs: number = Date.now(),
): Promise<MinimaxQuotaUsage> {
  const input = Number.isFinite(inputTokens) && (inputTokens as number) > 0 ? (inputTokens as number) : 0;
  const output = Number.isFinite(outputTokens) && (outputTokens as number) > 0 ? (outputTokens as number) : 0;
  const cur = await loadQuotaUsage(nowMs);
  const next: MinimaxQuotaUsage = {
    tokensUsed: cur.tokensUsed + input + output,
    period: cur.period,
    cycleStartMs: cur.cycleStartMs || nowMs,
    override: cur.override,
  };
  await saveQuotaUsage(next);
  emitChanged();
  return next;
}

/** Start a fresh period now (manual reset). Clears the override. */
export async function resetQuotaCycle(nowMs: number = Date.now()): Promise<MinimaxQuotaUsage> {
  const next: MinimaxQuotaUsage = {
    tokensUsed: 0,
    period: periodFor(nowMs),
    cycleStartMs: nowMs,
    override: false,
  };
  await saveQuotaUsage(next);
  emitChanged();
  return next;
}

/** Flip the per-period override without touching the running total. */
export async function setQuotaOverride(flag: boolean, nowMs: number = Date.now()): Promise<MinimaxQuotaUsage> {
  const cur = await loadQuotaUsage(nowMs);
  const next: MinimaxQuotaUsage = { ...cur, override: flag };
  await saveQuotaUsage(next);
  emitChanged();
  return next;
}

export interface QuotaCheck {
  /** Is another call allowed under the cap right now? */
  allowed: boolean;
  /** Fraction of the allowance consumed, 0..1 (0 when no cap). */
  percent: number;
  /** Should the UI surface a "running low" warning (past the threshold,
   *  not yet over)? */
  warn: boolean;
  reason: 'no-cap' | 'override' | 'within' | 'warn' | 'exceeded';
}

/**
 * Pure gate: given the monthly allowance + current usage, decide whether
 * another call is allowed and how close we are. Pure so unit tests don't
 * mock persistence.
 *
 *   1. allowance <= 0      → always allowed (tracking only, no cap).
 *   2. override            → always allowed (still reports percent/warn).
 *   3. used >= allowance   → BLOCKED ('exceeded').
 *   4. used >= warn*allow. → allowed, 'warn'.
 *   5. otherwise           → allowed, 'within'.
 */
export function checkQuota(
  allowance: number,
  usage: MinimaxQuotaUsage,
  warnThreshold: number = DEFAULT_WARN_THRESHOLD,
): QuotaCheck {
  if (!(allowance > 0)) {
    return { allowed: true, percent: 0, warn: false, reason: 'no-cap' };
  }
  const percent = Math.min(1, usage.tokensUsed / allowance);
  const overWarn = usage.tokensUsed >= allowance * warnThreshold;
  if (usage.override) {
    return { allowed: true, percent, warn: overWarn, reason: 'override' };
  }
  if (usage.tokensUsed >= allowance) {
    return { allowed: false, percent, warn: true, reason: 'exceeded' };
  }
  if (overWarn) {
    return { allowed: true, percent, warn: true, reason: 'warn' };
  }
  return { allowed: true, percent, warn: false, reason: 'within' };
}

/** Human-readable "1.2B / 12.5B tokens this month (10%)" style summary. */
export function formatQuota(usage: MinimaxQuotaUsage, allowance: number): string {
  const used = formatTokenCount(usage.tokensUsed);
  if (!(allowance > 0)) return `${used} tokens used this month (no cap)`;
  const cap = formatTokenCount(allowance);
  const pct = Math.round(Math.min(1, usage.tokensUsed / allowance) * 100);
  return `${used} / ${cap} tokens this month (${pct}%)`;
}

/** Compact token count: 1_250_000_000 → "1.25B". */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}
