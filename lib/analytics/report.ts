/**
 * 4NE-14 — Weekly report builder (PURE).
 *
 * No `Date.now`, no I/O: `buildWeeklyReport` takes `weekStart` as a parameter
 * so the same insights always yield the same report. This is the LEARN-step
 * compute that later feeds M3's plan self-tuning.
 *
 * Two responsibilities:
 *   - {@link scoreInsight} — collapse a post's raw counters into a single
 *     comparable {@link EngagementScore} via a documented weighted formula.
 *   - {@link buildWeeklyReport} — aggregate per pillar + per weekday, pick the
 *     best/worst post and the best weekday slot, and emit concrete `proposals`.
 */

import { CONTENT_PILLARS, getPillar } from '@/lib/canon';
import type { EngagementScore, PillarRollup, PostInsight, SlotRollup, WeeklyReport, Weekday } from './types';

/**
 * Relative weight of each engagement signal. Rationale: a SAVE or SHARE is a
 * far stronger "this landed" signal than a like — it means the viewer wanted to
 * keep it or pass it on (the save-bait the channel strategy optimises for), so
 * those are weighted highest. Comments (active effort) sit above likes (a cheap
 * tap). Reach/impressions are NOT additive signals here — they're the
 * denominator (see below), because a post that reached 100k and got 100 saves
 * did NOT land as hard as one that reached 1k and got 100 saves.
 */
export const SCORE_WEIGHTS = Object.freeze({
  saves: 4,
  shares: 4,
  comments: 2,
  likes: 1,
});

/**
 * Per-1,000-reach scale: when a post has reach, we express the weighted
 * engagement as "weighted actions per 1,000 people reached" so posts with very
 * different audience sizes are comparable. (Without this, a high-reach post
 * would always out-score a high-engagement-rate small post.)
 */
const REACH_NORMALIZER = 1000;

/**
 * Collapse a post's counters into a single comparable score (higher = better).
 *
 * Formula (deterministic):
 *   weighted = 4·saves + 4·shares + 2·comments + 1·likes
 *   - reach > 0  → score = weighted / reach · 1000   (engagement per 1k reach)
 *   - reach == 0 → score = weighted                  (raw weighted actions)
 *
 * Saves and shares dominate because they're the strongest "this landed"
 * signals; normalizing by reach makes a small-but-resonant post comparable to a
 * big-but-shallow one. Negative/NaN counters are floored to 0 defensively (the
 * mapper already coerces, but the formula must never emit NaN).
 */
export function scoreInsight(p: PostInsight): EngagementScore {
  const nz = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const weighted =
    SCORE_WEIGHTS.saves * nz(p.saves) +
    SCORE_WEIGHTS.shares * nz(p.shares) +
    SCORE_WEIGHTS.comments * nz(p.comments) +
    SCORE_WEIGHTS.likes * nz(p.likes);

  const reach = nz(p.reach);
  if (reach > 0) {
    return (weighted / reach) * REACH_NORMALIZER;
  }
  return weighted;
}

/** Mean of `xs`, or 0 for an empty list. */
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** A pillar's human-facing name for proposals, falling back to the raw id. */
function pillarLabel(pillarId: string): string {
  return getPillar(pillarId)?.name ?? pillarId;
}

/**
 * Build the weekly report from `insights`.
 *
 * Aggregation:
 *   - perPillar: grouped on `pillarId` (posts missing a pillar are bucketed
 *     under `'(unknown)'`), each with post count, mean score, and total reach,
 *     sorted by mean score descending.
 *   - perSlot: grouped on `day`, each with post count + mean score, sorted by
 *     mean score descending. Posts missing a `day` are excluded from slot
 *     rollups (a slot rollup must name a weekday).
 *   - best / worst: the single highest / lowest scoring post.
 *   - bestSlot: the top perSlot entry.
 *   - proposals: concrete next-plan suggestions referencing the winning
 *     pillar/day and the weakest pillar.
 *
 * Empty input → empty rollups, no best/worst/bestSlot, and a single "no data
 * yet" proposal.
 */
export function buildWeeklyReport(
  insights: PostInsight[],
  opts: { weekStart: number },
): WeeklyReport {
  const { weekStart } = opts;

  if (insights.length === 0) {
    return {
      weekStart,
      totalPosts: 0,
      perPillar: [],
      perSlot: [],
      proposals: ['No posts landed this week — no data yet. Publish at least one post to start the LEARN loop.'],
    };
  }

  // Precompute each post's score once.
  const scored = insights.map((p) => ({ post: p, score: scoreInsight(p) }));

  // --- per-pillar rollup ----------------------------------------------------
  const UNKNOWN_PILLAR = '(unknown)';
  const byPillar = new Map<string, { scores: number[]; reach: number }>();
  for (const { post, score } of scored) {
    const key = post.pillarId ?? UNKNOWN_PILLAR;
    const bucket = byPillar.get(key) ?? { scores: [], reach: 0 };
    bucket.scores.push(score);
    bucket.reach += Number.isFinite(post.reach) && post.reach > 0 ? post.reach : 0;
    byPillar.set(key, bucket);
  }
  const perPillar: PillarRollup[] = [...byPillar.entries()]
    .map(([pillarId, b]) => ({
      pillarId,
      posts: b.scores.length,
      avgScore: mean(b.scores),
      totalReach: b.reach,
    }))
    .sort((a, b) => b.avgScore - a.avgScore);

  // --- per-slot (weekday) rollup -------------------------------------------
  const bySlot = new Map<Weekday, number[]>();
  for (const { post, score } of scored) {
    if (!post.day) continue; // a slot rollup must name a weekday
    const bucket = bySlot.get(post.day) ?? [];
    bucket.push(score);
    bySlot.set(post.day, bucket);
  }
  const perSlot: SlotRollup[] = [...bySlot.entries()]
    .map(([day, scores]) => ({ day, posts: scores.length, avgScore: mean(scores) }))
    .sort((a, b) => b.avgScore - a.avgScore);

  // --- best / worst post ----------------------------------------------------
  let best = scored[0]!;
  let worst = scored[0]!;
  for (const s of scored) {
    if (s.score > best.score) best = s;
    if (s.score < worst.score) worst = s;
  }

  const bestSlot = perSlot[0];

  // --- proposals ------------------------------------------------------------
  const proposals = buildProposals({ perPillar, perSlot, bestSlot });

  return {
    weekStart,
    totalPosts: insights.length,
    perPillar,
    perSlot,
    best: best.post,
    worst: worst.post,
    bestSlot,
    proposals,
  };
}

/**
 * Generate concrete tuning suggestions. Keeps the wording specific and
 * actionable (names the pillar + weekday) so M3's self-tuning has something to
 * latch onto — and so a human reading the report knows exactly what to change.
 */
function buildProposals(args: {
  perPillar: PillarRollup[];
  perSlot: SlotRollup[];
  bestSlot?: SlotRollup;
}): string[] {
  const { perPillar, perSlot, bestSlot } = args;
  const proposals: string[] = [];

  const topPillar = perPillar[0];
  const worstPillar = perPillar.length > 1 ? perPillar[perPillar.length - 1] : undefined;

  // Winning pillar + day → keep it there.
  if (topPillar && bestSlot) {
    proposals.push(
      `${pillarLabel(topPillar.pillarId)} scored highest on ${bestSlot.day} — keep it there.`,
    );
  } else if (topPillar) {
    proposals.push(`${pillarLabel(topPillar.pillarId)} was the top pillar — lean into it next week.`);
  }

  // Underperforming pillar → try a different hook.
  if (worstPillar && worstPillar.pillarId !== topPillar?.pillarId) {
    proposals.push(
      `${pillarLabel(worstPillar.pillarId)} underperformed — try a different hook or move its slot.`,
    );
  }

  // Weakest weekday slot → consider shifting it.
  if (perSlot.length > 1) {
    const weakestSlot = perSlot[perSlot.length - 1]!;
    if (!bestSlot || weakestSlot.day !== bestSlot.day) {
      proposals.push(`Shift the low-engagement slot off ${weakestSlot.day} — it lagged this week.`);
    }
  }

  // Always leave at least one actionable line.
  if (proposals.length === 0) {
    proposals.push('Not enough variation to tune yet — keep the current plan and gather another week of data.');
  }

  return proposals;
}

/** The canon pillar ids, exposed so callers can sanity-check rollup coverage. */
export const KNOWN_PILLAR_IDS: readonly string[] = CONTENT_PILLARS.map((p) => p.id);
