/**
 * 4NE-15 — Own-analytics attribution → plan feedback (PURE).
 *
 * Two responsibilities, both deterministic (no `Date`, no random, no I/O):
 *   - {@link attributeEngagement} — slice the operator's own post insights three
 *     ways (by pillar, by hook, by reality), scoring each post with the SAME
 *     {@link scoreInsight} the analytics layer uses so the numbers are directly
 *     comparable to the weekly report.
 *   - {@link proposeTemplateAdjustments} — turn that breakdown into concrete,
 *     confidence-tagged proposals the weekly planner consumes: lean into the
 *     pillars/realities that beat the mean, pull back the ones that lag, and
 *     refuse to tune on thin samples (`hold`/low confidence) so we never
 *     over-fit a week or two of noise.
 *
 * Wired to the REAL analytics + canon types: `scoreInsight`/`PostInsight` from
 * `@/lib/analytics`, `CONTENT_PILLARS`/`REALITIES`/`getPillar`/`getReality` from
 * `@/lib/canon`. Pillars/realities are referenced by their canon key.
 */

import { scoreInsight } from '@/lib/analytics';
import { CONTENT_PILLARS, REALITIES, getPillar, getReality } from '@/lib/canon';
import type { RealityId } from '@/lib/canon';
import type {
  AttributedInsight,
  AttributionReport,
  DimensionStat,
  TemplateAdjustment,
} from './types';

/** Mean of `xs`, or 0 for an empty list. */
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sum of `xs` (reach is already coerced non-negative by the analytics mapper). */
function sumReach(xs: number[]): number {
  return xs.reduce((a, b) => a + (Number.isFinite(b) && b > 0 ? b : 0), 0);
}

/**
 * Group `scored` rows on `keyOf` and roll each group up into a
 * {@link DimensionStat}, sorted by `avgScore` descending. `share` is each
 * group's post count over `total` (the number of rows that HAD a key for this
 * dimension), so the shares of a single dimension sum to ~1.
 *
 * Rows whose `keyOf` returns `undefined` are skipped (e.g. an insight with no
 * `hookId` contributes nothing to `byHook`), which is why each dimension
 * carries its own denominator rather than reusing the report `sampleSize`.
 */
function rollupDimension(
  scored: { insight: AttributedInsight; score: number }[],
  keyOf: (i: AttributedInsight) => string | undefined,
): DimensionStat[] {
  const groups = new Map<string, { scores: number[]; reach: number[] }>();
  for (const { insight, score } of scored) {
    const key = keyOf(insight);
    if (key === undefined) continue;
    const g = groups.get(key) ?? { scores: [], reach: [] };
    g.scores.push(score);
    g.reach.push(insight.reach);
    groups.set(key, g);
  }

  const total = [...groups.values()].reduce((a, g) => a + g.scores.length, 0);

  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      posts: g.scores.length,
      avgScore: mean(g.scores),
      totalReach: sumReach(g.reach),
      share: total > 0 ? g.scores.length / total : 0,
    }))
    .sort((a, b) => b.avgScore - a.avgScore || a.key.localeCompare(b.key));
}

/**
 * Attribute engagement across the operator's own posts (4NE-15).
 *
 * Scores every insight once via {@link scoreInsight}, then slices three ways:
 *   - `byPillar`   — grouped on `pillarId` (insights with no pillar are skipped).
 *   - `byHook`     — grouped on `hookId` (only insights that name a hook).
 *   - `byReality`  — grouped on `reality`.
 * Each dimension is sorted best-avgScore-first; `share` sums to ~1 within a
 * dimension. Empty input → all-empty report with `sampleSize: 0`.
 */
export function attributeEngagement(insights: AttributedInsight[]): AttributionReport {
  if (insights.length === 0) {
    return { byPillar: [], byHook: [], byReality: [], sampleSize: 0 };
  }

  const scored = insights.map((insight) => ({ insight, score: scoreInsight(insight) }));

  return {
    byPillar: rollupDimension(scored, (i) => i.pillarId),
    byHook: rollupDimension(scored, (i) => i.hookId),
    byReality: rollupDimension(scored, (i) => i.reality),
    sampleSize: scored.length,
  };
}

/**
 * Relative threshold (fraction of the dimension mean) a key must clear to earn
 * an `increase`, or fall under to earn a `decrease`. 0.15 = "≥15% above the
 * mean → lean in; ≥15% below → pull back". A relative band (rather than an
 * absolute score gap) keeps the rule scale-free: it behaves the same whether
 * scores are ~2 (engagement-per-1k on a big account) or ~50 (small account).
 */
const OVERPERFORM_RATIO = 1.15;
const UNDERPERFORM_RATIO = 0.85;

/** A pillar's human-facing name for rationales, falling back to the raw id. */
function pillarLabel(pillarId: string): string {
  return getPillar(pillarId)?.name ?? pillarId;
}

/** A reality's human-facing name for rationales, falling back to the raw id. */
function realityLabel(realityId: string): string {
  const known = (REALITIES as Record<string, { id: RealityId } | undefined>)[realityId];
  return known ? getReality(known.id).name : realityId;
}

/**
 * Build confidence-tagged proposals for one dimension's stats. A key gets:
 *   - `hold`/low      when its sample is below `minSample` — don't over-fit a
 *                     thin slice; tell the planner to gather more data.
 *   - `increase`/high when avgScore ≥ mean·{@link OVERPERFORM_RATIO}.
 *   - `decrease`/high when avgScore ≤ mean·{@link UNDERPERFORM_RATIO}.
 * Keys within the dead-band (close to the mean) get no proposal — there's
 * nothing actionable to say. The dimension mean is computed only over
 * sufficiently-sampled keys so a single thin outlier can't drag the bar.
 */
function proposeForDimension(
  stats: DimensionStat[],
  dimension: 'pillar' | 'reality',
  minSample: number,
  label: (key: string) => string,
): TemplateAdjustment[] {
  const out: TemplateAdjustment[] = [];

  // Mean over the trustworthy (well-sampled) keys only — thin keys are held,
  // not used to move the bar that judges the others.
  const trusted = stats.filter((s) => s.posts >= minSample);
  const baseline = mean(trusted.map((s) => s.avgScore));

  for (const s of stats) {
    if (s.posts < minSample) {
      out.push({
        kind: 'hold',
        dimension,
        key: s.key,
        rationale: `${label(s.key)} has only ${s.posts} post${s.posts === 1 ? '' : 's'} (< ${minSample}) — too thin to tune; hold and gather more data.`,
        confidence: 'low',
      });
      continue;
    }

    // No trusted baseline to compare against (e.g. a single trusted key) → hold.
    if (baseline <= 0 || trusted.length < 2) {
      out.push({
        kind: 'hold',
        dimension,
        key: s.key,
        rationale: `${label(s.key)} has no comparable peer yet (need ≥2 well-sampled ${dimension}s) — hold.`,
        confidence: 'low',
      });
      continue;
    }

    const ratio = s.avgScore / baseline;
    if (ratio >= OVERPERFORM_RATIO) {
      out.push({
        kind: 'increase',
        dimension,
        key: s.key,
        rationale: `${label(s.key)} scored ${pct(ratio)} of the ${dimension} average (${s.posts} posts) — give it more slots.`,
        confidence: 'high',
      });
    } else if (ratio <= UNDERPERFORM_RATIO) {
      out.push({
        kind: 'decrease',
        dimension,
        key: s.key,
        rationale: `${label(s.key)} scored ${pct(ratio)} of the ${dimension} average (${s.posts} posts) — pull back or try a different angle.`,
        confidence: 'high',
      });
    }
    // else: within the dead-band — no actionable proposal.
  }

  return out;
}

/** Format a ratio as a rounded percentage string, e.g. 1.23 → "123%". */
function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/**
 * Propose concrete template adjustments from an {@link AttributionReport}
 * (4NE-15).
 *
 * Looks at the pillar and reality dimensions (the two the weekly template can
 * actually move): over-performers (≥15% above their dimension's trusted mean)
 * earn an `increase`, under-performers (≥15% below) earn a `decrease`, and any
 * key with fewer than `minSample` (default 5) posts earns a `hold` at low
 * confidence so the planner never over-fits a thin sample. Deterministic — no
 * `Date`, no random. Returns `[]` for an empty report.
 */
export function proposeTemplateAdjustments(
  report: AttributionReport,
  opts?: { minSample?: number },
): TemplateAdjustment[] {
  const minSample = Math.max(1, opts?.minSample ?? 5);
  if (report.sampleSize === 0) return [];

  return [
    ...proposeForDimension(report.byPillar, 'pillar', minSample, pillarLabel),
    ...proposeForDimension(report.byReality, 'reality', minSample, realityLabel),
  ];
}

/** The canon pillar ids, re-exposed so callers can sanity-check coverage. */
export const ATTRIBUTABLE_PILLAR_IDS: readonly string[] = CONTENT_PILLARS.map((p) => p.id);
