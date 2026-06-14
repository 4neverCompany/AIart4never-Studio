/**
 * v1.2.3 — Eval heuristic: length budget.
 *
 * Measures the prompt word count against the director's ideal
 * 50-150 word range. Too short = the model under-elaborated;
 * too long = the model padded (or the loop's prompt rewriter
 * wasn't applied).
 *
 * The thresholds come from the MCSLA director protocol's
 * "the final assistant text is what the user sees. It MUST
 * be the prompt draft (40-150 words)" rule.
 *
 * Score: 1.0 inside [50, 150], 0.5 in [25, 50) or (150, 200],
 * 0.0 outside.
 *
 * Pure function, no IO. Snapshot-tested in `aggregate.test.ts`.
 */

const IDEAL_MIN = 50;
const IDEAL_MAX = 150;
const SOFT_MIN = 25;
const SOFT_MAX = 200;

export interface LengthBudgetResult {
  /** 0..1. */
  score: number;
  /** Raw word count. */
  wordCount: number;
  /** True if the prompt is inside the ideal range. */
  withinIdeal: boolean;
  /** True if the prompt is in the soft range (one step outside ideal). */
  withinSoft: boolean;
}

export function evalLength(prompt: string): LengthBudgetResult {
  // Word count via split on whitespace. Filters out empty tokens
  // so double-spaces don't inflate the count.
  const tokens = prompt.split(/\s+/).filter((s) => s.length > 0);
  const wordCount = tokens.length;
  const withinIdeal = wordCount >= IDEAL_MIN && wordCount <= IDEAL_MAX;
  const withinSoft = wordCount >= SOFT_MIN && wordCount <= SOFT_MAX;
  let score: number;
  if (withinIdeal) {
    score = 1;
  } else if (withinSoft) {
    score = 0.5;
  } else {
    score = 0;
  }
  return { score, wordCount, withinIdeal, withinSoft };
}
