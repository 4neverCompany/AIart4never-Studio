/**
 * v1.2.3 — Eval aggregate.
 *
 * Combines the 4 heuristics (niche-coverage, camera-angle,
 * anti-ai-look, length-budget) into a single 0..1 score with
 * a per-heuristic breakdown. The Director loop's
 * `critique_prompt` tool can call this directly to populate
 * the step's `eval` field.
 *
 * Default weights bias toward niche-coverage (the most
 * important signal — does the prompt cover the brief?).
 * Camera-angle and anti-ai-look are quality boosters;
 * length-budget is a sanity check.
 *
 * Pure function, no IO. Snapshot-tested in
 * `aggregate.test.ts`.
 */

import { evalNicheCoverage, type NicheCoverageResult } from './niche-coverage';
import { evalCameraAngle, type CameraAngleResult } from './camera-angle';
import { evalAntiAiLook, type AntiAiLookResult } from './anti-ai-look';
import { evalLength, type LengthBudgetResult } from './length-budget';

export interface AggregateWeights {
  nicheCoverage: number;
  cameraAngle: number;
  antiAiLook: number;
  lengthBudget: number;
}

export const DEFAULT_WEIGHTS: AggregateWeights = {
  nicheCoverage: 0.4,
  cameraAngle: 0.2,
  antiAiLook: 0.2,
  lengthBudget: 0.2,
};

export interface AggregateEvalInput {
  prompt: string;
  niches: readonly string[];
  weights?: AggregateWeights;
}

export interface AggregateEvalResult {
  /** Weighted average 0..1. */
  overall: number;
  /** Per-heuristic breakdown for the Replay UI. */
  breakdown: {
    nicheCoverage: NicheCoverageResult;
    cameraAngle: CameraAngleResult;
    antiAiLook: AntiAiLookResult;
    lengthBudget: LengthBudgetResult;
  };
  /** What to fix in a refine pass (the keys of breakdown that score < 0.7). */
  issues: string[];
}

export function evalAll(input: AggregateEvalInput): AggregateEvalResult {
  const w = input.weights ?? DEFAULT_WEIGHTS;
  const breakdown = {
    nicheCoverage: evalNicheCoverage(input.prompt, input.niches),
    cameraAngle: evalCameraAngle(input.prompt),
    antiAiLook: evalAntiAiLook(input.prompt),
    lengthBudget: evalLength(input.prompt),
  };
  const sumW = w.nicheCoverage + w.cameraAngle + w.antiAiLook + w.lengthBudget;
  const norm = sumW > 0 ? sumW : 1;
  const overall =
    (breakdown.nicheCoverage.score * w.nicheCoverage +
      breakdown.cameraAngle.score * w.cameraAngle +
      breakdown.antiAiLook.score * w.antiAiLook +
      breakdown.lengthBudget.score * w.lengthBudget) /
    norm;
  const issues: string[] = [];
  if (breakdown.nicheCoverage.score < 0.7) issues.push('niche-coverage');
  if (breakdown.cameraAngle.score < 0.7) issues.push('camera-angle');
  if (breakdown.antiAiLook.score < 0.7) issues.push('anti-ai-look');
  if (breakdown.lengthBudget.score < 0.7) issues.push('length-budget');
  return { overall, breakdown, issues };
}

export { evalNicheCoverage, evalCameraAngle, evalAntiAiLook, evalLength };

export type {
  NicheCoverageResult,
  CameraAngleResult,
  AntiAiLookResult,
  LengthBudgetResult,
};
