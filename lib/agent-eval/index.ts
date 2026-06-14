/**
 * v1.2.3 — Eval barrel.
 *
 * Public surface for `lib/agent-eval/`. The Director loop
 * imports from this module instead of the individual
 * heuristic files, so the test surface stays narrow.
 */
export {
  evalNicheCoverage,
  evalCameraAngle,
  evalAntiAiLook,
  evalLength,
  evalAll,
  DEFAULT_WEIGHTS,
} from './aggregate';

export type {
  AggregateEvalInput,
  AggregateEvalResult,
  AggregateWeights,
  NicheCoverageResult,
  CameraAngleResult,
  AntiAiLookResult,
  LengthBudgetResult,
} from './aggregate';
