import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the persistence layer with an in-memory store — we're unit-testing
// the quota LOGIC, not the Tauri-store / IDB backend. vi.hoisted keeps the
// store reference valid inside the hoisted vi.mock factory.
const { store } = vi.hoisted(() => ({ store: new Map<string, unknown>() }));
vi.mock('@/lib/persistence', () => ({
  get: async (key: string) => store.get(key),
  set: async (key: string, value: unknown) => {
    store.set(key, value);
  },
}));

import {
  MINIMAX_TIER_ALLOWANCE,
  DEFAULT_WARN_THRESHOLD,
  periodFor,
  resolveAllowance,
  checkQuota,
  formatQuota,
  formatTokenCount,
  loadQuotaUsage,
  recordTokens,
  resetQuotaCycle,
  setQuotaOverride,
  type MinimaxQuotaUsage,
} from '@/lib/minimax-quota';

// A couple of fixed timestamps so nothing depends on the wall clock.
const JAN_2026 = Date.UTC(2026, 0, 15, 12, 0, 0); // 2026-01-15
const FEB_2026 = Date.UTC(2026, 1, 3, 9, 0, 0); //  2026-02-03

function usage(partial: Partial<MinimaxQuotaUsage>): MinimaxQuotaUsage {
  return { tokensUsed: 0, period: '2026-01', cycleStartMs: JAN_2026, override: false, ...partial };
}

describe('periodFor', () => {
  it('formats the UTC year-month', () => {
    expect(periodFor(JAN_2026)).toBe('2026-01');
    expect(periodFor(FEB_2026)).toBe('2026-02');
    expect(periodFor(Date.UTC(2026, 11, 31, 23, 59))).toBe('2026-12');
  });
});

describe('resolveAllowance', () => {
  it('maps each tier to its monthly allowance', () => {
    expect(resolveAllowance('plus')).toBe(MINIMAX_TIER_ALLOWANCE.plus);
    expect(resolveAllowance('max')).toBe(MINIMAX_TIER_ALLOWANCE.max);
    expect(resolveAllowance('ultra')).toBe(12_500_000_000);
  });
  it('uses the custom cap for the custom tier', () => {
    expect(resolveAllowance('custom', 9_000_000)).toBe(9_000_000);
  });
  it('returns 0 (no cap) for custom without a positive cap, or undefined tier', () => {
    expect(resolveAllowance('custom')).toBe(0);
    expect(resolveAllowance('custom', 0)).toBe(0);
    expect(resolveAllowance('custom', -5)).toBe(0);
    expect(resolveAllowance(undefined)).toBe(0);
  });
});

describe('checkQuota', () => {
  it('no cap → always allowed', () => {
    const r = checkQuota(0, usage({ tokensUsed: 999 }));
    expect(r).toEqual({ allowed: true, percent: 0, warn: false, reason: 'no-cap' });
  });
  it('within budget below the warn threshold', () => {
    const r = checkQuota(1000, usage({ tokensUsed: 500 }));
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('within');
    expect(r.warn).toBe(false);
    expect(r.percent).toBeCloseTo(0.5);
  });
  it('warns past the threshold but still allows', () => {
    const r = checkQuota(1000, usage({ tokensUsed: 950 }), 0.9);
    expect(r.allowed).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.reason).toBe('warn');
  });
  it('blocks at/over the allowance', () => {
    const r = checkQuota(1000, usage({ tokensUsed: 1000 }));
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('exceeded');
    expect(r.percent).toBe(1);
  });
  it('override bypasses the block but still reports percent + warn', () => {
    const r = checkQuota(1000, usage({ tokensUsed: 1200, override: true }));
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('override');
    expect(r.warn).toBe(true);
    expect(r.percent).toBe(1); // clamped
  });
  it('uses DEFAULT_WARN_THRESHOLD when none is passed', () => {
    const justUnder = checkQuota(1000, usage({ tokensUsed: Math.floor(1000 * DEFAULT_WARN_THRESHOLD) - 1 }));
    expect(justUnder.warn).toBe(false);
    const atThreshold = checkQuota(1000, usage({ tokensUsed: 1000 * DEFAULT_WARN_THRESHOLD }));
    expect(atThreshold.warn).toBe(true);
  });
});

describe('formatTokenCount', () => {
  it('renders compact magnitudes', () => {
    expect(formatTokenCount(950)).toBe('950');
    expect(formatTokenCount(1500)).toBe('1.5K');
    expect(formatTokenCount(2_300_000)).toBe('2.3M');
    expect(formatTokenCount(12_500_000_000)).toBe('12.50B');
  });
});

describe('formatQuota', () => {
  it('shows used/cap/percent with a cap', () => {
    expect(formatQuota(usage({ tokensUsed: 1_250_000_000 }), 12_500_000_000)).toBe(
      '1.25B / 12.50B tokens this month (10%)',
    );
  });
  it('shows "no cap" without a cap', () => {
    expect(formatQuota(usage({ tokensUsed: 5_000_000 }), 0)).toBe('5.0M tokens used this month (no cap)');
  });
});

describe('persistence-backed counters (mocked store)', () => {
  beforeEach(() => store.clear());

  it('records token usage and accumulates within a period', async () => {
    const a = await recordTokens(100, 50, JAN_2026);
    expect(a.tokensUsed).toBe(150);
    const b = await recordTokens(10, 5, JAN_2026);
    expect(b.tokensUsed).toBe(165);
    expect(b.period).toBe('2026-01');
  });

  it('clamps undefined / negative / non-finite usage to 0', async () => {
    const r = await recordTokens(undefined, -5, JAN_2026);
    expect(r.tokensUsed).toBe(0);
    const r2 = await recordTokens(Number.NaN, 7, JAN_2026);
    expect(r2.tokensUsed).toBe(7);
  });

  it('auto-rolls over to a zeroed counter in a new month', async () => {
    await recordTokens(1000, 1000, JAN_2026);
    const feb = await loadQuotaUsage(FEB_2026);
    expect(feb.tokensUsed).toBe(0);
    expect(feb.period).toBe('2026-02');
    expect(feb.override).toBe(false);
  });

  it('override persists within the period and clears on reset', async () => {
    const o = await setQuotaOverride(true, JAN_2026);
    expect(o.override).toBe(true);
    const reloaded = await loadQuotaUsage(JAN_2026);
    expect(reloaded.override).toBe(true);
    const reset = await resetQuotaCycle(JAN_2026);
    expect(reset.override).toBe(false);
  });
});
