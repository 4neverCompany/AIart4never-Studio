/**
 * M3 growth-brain — shared types (4NE-15 + 4NE-17).
 *
 * The growth module is the DECIDE-step of the OBSERVE → ORIENT → DECIDE → ACT →
 * LEARN loop: it consumes the LEARN-step artefacts the analytics layer produces
 * (per-post {@link import('@/lib/analytics').PostInsight} rows + the comparable
 * {@link import('@/lib/analytics').EngagementScore}) and turns them into
 * concrete, confidence-tagged tuning proposals the weekly planner can act on.
 *
 * Framework-free + PURE by design: no SDK imports, no `Date.now`, no random.
 * Everything here is derived deterministically from the input insights, so the
 * same history always yields the same recommendations and the whole module is
 * fixture-testable WITHOUT a live Instagram connection. The attribution it
 * consumes is exactly the analytics the operator's live IG connection will
 * eventually produce — this module just needs the shape, not the wire.
 */

import type { PostInsight, Weekday } from '@/lib/analytics';

/**
 * A {@link PostInsight} enriched with the one piece of metadata the analytics
 * layer does NOT carry: which creative HOOK the post used.
 *
 * `hookId` is our own planning metadata (the analytics row only knows IG's
 * public counters + the pillar/reality/day join), so it is OPTIONAL — hook
 * attribution simply skips any insight that lacks one (`byHook` only sees the
 * insights that name a hook). Everything else is inherited verbatim from
 * `PostInsight`, so an `AttributedInsight` is a drop-in superset and scores
 * through the same `scoreInsight`.
 */
export type AttributedInsight = PostInsight & {
  /** The creative hook the post used, if known (joined from planning metadata). */
  hookId?: string;
};

/**
 * One row of an attribution breakdown: how a single dimension VALUE (a pillar
 * id, a hook id, or a reality id) performed across the analysed history.
 */
export interface DimensionStat {
  /** The dimension value — a pillarId, hookId, or RealityId. */
  key: string;
  /** Number of posts attributed to this key. */
  posts: number;
  /** Mean {@link import('@/lib/analytics').EngagementScore} across those posts. */
  avgScore: number;
  /** Sum of `reach` across those posts. */
  totalReach: number;
  /** Fraction of the dimension's total posts this key accounts for (0..1). */
  share: number;
}

/**
 * The full attribution report (4NE-15): performance sliced three ways. Each
 * dimension's rows are sorted by `avgScore` descending (best performer first).
 *
 * `byHook` only covers insights that carry a `hookId`; `sampleSize` is the
 * total number of attributed insights (the denominator for `byPillar` /
 * `byReality` shares).
 */
export interface AttributionReport {
  byPillar: DimensionStat[];
  byHook: DimensionStat[];
  byReality: DimensionStat[];
  /** Total insights that fed the report (all of them, hook or not). */
  sampleSize: number;
}

/**
 * A concrete, confidence-tagged tuning proposal for the weekly template
 * (4NE-15). The planner reads these to nudge the next plan.
 *
 *  - `increase` — this key out-performed the dimension mean; give it more slots.
 *  - `decrease` — this key under-performed; pull back / try something else.
 *  - `shift`    — move this key to a different slot (reserved for slot-dimension
 *                 proposals once the planner wires slot moves in).
 *  - `hold`     — too few posts to trust; gather more data before tuning
 *                 (always `confidence: 'low'`, so the planner won't over-fit).
 *
 * `confidence` is `'high'` only when the sample crosses `minSample`; thin
 * samples are emitted as `hold`/`low` rather than acted on.
 */
export interface TemplateAdjustment {
  kind: 'increase' | 'decrease' | 'shift' | 'hold';
  dimension: 'pillar' | 'reality' | 'slot';
  /** The canon key the adjustment targets (a pillarId or RealityId). */
  key: string;
  /** Human-readable, specific rationale (names the key + why). */
  rationale: string;
  confidence: 'low' | 'high';
}

/**
 * A ranked posting-time recommendation for one (pillar, weekday) cell (4NE-17).
 *
 * `score` is the shrinkage-weighted score (see `self-tuning.ts`); `basis` is
 * the raw sample size behind it (how many posts in that cell). `recommendedHour`
 * is the hour-of-day (0..23, local-to-`postedAt`) of the cell's top posts, when
 * a timestamp is available — the planner uses it to pick the slot's time.
 */
export interface SlotRecommendation {
  pillarId: string;
  day: Weekday;
  /** Hour-of-day (0..23) derived from the top posts' `postedAt`, if available. */
  recommendedHour?: number;
  /** Shrinkage-weighted score (blends avg engagement with sample size). */
  score: number;
  /** Raw sample size behind the score. */
  basis: number;
}

/**
 * A ranked hook recommendation for one pillar (4NE-17): which creative hook to
 * reach for next, scored with the same shrinkage weighting as the slot picker.
 */
export interface HookRecommendation {
  pillarId: string;
  hookId: string;
  /** Shrinkage-weighted score. */
  score: number;
  /** Raw sample size behind the score. */
  basis: number;
}
