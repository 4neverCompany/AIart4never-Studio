/**
 * 4NE-14 — Weekly "what landed" analytics: public surface.
 *
 * The LEARN-step module. `report.ts` is PURE (deterministic scoring +
 * aggregation, `weekStart` injected); `insights-source.ts` is the live IG
 * insights fetch that dispatches through `lib/mcp` like `lib/publish`. Import
 * from `@/lib/analytics` rather than the individual files.
 */

export type {
  PostInsight,
  EngagementScore,
  PillarRollup,
  SlotRollup,
  WeeklyReport,
  Weekday,
} from './types';

export { scoreInsight, buildWeeklyReport, SCORE_WEIGHTS, KNOWN_PILLAR_IDS } from './report';

export { mapRawInsight, fetchInsights, INSIGHTS_TOOL } from './insights-source';
export type { PostRef, FetchInsightsDeps } from './insights-source';
