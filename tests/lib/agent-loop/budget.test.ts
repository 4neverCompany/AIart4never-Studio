/**
 * v1.2 — Director Route 2.0 budget-tracker tests.
 *
 * Unit tests for `BudgetTracker`, `BudgetExceededError`,
 * `estimateStepCost`, and the `getPricing` lookup table.
 *
 * No IO, no time. The tracker is pure state — no need for
 * `fake-indexeddb` or any other setup.
 */
import { describe, it, expect } from 'vitest';
import {
  BudgetTracker,
  BudgetExceededError,
  estimateStepCost,
  getPricing,
  MODEL_PRICING,
  DEFAULT_PRICING,
} from '@/lib/agent-loop/budget';

describe('BudgetTracker — basic accumulation', () => {
  it('starts at 0', () => {
    const t = new BudgetTracker(1.0);
    expect(t.total).toBe(0);
    expect(t.remaining).toBe(1.0);
  });

  it('accumulates cost in order', () => {
    const t = new BudgetTracker(1.0);
    t.record(0.1);
    t.record(0.2);
    t.record(0.05);
    expect(t.total).toBeCloseTo(0.35, 6);
    expect(t.remaining).toBeCloseTo(0.65, 6);
  });

  it('treats remaining as 0 once exceeded', () => {
    const t = new BudgetTracker(0.5);
    try {
      t.record(0.6);
    } catch {
      // expected — the throw is the budget-stop behaviour
    }
    expect(t.remaining).toBe(0);
  });
});

describe('BudgetTracker — hard-stop', () => {
  it('throws BudgetExceededError when a single step exceeds the limit', () => {
    const t = new BudgetTracker(0.5);
    expect(() => t.record(0.6)).toThrow(BudgetExceededError);
  });

  it('throws when accumulated cost crosses the limit', () => {
    const t = new BudgetTracker(0.5);
    t.record(0.3);
    t.record(0.1);
    expect(() => t.record(0.2)).toThrow(BudgetExceededError);
  });

  it('does NOT throw at exactly the limit (overflow check is strict >)', () => {
    const t = new BudgetTracker(0.5);
    t.record(0.5);
    expect(t.total).toBe(0.5);
    // A second $0 step keeps us at 0.5 (no throw).
    t.record(0);
    expect(t.total).toBe(0.5);
  });

  it('throws on the first step that pushes past the limit (one-step overshoot)', () => {
    // Documents the documented overshoot behaviour:
    // `stopWhen` checks BEFORE the next step, so a single
    // step can push `total` past the limit before the
    // stop condition fires.
    const t = new BudgetTracker(0.5);
    t.record(0.4);
    expect(() => t.record(0.3)).toThrow(BudgetExceededError);
  });

  it('BudgetExceededError carries the spent / limit / stepCost fields', () => {
    const t = new BudgetTracker(0.5);
    t.record(0.4);
    try {
      t.record(0.3);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExceededError);
      const err = e as BudgetExceededError;
      expect(err.code).toBe('BUDGET_EXCEEDED');
      expect(err.spent).toBeCloseTo(0.7, 6);
      expect(err.limit).toBe(0.5);
      expect(err.stepCost).toBeCloseTo(0.3, 6);
      expect(err.message).toMatch(/Budget exceeded/);
    }
  });
});

describe('BudgetTracker — input validation', () => {
  it('rejects zero limit', () => {
    expect(() => new BudgetTracker(0)).toThrow();
  });

  it('rejects negative limit', () => {
    expect(() => new BudgetTracker(-1)).toThrow();
  });

  it('rejects NaN limit', () => {
    expect(() => new BudgetTracker(NaN)).toThrow();
  });

  it('rejects non-finite cost and treats it as 0', () => {
    const t = new BudgetTracker(0.5);
    t.record(NaN);
    t.record(Infinity);
    t.record(-0.1);
    expect(t.total).toBe(0);
  });
});

describe('estimateStepCost — pricing math', () => {
  it('returns 0 for a 0-token call', () => {
    expect(estimateStepCost({ inputTokens: 0, outputTokens: 0 }, 'MiniMax-M3')).toBe(0);
  });

  it('returns 0 for a missing usage record', () => {
    expect(estimateStepCost(undefined, 'MiniMax-M3')).toBe(0);
  });

  it('applies per-model rates correctly for MiniMax-M3', () => {
    // M3: $0.50 / 1M input, $2.00 / 1M output.
    // 1M input + 0.5M output = $0.50 + $1.00 = $1.50
    const cost = estimateStepCost({ inputTokens: 1_000_000, outputTokens: 500_000 }, 'MiniMax-M3');
    expect(cost).toBeCloseTo(1.5, 6);
  });

  it('applies per-model rates correctly for gpt-4o-mini', () => {
    // $0.15 / 1M input, $0.60 / 1M output.
    // 1M + 0.25M = $0.15 + $0.15 = $0.30
    const cost = estimateStepCost({ inputTokens: 1_000_000, outputTokens: 250_000 }, 'gpt-4o-mini');
    expect(cost).toBeCloseTo(0.3, 6);
  });

  it('falls back to the conservative default for unknown models', () => {
    const defaultCost = estimateStepCost(
      { inputTokens: 1_000_000, outputTokens: 0 },
      'unknown-model-xyz',
    );
    const expected = (1_000_000 / 1_000_000) * DEFAULT_PRICING.inputPerMTokens;
    expect(defaultCost).toBeCloseTo(expected, 6);
  });

  it('treats missing inputTokens / outputTokens as 0', () => {
    expect(estimateStepCost({ inputTokens: undefined, outputTokens: 1000 }, 'MiniMax-M3')).toBeCloseTo(
      (1000 / 1_000_000) * 2.0,
      10,
    );
  });
});

describe('getPricing', () => {
  it('returns the table entry for known models', () => {
    expect(getPricing('MiniMax-M3')).toEqual(MODEL_PRICING['MiniMax-M3']);
    expect(getPricing('gpt-4o-mini')).toEqual(MODEL_PRICING['gpt-4o-mini']);
  });

  it('returns the default for unknown models', () => {
    expect(getPricing('definitely-not-a-real-model')).toEqual(DEFAULT_PRICING);
  });
});
