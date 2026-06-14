// V1.0.7-PROMPT-ENG-D: pin the credit-budget contract that
// `hooks/useImageGeneration.ts` (gate at submitHiggsfieldImage)
// and the Settings + banner UI rely on.
//
// The persistence helpers (`loadCreditUsage`, `saveCreditUsage`,
// `incrementCredits`, `resetCycle`, `setOverride`) go through
// `lib/persistence.ts` which is a real IDB / Tauri-store wrapper
// — these tests focus on the pure logic in `checkBudget` plus
// the shape of the persistence helpers via the underlying
// `idb-keyval` mock that `lib/persistence.ts` already exercises.

import { describe, it, expect } from 'vitest';
import {
  type CreditUsage,
  checkBudget,
  formatUsage,
} from '@/lib/credit-budget';

const baseUsage: CreditUsage = { used: 0, cycleStartMs: 0, override: false };

describe('checkBudget', () => {
  it('allows when no cap is set', () => {
    expect(checkBudget(undefined, baseUsage)).toEqual({
      allowed: true,
      percent: 0,
      reason: 'no-cap',
    });
  });

  it('allows when cap is 0 (defensive — the Settings UI filters this)', () => {
    expect(checkBudget(0, baseUsage)).toMatchObject({ allowed: true, reason: 'no-cap' });
  });

  it('allows when usage is below the cap', () => {
    const r = checkBudget(100, { ...baseUsage, used: 79 });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('within-budget');
    expect(r.percent).toBeCloseTo(0.79, 2);
  });

  it('blocks when usage equals the cap', () => {
    const r = checkBudget(100, { ...baseUsage, used: 100 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('cap-exceeded');
    expect(r.percent).toBe(1);
  });

  it('blocks when usage exceeds the cap', () => {
    const r = checkBudget(100, { ...baseUsage, used: 137 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('cap-exceeded');
    // percent clamps to 1
    expect(r.percent).toBe(1);
  });

  it('allows with override even when over cap', () => {
    const r = checkBudget(100, { ...baseUsage, used: 250, override: true });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('override');
  });

  it('percent is 0 (not NaN) when cap is 0 and override is on', () => {
    // Edge: cap removed, override flag still set from a previous
    // session. The function should treat this as no-cap and report
    // 0 percent so the banner doesn't show a confusing 100%.
    const r = checkBudget(0, { ...baseUsage, used: 50, override: true });
    expect(r.allowed).toBe(true);
    expect(r.percent).toBe(0);
  });
});

describe('formatUsage', () => {
  it('shows "no cap" when cap is undefined or 0', () => {
    expect(formatUsage({ ...baseUsage, used: 42 }, undefined)).toBe('42 credits used (no cap)');
    expect(formatUsage({ ...baseUsage, used: 42 }, 0)).toBe('42 credits used (no cap)');
  });

  it('shows "X / Y credits used" when cap is set', () => {
    expect(formatUsage({ ...baseUsage, used: 750 }, 1000)).toBe('750 / 1000 credits used');
  });
});
