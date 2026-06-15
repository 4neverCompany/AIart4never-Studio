/**
 * M3 growth-brain — public surface (4NE-15 attribution + 4NE-17 self-tuning).
 *
 * The DECIDE-step module: it consumes the LEARN-step analytics
 * ({@link import('@/lib/analytics').PostInsight} +
 * {@link import('@/lib/analytics').scoreInsight}) the operator's live IG
 * connection will eventually produce, and emits the concrete tuning the weekly
 * planner acts on — template adjustments, per-slot posting times, and per-pillar
 * hook rankings. Everything here is PURE + deterministic + fixture-tested; no
 * live connection is needed to build or test it. Import from `@/lib/growth`
 * rather than the individual files.
 */

export type {
  AttributedInsight,
  DimensionStat,
  AttributionReport,
  TemplateAdjustment,
  SlotRecommendation,
  HookRecommendation,
} from './types';

export {
  attributeEngagement,
  proposeTemplateAdjustments,
  ATTRIBUTABLE_PILLAR_IDS,
} from './attribution';

export {
  recommendPostingTimes,
  recommendHooks,
  shrinkScore,
  SHRINKAGE_K,
  UNCERTAINTY_PENALTY,
} from './self-tuning';

export type {
  AdaptedSlot,
  AdaptiveInput,
  AdaptiveResult,
} from './adaptive-plan';

export { adaptWeeklyTemplate, DEFAULT_EXPLORATION_RATE } from './adaptive-plan';
