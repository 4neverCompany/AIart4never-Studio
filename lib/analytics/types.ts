/**
 * 4NE-14 — Weekly "what landed" analytics: shared types.
 *
 * This module is the LEARN-step input of the OBSERVE → ORIENT → DECIDE → ACT →
 * LEARN loop. It takes per-post Instagram insights, scores them with a single
 * comparable {@link EngagementScore}, rolls them up per content pillar and per
 * weekday slot, and emits a {@link WeeklyReport} — the human-readable "what
 * landed this week" summary plus concrete `proposals` that later feed M3's plan
 * self-tuning.
 *
 * Framework-free by design (no SDK imports, no `Date.now`): the report builder
 * in `report.ts` is PURE and takes `weekStart` as a parameter so it is fully
 * deterministic and unit-testable. The only impure piece is the live insights
 * fetch in `insights-source.ts`, which dispatches through `lib/mcp` exactly like
 * `lib/publish` does.
 */

import type { RealityId, WeeklySlot } from '@/lib/canon';

/**
 * A weekday key, reusing the canon's `WeeklySlot['day']` union so a slot's
 * `day` and an insight's `day` are the same shape and join cleanly. The canon
 * doesn't export a named `Weekday` alias, so we derive one here rather than
 * editing `lib/canon` (out of scope for this build).
 */
export type Weekday = WeeklySlot['day'];

/**
 * One post's engagement metrics, joined with our own scheduling metadata.
 *
 * The raw IG insights only know the post id and the public counters; they do
 * NOT know which content pillar / reality / weekday slot the post belongs to —
 * that's our planning metadata, joined back in on `postId` (see
 * `fetchInsights`'s `postRefs`). All counters default to 0 when the source row
 * omits them (see `mapRawInsight`).
 */
export interface PostInsight {
  /** Stable id of the published post (IG media id, or our own ref id). */
  postId: string;
  /** Our asset id, if known (joined from planning metadata). */
  assetId?: string;
  /** Content pillar id (e.g. `'story-beat'`), joined from planning metadata. */
  pillarId?: string;
  /** Reality the post belongs to, joined from planning metadata. */
  reality?: RealityId;
  /** Weekday the post went out, joined from planning metadata. */
  day?: Weekday;
  /** Unix-ms timestamp the post was published. */
  postedAt: number;
  likes: number;
  comments: number;
  saves: number;
  shares: number;
  reach: number;
  impressions: number;
}

/**
 * A single comparable engagement score for a post. Higher is better. Computed
 * by {@link import('./report').scoreInsight}; see that function for the formula.
 */
export type EngagementScore = number;

/** Aggregate stats for one content pillar over the week. */
export interface PillarRollup {
  pillarId: string;
  /** Number of posts in this pillar this week. */
  posts: number;
  /** Mean {@link EngagementScore} across this pillar's posts. */
  avgScore: number;
  /** Sum of `reach` across this pillar's posts. */
  totalReach: number;
}

/** Aggregate stats for one weekday slot over the week. */
export interface SlotRollup {
  day: Weekday;
  /** Number of posts that went out on this weekday. */
  posts: number;
  /** Mean {@link EngagementScore} across this weekday's posts. */
  avgScore: number;
}

/**
 * The weekly report: the LEARN-step artefact. `best` / `worst` are the single
 * highest / lowest scoring posts; `bestSlot` is the highest-average weekday;
 * `proposals` are concrete, human-readable tuning suggestions. On an empty week
 * the rollups are empty, `best` / `worst` / `bestSlot` are omitted, and
 * `proposals` carries a single "no data yet" line.
 */
export interface WeeklyReport {
  /** Unix-ms timestamp marking the start of the reported week. */
  weekStart: number;
  /** Total posts that fed this report. */
  totalPosts: number;
  /** Per-pillar rollups, sorted by `avgScore` descending. */
  perPillar: PillarRollup[];
  /** Per-weekday rollups, sorted by `avgScore` descending. */
  perSlot: SlotRollup[];
  /** The single highest-scoring post, if any. */
  best?: PostInsight;
  /** The single lowest-scoring post, if any. */
  worst?: PostInsight;
  /** The highest-average weekday slot, if any. */
  bestSlot?: SlotRollup;
  /** Concrete tuning suggestions for the next plan. Always non-empty. */
  proposals: string[];
}
