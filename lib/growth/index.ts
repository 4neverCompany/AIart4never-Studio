/**
 * M3 growth-brain — public surface (4NE-15 attribution + 4NE-17 self-tuning).
 *
 * The DECIDE-step module: it consumes the LEARN-step analytics
 * ({@link import('@/lib/analytics').PostInsight} +
 * {@link import('@/lib/analytics').scoreInsight}) the operator's live IG
 * connection will eventually produce, and emits the concrete tuning the weekly
 * planner acts on — template adjustments, per-slot posting times, and per-pillar
 * hook rankings — plus the operator-control seam (Story 8-11): tuned changes
 * become explicit accept/edit/reject proposals, and only accepted decisions
 * flow into the plan. Everything here is PURE + deterministic + fixture-tested
 * EXCEPT `decision-log.ts` (the persisted audit of accepted changes, which
 * goes through `@/lib/persistence` like the autonomy journal). Import from
 * `@/lib/growth` rather than the individual files.
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

export type {
  ProposalKind,
  TunedSlot,
  TuningProposal,
  ProposalDecision,
  AppliedTuningChange,
  DecidedTemplate,
  PostingTimeExperiment,
  AbArm,
  AbMeasurement,
} from './proposals';

export {
  buildTuningProposals,
  applyProposalDecisions,
  measurePostingTimeChange,
  AB_DEAD_BAND,
  AB_MIN_SAMPLE,
} from './proposals';

export type { RecordedTuningChange } from './decision-log';

export {
  appendTuningDecisions,
  readTuningDecisions,
  TUNING_DECISION_LOG_KEY,
  TUNING_DECISION_CAP,
} from './decision-log';
