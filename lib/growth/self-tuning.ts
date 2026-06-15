/**
 * 4NE-17 — Posting-time / hook self-tuning (PURE).
 *
 * Ranks, from the operator's own post history, the best (pillar, weekday) slots
 * and the best hooks per pillar, so the weekly planner can EXPLOIT what's
 * working. Deterministic: no `Date.now`, no random — the hour-of-day is read
 * from each post's own `postedAt`, and the clock is never consulted.
 *
 * ## Why a shrunk lower-confidence bound (and not a raw average)
 *
 * A raw per-cell average over-trusts thin cells: a single fluke post that
 * happened to score 99 would rank a Tuesday-lore slot above a Friday-story slot
 * with ten solid posts averaging 60. We score each cell with a two-part,
 * sample-size-aware estimator — an empirical-Bayes shrink toward the global
 * mean, then a small-sample uncertainty penalty (a lower-confidence bound):
 *
 *     shrunk = (n · cellAvg + K · globalMean) / (n + K)
 *     score  = shrunk − PENALTY · globalMean / sqrt(n)
 *
 *   - `n`          = posts in the cell.
 *   - `cellAvg`    = mean engagement score of those posts.
 *   - `globalMean` = mean score across ALL usable history (the prior).
 *   - `K`          = shrinkage strength ({@link SHRINKAGE_K}); think of it as
 *                    "K phantom posts pinned at the global mean".
 *   - `PENALTY`    = uncertainty weight ({@link UNCERTAINTY_PENALTY}); how hard a
 *                    thin sample is discounted for being unproven.
 *
 * The first term pulls a thin cell toward `globalMean` (we don't trust its
 * average); the second term then DISCOUNTS it for being unproven, decaying as
 * `1/sqrt(n)` so the penalty vanishes as data accumulates. Crucially the
 * penalty discounts thin cells in BOTH directions — a single high-scoring fluke
 * is pulled down hard, where pure mean-shrinkage alone would still let it win
 * if its value sat above the global mean. With lots of data the penalty → 0 and
 * `shrunk → cellAvg`, so a well-sampled cell is judged on its real average.
 * Fully deterministic (it's a ranking LCB, so a very thin cell's score can go
 * negative — that's fine, only the ORDER matters).
 *
 * ## Relationship to the inherited `smartScheduler`
 *
 * `lib/smartScheduler.ts` exists and scores *clock slots* for the calendar UI
 * (`scoreSlotDetailed`: `dayMultiplier · hourWeight + weekendBonus`, blending
 * research-backed DACH priors with raw IG like/comment sums). It is the right
 * tool for "given engagement weights, which upcoming calendar slot do I drop a
 * post into", but it is impure (reads `localStorage`, `Date`, `fetch`), it has
 * no notion of CONTENT PILLAR, and its averages aren't sample-size-aware. This
 * module answers a different question — "per pillar, which weekday/hook has
 * historically earned the most engagement, weighted by how much data backs it"
 * — so rather than wire the impure UI scorer in, we implement the documented
 * shrinkage scorer above. The two compose downstream: this module says WHICH
 * pillar→weekday/hour to favour; `smartScheduler` can still place the concrete
 * calendar slot.
 *
 * ## Exploration is the planner's job
 *
 * These functions RANK (exploit) only. Epsilon-greedy exploration — occasionally
 * trying an unproven slot/hook to keep learning — belongs to the weekly planner
 * that consumes these lists, not here, so this module stays pure and the
 * exploration policy lives in one place.
 */

import { scoreInsight } from '@/lib/analytics';
import type { Weekday } from '@/lib/analytics';
import type { AttributedInsight, HookRecommendation, SlotRecommendation } from './types';

/**
 * Shrinkage strength `K` — the number of "phantom posts" pinned at the global
 * mean that every cell is blended with. At `K = 3`, a cell needs ~3 real posts
 * before its own average carries as much weight as the prior, which lines up
 * with the channel's low weekly cadence (a handful of posts per slot). Larger
 * `K` ⇒ more conservative (trusts data more slowly); smaller ⇒ more reactive.
 */
export const SHRINKAGE_K = 3;

/**
 * Uncertainty penalty weight `PENALTY` — how hard an unproven (thin) cell is
 * discounted, as a fraction of the global mean, decaying by `1/sqrt(n)`. At
 * 0.5, a single post (`n = 1`) loses half the global mean from its score, so a
 * one-off fluke cannot out-rank a well-sampled cell; by `n = 9` the penalty is
 * a third of that, and it keeps shrinking. Larger ⇒ more skeptical of thin
 * cells; 0 ⇒ pure mean-shrinkage.
 */
export const UNCERTAINTY_PENALTY = 0.5;

/**
 * Score a cell from its average + sample size with the shrunk lower-confidence
 * bound described in the module header:
 *
 *     shrunk = (n · cellAvg + K · globalMean) / (n + K)
 *     score  = shrunk − PENALTY · globalMean / sqrt(n)
 *
 * Pure. With `n === 0` the penalty term is skipped (returns the pure prior
 * `globalMean`) so it never divides by zero; as `n` grows, `score → cellAvg`.
 */
export function shrinkScore(
  cellAvg: number,
  n: number,
  globalMean: number,
  k: number = SHRINKAGE_K,
  penalty: number = UNCERTAINTY_PENALTY,
): number {
  if (n <= 0) return globalMean;
  const shrunk = (n * cellAvg + k * globalMean) / (n + k);
  return shrunk - (penalty * globalMean) / Math.sqrt(n);
}

/** Mean of `xs`, or 0 for an empty list. */
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Hour-of-day (0..23) of a Unix-ms timestamp in UTC. We deliberately use UTC
 * (not local) so the recommendation is deterministic regardless of the machine
 * running the tune — the planner re-localises to the operator's posting TZ when
 * it places the actual slot. Non-finite timestamps yield `undefined`.
 */
function hourOf(postedAt: number): number | undefined {
  if (!Number.isFinite(postedAt)) return undefined;
  return new Date(postedAt).getUTCHours();
}

/**
 * The modal (most common) hour among a cell's TOP-scoring posts — the hour we
 * recommend posting that cell. We take the highest-scoring posts (up to
 * `topN`), bucket their hours, and return the most frequent (ties broken by
 * earliest hour for determinism). `undefined` when no post carries a usable
 * timestamp.
 */
function recommendedHourFor(
  rows: { insight: AttributedInsight; score: number }[],
  topN: number = 3,
): number | undefined {
  const top = [...rows].sort((a, b) => b.score - a.score).slice(0, Math.max(1, topN));
  const counts = new Map<number, number>();
  for (const { insight } of top) {
    const h = hourOf(insight.postedAt);
    if (h === undefined) continue;
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  let bestHour: number | undefined;
  let bestCount = -1;
  for (const [hour, count] of counts) {
    if (count > bestCount || (count === bestCount && (bestHour === undefined || hour < bestHour))) {
      bestCount = count;
      bestHour = hour;
    }
  }
  return bestHour;
}

/**
 * Recommend posting times per (pillar, weekday) (4NE-17).
 *
 * Buckets `history` on `pillarId × day`, scores each post via
 * {@link scoreInsight}, then ranks every cell by the shrinkage-weighted score
 * (see module header) so cells with more data are trusted over thin flukes.
 * `recommendedHour` is the modal hour of the cell's top posts. Insights missing
 * a `pillarId` or `day` can't name a slot and are skipped. Empty / all-skipped
 * input → `[]`. Result is sorted by `score` descending.
 */
export function recommendPostingTimes(history: AttributedInsight[]): SlotRecommendation[] {
  const usable = history
    .filter((i) => i.pillarId != null && i.day != null)
    .map((insight) => ({ insight, score: scoreInsight(insight) }));
  if (usable.length === 0) return [];

  const globalMean = mean(usable.map((r) => r.score));

  const cells = new Map<string, { pillarId: string; day: Weekday; rows: typeof usable }>();
  for (const row of usable) {
    const pillarId = row.insight.pillarId!;
    const day = row.insight.day!;
    const key = `${pillarId} ${day}`;
    const cell = cells.get(key) ?? { pillarId, day, rows: [] };
    cell.rows.push(row);
    cells.set(key, cell);
  }

  return [...cells.values()]
    .map((cell) => {
      const scores = cell.rows.map((r) => r.score);
      const n = scores.length;
      const score = shrinkScore(mean(scores), n, globalMean);
      return {
        pillarId: cell.pillarId,
        day: cell.day,
        recommendedHour: recommendedHourFor(cell.rows),
        score,
        basis: n,
      } satisfies SlotRecommendation;
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.basis - a.basis ||
        a.pillarId.localeCompare(b.pillarId) ||
        a.day.localeCompare(b.day),
    );
}

/**
 * Recommend hooks per pillar (4NE-17).
 *
 * Buckets the hook-carrying history on `pillarId × hookId`, scores each post via
 * {@link scoreInsight}, and ranks every hook by the same shrinkage-weighted
 * score as {@link recommendPostingTimes}, so a hook with more backing data is
 * trusted over a one-off. Insights without a `hookId` (or `pillarId`) are
 * skipped. Empty / all-skipped input → `[]`. Sorted by `score` descending.
 */
export function recommendHooks(history: AttributedInsight[]): HookRecommendation[] {
  const usable = history
    .filter((i) => i.pillarId != null && i.hookId != null)
    .map((insight) => ({ insight, score: scoreInsight(insight) }));
  if (usable.length === 0) return [];

  const globalMean = mean(usable.map((r) => r.score));

  const cells = new Map<string, { pillarId: string; hookId: string; scores: number[] }>();
  for (const { insight, score } of usable) {
    const pillarId = insight.pillarId!;
    const hookId = insight.hookId!;
    const key = `${pillarId} ${hookId}`;
    const cell = cells.get(key) ?? { pillarId, hookId, scores: [] };
    cell.scores.push(score);
    cells.set(key, cell);
  }

  return [...cells.values()]
    .map((cell) => {
      const n = cell.scores.length;
      return {
        pillarId: cell.pillarId,
        hookId: cell.hookId,
        score: shrinkScore(mean(cell.scores), n, globalMean),
        basis: n,
      } satisfies HookRecommendation;
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.basis - a.basis ||
        a.pillarId.localeCompare(b.pillarId) ||
        a.hookId.localeCompare(b.hookId),
    );
}
