/**
 * v1.2 — Director Route 2.0 cost-budget tracker.
 *
 * The Director loop can run up to 8 model steps; each step is
 * a separate LLM call. Without a budget cap a runaway tool
 * call / retry loop can drain the user's provider credits
 * before they notice. The tracker is the single source of
 * truth for "how much have we spent, and should we stop now?".
 *
 * Three pieces:
 *   1. `BudgetExceededError` — thrown by `BudgetTracker.record`
 *      the moment a recorded cost pushes total spend past the
 *      limit. The Director loop catches it and stops the model
 *      with a `truncatedBy: 'budget'` result.
 *   2. `estimateStepCost(usage, modelId)` — converts the SDK's
 *      `LanguageModelUsage` to USD using a per-model pricing
 *      table. Falls back to a conservative generic rate when
 *      the model is unknown.
 *   3. `BudgetTracker` — accumulates cost and enforces the
 *      limit. Tiny on purpose (one method, one getter) so
 *      test setup is one line.
 *
 * Why throw and not return: the loop is the only caller, and
 * the model loop already uses `try/catch` for the SDK's own
 * errors. A throw is the cheapest way to bubble the abort up
 * the call stack without threading a `shouldStop` boolean
 * through every helper.
 */
import type { LanguageModelUsage } from 'ai';

/**
 * Thrown when accumulated cost crosses the configured limit.
 * The Director loop catches this specifically (so it can mark
 * the run `truncatedBy: 'budget'`) and re-throws everything
 * else as a real error.
 */
export class BudgetExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED' as const;
  readonly spent: number;
  readonly limit: number;
  readonly stepCost: number;

  constructor(spent: number, limit: number, stepCost: number) {
    super(
      `Budget exceeded: spent $${spent.toFixed(4)} of $${limit.toFixed(4)} ` +
        `limit (this step added $${stepCost.toFixed(4)})`,
    );
    this.name = 'BudgetExceededError';
    this.spent = spent;
    this.limit = limit;
    this.stepCost = stepCost;
    // ES2022 `Error` options would be cleaner but we want to
    // support the Vite ES2017 transpile target the project
    // already uses.
    Object.setPrototypeOf(this, BudgetExceededError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Pricing — USD per 1M tokens (input, output).
//
// Numbers come from each provider's public pricing page as of
// 2026-06-07. Update the table when prices change; the loop
// doesn't need a code change.
//
// Pricing is intentionally conservative for unknown models —
// a runaway cost on a new model hurts more than a slightly
// over-cautious cap on a cheap one. The Director loop is
// designed to fail-safe.
// ---------------------------------------------------------------------------

export interface PricingTable {
  /** USD per 1M input tokens. */
  inputPerMTokens: number;
  /** USD per 1M output tokens. */
  outputPerMTokens: number;
}

/**
 * Per-model pricing in USD per 1M tokens. `null` falls back to
 * the conservative default below.
 */
export const MODEL_PRICING: Readonly<Record<string, PricingTable>> = Object.freeze({
  // MiniMax (m2.7 / M3 family). Public pricing as of 2026-06.
  'MiniMax-M3': { inputPerMTokens: 0.50, outputPerMTokens: 2.00 },
  'MiniMax-M2.7-highspeed': { inputPerMTokens: 0.40, outputPerMTokens: 1.50 },
  'MiniMax-M2.5': { inputPerMTokens: 0.20, outputPerMTokens: 1.50 },
  // OpenAI.
  'gpt-4o-mini': { inputPerMTokens: 0.15, outputPerMTokens: 0.60 },
  'gpt-4o': { inputPerMTokens: 2.50, outputPerMTokens: 10.00 },
  // Mock / eval — free.
  mock: { inputPerMTokens: 0, outputPerMTokens: 0 },
});

/** Conservative default for models not in the table. */
export const DEFAULT_PRICING: PricingTable = Object.freeze({
  inputPerMTokens: 1.00,
  outputPerMTokens: 4.00,
});

/**
 * Look up the pricing for a model id. Returns the
 * `DEFAULT_PRICING` for unknown models so the loop is
 * fail-safe — see module header.
 */
export function getPricing(modelId: string): PricingTable {
  return MODEL_PRICING[modelId] ?? DEFAULT_PRICING;
}

/**
 * Compute the USD cost for a single LLM call. `usage` is the
 * SDK's `LanguageModelUsage` (or a partial — the function
 * only reads `inputTokens` / `outputTokens`, both of which
 * are `number | undefined` on the SDK type). Missing values
 * are treated as 0.
 *
 * Accepting a partial here keeps the test suite and any
 * downstream caller that wraps a `LanguageModelUsage`
 * shape (the SDK adds `inputTokenDetails`,
 * `outputTokenDetails`, `totalTokens` that we don't need)
 * free of "fill-in the unused fields" boilerplate.
 *
 * The function is pure (no IO, no time) so the unit test
 * can pin prices without mocking the clock.
 */
export function estimateStepCost(
  usage: Pick<LanguageModelUsage, 'inputTokens' | 'outputTokens'> | undefined,
  modelId: string,
): number {
  const pricing = getPricing(modelId);
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  const inputCost = (input / 1_000_000) * pricing.inputPerMTokens;
  const outputCost = (output / 1_000_000) * pricing.outputPerMTokens;
  return inputCost + outputCost;
}

/**
 * Accumulator + enforcer. `record(cost)` adds to the running
 * total and throws `BudgetExceededError` if the new total
 * exceeds the limit. `total` is the current spend.
 *
 * The class is intentionally tiny. Composing two BudgetTrackers
 * (e.g. "per-run" + "global hourly") is trivial — the caller
 * wraps `record` and re-throws. We don't pre-build that
 * composition because the Director route is the only caller
 * and it only needs a per-run cap.
 */
export class BudgetTracker {
  private spent: number = 0;
  readonly limit: number;

  constructor(limit: number) {
    if (!(limit > 0)) {
      // Reject negative / zero / NaN — a budget of $0 would
      // always throw, which is a footgun.
      throw new Error(`BudgetTracker: limit must be > 0, got ${limit}`);
    }
    this.limit = limit;
  }

  /**
   * Add `cost` (USD) to the running total. Throws
   * `BudgetExceededError` the moment the total exceeds the
   * limit. The throw happens *after* the addition so the
   * error's `spent` field reflects the post-step value (helps
   * the route's `truncatedBy` telemetry).
   */
  record(cost: number): void {
    if (!Number.isFinite(cost) || cost < 0) {
      // Don't throw on a single malformed call — the LLM
      // might have returned `usage: undefined`. Treat
      // non-finite / negative as 0 and continue.
      cost = 0;
    }
    this.spent += cost;
    if (this.spent > this.limit) {
      throw new BudgetExceededError(this.spent, this.limit, cost);
    }
  }

  /** Current spend in USD. */
  get total(): number {
    return this.spent;
  }

  /** Remaining budget in USD. Always non-negative. */
  get remaining(): number {
    return Math.max(0, this.limit - this.spent);
  }
}
