/**
 * Story 8-11 — Operator TUNING PROPOSALS (PURE): the accept/edit/reject seam
 * between the growth-brain's adapted template and the weekly planner (FR-10).
 *
 * `adaptWeeklyTemplate` annotates the weekly template with the self-tuned
 * posting hours + hooks — but those annotations must NEVER flow into the plan
 * silently. This module turns each per-slot hour/hook change into an explicit
 * {@link TuningProposal} the operator decides on, and applies ONLY the accepted
 * decisions back onto the base template:
 *
 *     const adapted   = adaptWeeklyTemplate({ attribution, slotRecs, hookRecs });
 *     const proposals = buildTuningProposals(adapted);
 *     // …operator accepts / edits / rejects / ignores each proposal…
 *     const { slots } = applyProposalDecisions(WEEKLY_TEMPLATE, proposals, decisions);
 *     // → feed `slots` (as the baseTemplate) into buildWeeklyContentPlan(...)
 *
 * The control contract (the story's ACs, encoded):
 *   - Every proposal names its change, its per-dimension basis (`'top'` exploit
 *     vs `'exploration'` ε-greedy pick — read from the AdaptedSlot's
 *     hourBasis/hookBasis, NOT parsed from prose), and the tuner's rationale.
 *   - An ACCEPT applies the recommended value; an accept WITH an edited value
 *     applies the operator's value instead (the edit wins — never the
 *     recommendation), and the {@link AppliedTuningChange} records both.
 *   - A REJECT — or simply ignoring a proposal (no decision) — leaves the base
 *     slot untouched: the prior/base value is what the planner sees. There is
 *     structurally no path for an undecided annotation to reach the plan.
 *
 * Canon invariants are inherited, not re-derived: the applier maps 1:1 over the
 * base template (stable slot count), never touches `day`/`pillarId`/`format`/
 * `guaranteesNewGen`, and only ever sets the advisory `recommendedHour`/`hookId`
 * annotations the planner already carries through.
 *
 * ## OAQ-9 (Open Q2 / FR-10) — the A/B MEASUREMENT METHOD (decided)
 *
 * An accepted posting-time change is an EXPERIMENT, and this is how it is later
 * verified against its prior baseline:
 *
 *   1. RECORD — accepting a proposal produces an {@link AppliedTuningChange}
 *      (`priorValue`, `recommendedValue`, `appliedValue`, cell key); the CLI
 *      stamps `decidedAt` and appends it to the durable tuning decision log
 *      (`lib/growth/decision-log.ts`). That record IS the experiment
 *      registration: it pins the cell (pillar × day), the new hour, and the
 *      baseline hour it replaced.
 *   2. MEASURE — after N weeks of posting at the new hour (N=4 recommended: at
 *      the one-post-per-cell weekly cadence that yields ~4 posts per arm; wait
 *      until BOTH arms have ≥ `minSample` posts), run
 *      {@link measurePostingTimeChange} over the attributed-insight history.
 *      It buckets the cell's posts by UTC hour-of-`postedAt`, scores the
 *      new-hour arm vs the prior-hour arm with the SAME `scoreInsight` →
 *      `shrinkScore` lower-confidence bound the tuner ranks with (so the
 *      verdict and the recommendation share one yardstick), and verdicts
 *      inside a ±{@link AB_DEAD_BAND} dead-band of the cell mean (mirroring
 *      attribution's ±15% over/under-perform ratios).
 *   3. ACT — `'new-wins'` → keep the change (re-accept / persist it);
 *      `'prior-wins'` → drop it (simply don't re-accept — nothing applies
 *      without an accept, so the baseline returns by default);
 *      `'inconclusive'` / `'insufficient-data'` → keep gathering before
 *      deciding.
 *
 * Hook changes are measured the same way through the existing byHook dimension
 * (`attributeEngagement` slices per hook and `proposeTemplateAdjustments`
 * verdicts it with the same dead-band); the dedicated helper here covers hours
 * because hour-of-day has no attribution dimension of its own.
 *
 * PURE + deterministic: no `Date.now`, no random, no I/O. The impure decision
 * LOG lives next door in `decision-log.ts`; time enters only as data.
 */

import { WEEKLY_TEMPLATE } from '@/lib/canon';
import type { WeeklySlot } from '@/lib/canon';
import { scoreInsight } from '@/lib/analytics';
import { shrinkScore } from './self-tuning';
import type { AdaptiveResult } from './adaptive-plan';
import type { AttributedInsight } from './types';

/** The two tunable dimensions a proposal can target. */
export type ProposalKind = 'posting-hour' | 'hook';

/**
 * A base-template slot as the proposal layer sees it: a canon {@link WeeklySlot}
 * that MAY already carry tuned annotations (e.g. a saved tuned template fed
 * back in — Story 8-12). Also the applier's OUTPUT shape: a drop-in
 * `baseTemplate` for `buildWeeklyContentPlan`.
 */
export type TunedSlot = WeeklySlot & {
  recommendedHour?: number;
  hookId?: string;
};

/**
 * One explicit, operator-decidable posting-time or hook change. `id` is the
 * stable accept/edit handle (`hour:<day>:<pillarId>` / `hook:<day>:<pillarId>`),
 * derived only from the slot cell so the same change carries the same id
 * across runs.
 */
export interface TuningProposal {
  /** Stable handle: `hour:fri:story-beat` / `hook:sun:variant-reveal`. */
  id: string;
  kind: ProposalKind;
  day: WeeklySlot['day'];
  pillarId: string;
  /** What the tuner recommends: an hour 0..23 (posting-hour) or a hookId (hook). */
  recommendedValue: number | string;
  /** The base template's current value for this dimension; absent = untuned canon default. */
  priorValue?: number | string;
  /** `'top'` = exploit (top-ranked candidate); `'exploration'` = ε-greedy runner-up pick. */
  basis: 'top' | 'exploration';
  /** The tuner's human-readable why, carried from the adapted slot. */
  rationale: string;
}

/**
 * One operator decision on one proposal. `editedValue` is only meaningful with
 * `action: 'accept'` — the operator's own value that then flows into the plan
 * INSTEAD of the recommendation. Proposals with no decision are simply left
 * out of the list (ignored = base value kept).
 */
export interface ProposalDecision {
  proposalId: string;
  action: 'accept' | 'reject';
  /** Accept only: the operator's edited hour (0..23) or hookId. */
  editedValue?: number | string;
}

/**
 * The durable record of one ACCEPTED change — what the decision log persists
 * (with a `decidedAt` stamp) and what the OAQ-9 measurement later reads to
 * find the experiment's cell, new value, and prior baseline.
 */
export interface AppliedTuningChange {
  proposalId: string;
  kind: ProposalKind;
  day: WeeklySlot['day'];
  pillarId: string;
  /** The baseline the change replaced; absent = untuned canon default. */
  priorValue?: number | string;
  /** What the tuner recommended. */
  recommendedValue: number | string;
  /** What actually flowed into the plan (the operator's edit wins over the recommendation). */
  appliedValue: number | string;
  /** True when the operator edited the value rather than accepting as-is. */
  edited: boolean;
}

/** Result of {@link applyProposalDecisions}. */
export interface DecidedTemplate {
  /** The base template with ONLY the accepted changes applied (1:1, stable count). */
  slots: TunedSlot[];
  /** One record per accepted change — feed these to the decision log. */
  applied: AppliedTuningChange[];
  /** Proposal ids the operator explicitly rejected (base value kept). */
  rejected: string[];
}

/** Stable per-cell key (matches adaptive-plan's `explored` keys). */
function cellKey(slot: { day: WeeklySlot['day']; pillarId: string }): string {
  return `${slot.day}:${slot.pillarId}`;
}

/**
 * Build the operator-facing proposals from an adapt run.
 *
 * One proposal per FRESH per-slot decision: a slot's `recommendedHour` earns a
 * `posting-hour` proposal and its `hookId` a `hook` proposal, each carrying the
 * per-dimension basis (`hourBasis`/`hookBasis` → top vs exploration) and the
 * slot's rationale. Two guards keep the list honest:
 *   - only decisions MADE THIS RUN propose (the basis flag must be present — an
 *     annotation merely carried over from an already-tuned base template is not
 *     a new change to decide);
 *   - only actual CHANGES propose (a re-recommendation equal to the base
 *     template's current value has nothing to accept).
 * Cold start (or an empty adapt) → `[]`.
 */
export function buildTuningProposals(
  result: AdaptiveResult,
  baseTemplate: ReadonlyArray<TunedSlot> = WEEKLY_TEMPLATE,
): TuningProposal[] {
  if (result.coldStart) return [];

  const baseByCell = new Map<string, TunedSlot>();
  for (const slot of baseTemplate) baseByCell.set(cellKey(slot), slot);

  const out: TuningProposal[] = [];
  for (const slot of result.slots) {
    const base = baseByCell.get(cellKey(slot));

    if (
      slot.recommendedHour !== undefined &&
      slot.hourBasis !== undefined &&
      slot.recommendedHour !== base?.recommendedHour
    ) {
      out.push({
        id: `hour:${slot.day}:${slot.pillarId}`,
        kind: 'posting-hour',
        day: slot.day,
        pillarId: slot.pillarId,
        recommendedValue: slot.recommendedHour,
        ...(base?.recommendedHour !== undefined ? { priorValue: base.recommendedHour } : {}),
        basis: slot.hourBasis === 'explore' ? 'exploration' : 'top',
        rationale: slot.rationale ?? '',
      });
    }

    if (slot.hookId !== undefined && slot.hookBasis !== undefined && slot.hookId !== base?.hookId) {
      out.push({
        id: `hook:${slot.day}:${slot.pillarId}`,
        kind: 'hook',
        day: slot.day,
        pillarId: slot.pillarId,
        recommendedValue: slot.hookId,
        ...(base?.hookId !== undefined ? { priorValue: base.hookId } : {}),
        basis: slot.hookBasis === 'explore' ? 'exploration' : 'top',
        rationale: slot.rationale ?? '',
      });
    }
  }
  return out;
}

/** Validate + resolve the value an accepted decision applies. Throws on a bad edit. */
function resolveAppliedValue(proposal: TuningProposal, decision: ProposalDecision): {
  appliedValue: number | string;
  edited: boolean;
} {
  if (decision.editedValue === undefined) {
    return { appliedValue: proposal.recommendedValue, edited: false };
  }
  if (proposal.kind === 'posting-hour') {
    const h = decision.editedValue;
    if (typeof h !== 'number' || !Number.isInteger(h) || h < 0 || h > 23) {
      throw new Error(
        `invalid edited posting hour for '${proposal.id}': expected an integer 0..23, got ${JSON.stringify(h)}`,
      );
    }
    return { appliedValue: h, edited: true };
  }
  const hook = decision.editedValue;
  if (typeof hook !== 'string' || hook.trim() === '') {
    throw new Error(
      `invalid edited hook for '${proposal.id}': expected a non-empty hook id, got ${JSON.stringify(hook)}`,
    );
  }
  return { appliedValue: hook.trim(), edited: true };
}

/**
 * Apply the operator's decisions onto the base template — the ONLY way a
 * tuned hour/hook reaches the plan.
 *
 *   - accept                → the recommended value lands on the matching slot;
 *   - accept + editedValue  → the OPERATOR'S value lands instead (the edit wins),
 *                             validated (hour must be an integer 0..23, hook a
 *                             non-empty string — a bad edit throws rather than
 *                             applying garbage);
 *   - reject                → the slot keeps its base value; the id is echoed in
 *                             `rejected`;
 *   - no decision (ignored) → identical to reject, minus the echo. Nothing is
 *                             ever applied silently.
 *
 * A decision whose `proposalId` matches no live proposal is a no-op (a decision
 * without a proposal can change nothing); when the same proposal is decided
 * twice, the FIRST decision wins (deterministic — the CLI rejects conflicting
 * flags before it gets here). Maps 1:1 over `baseTemplate`: same slot count,
 * same days/pillars/formats/guarantees out.
 */
export function applyProposalDecisions(
  baseTemplate: ReadonlyArray<TunedSlot>,
  proposals: readonly TuningProposal[],
  decisions: readonly ProposalDecision[],
): DecidedTemplate {
  const proposalById = new Map<string, TuningProposal>();
  for (const p of proposals) proposalById.set(p.id, p);

  // First decision per proposal wins; unknown ids are dropped.
  const decided = new Map<string, ProposalDecision>();
  for (const d of decisions) {
    if (!proposalById.has(d.proposalId)) continue;
    if (!decided.has(d.proposalId)) decided.set(d.proposalId, d);
  }

  const applied: AppliedTuningChange[] = [];
  const rejected: string[] = [];
  // Accepted change per (cell, kind), for the 1:1 slot map below.
  const acceptedByCellKind = new Map<string, AppliedTuningChange>();

  for (const [id, decision] of decided) {
    const proposal = proposalById.get(id)!;
    if (decision.action === 'reject') {
      rejected.push(id);
      continue;
    }
    const { appliedValue, edited } = resolveAppliedValue(proposal, decision);
    const change: AppliedTuningChange = {
      proposalId: id,
      kind: proposal.kind,
      day: proposal.day,
      pillarId: proposal.pillarId,
      ...(proposal.priorValue !== undefined ? { priorValue: proposal.priorValue } : {}),
      recommendedValue: proposal.recommendedValue,
      appliedValue,
      edited,
    };
    applied.push(change);
    acceptedByCellKind.set(`${proposal.kind}|${cellKey(proposal)}`, change);
  }

  const slots: TunedSlot[] = baseTemplate.map((slot) => {
    const hourChange = acceptedByCellKind.get(`posting-hour|${cellKey(slot)}`);
    const hookChange = acceptedByCellKind.get(`hook|${cellKey(slot)}`);
    return {
      ...slot,
      ...(hourChange ? { recommendedHour: hourChange.appliedValue as number } : {}),
      ...(hookChange ? { hookId: hookChange.appliedValue as string } : {}),
    };
  });

  return { slots, applied, rejected };
}

// ---------------------------------------------------------------------------
// OAQ-9 — the A/B measurement (see the module header for the full method)
// ---------------------------------------------------------------------------

/**
 * Verdict dead-band as a fraction of the cell's mean score (±15%), mirroring
 * attribution's OVERPERFORM/UNDERPERFORM ratios so "wins" means the same thing
 * everywhere: an arm must beat the other by more than 15% of the cell mean.
 */
export const AB_DEAD_BAND = 0.15;

/**
 * Minimum posts PER ARM before the comparison is trusted — same default the
 * attribution proposals use (`minSample` 5), for the same anti-over-fit reason.
 */
export const AB_MIN_SAMPLE = 5;

/** The accepted posting-time change under measurement (from the decision log). */
export interface PostingTimeExperiment {
  pillarId: string;
  day: WeeklySlot['day'];
  /** The accepted (new) posting hour under test, 0..23 UTC (`appliedValue`). */
  newHour: number;
  /**
   * The prior baseline hour (`priorValue`). Absent = the prior was the untuned
   * canon default (no fixed hour), so the baseline arm is ALL of the cell's
   * posts at other hours.
   */
  priorHour?: number;
}

/** One arm's rollup in an {@link AbMeasurement}. */
export interface AbArm {
  /** The arm's hour; absent for an untimed (canon-default) prior arm. */
  hour?: number;
  /** Posts observed in this arm. */
  posts: number;
  /** Raw mean `scoreInsight` across the arm's posts. */
  avgScore: number;
  /** Shrinkage lower-confidence bound (same scorer the tuner ranks with). */
  score: number;
}

/** The verifiable outcome of a posting-time experiment. */
export interface AbMeasurement {
  newArm: AbArm;
  priorArm: AbArm;
  /** The per-arm sample floor the verdict required. */
  minSample: number;
  /**
   *  - `'new-wins'`           — keep the change (re-accept / persist it).
   *  - `'prior-wins'`         — drop it (don't re-accept; the baseline returns).
   *  - `'inconclusive'`       — inside the dead-band; keep gathering.
   *  - `'insufficient-data'`  — an arm is below `minSample`; not comparable yet.
   */
  verdict: 'new-wins' | 'prior-wins' | 'inconclusive' | 'insufficient-data';
}

/** Mean of `xs`, or 0 for an empty list. */
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** UTC hour-of-day of a Unix-ms timestamp (matches self-tuning's bucketing). */
function hourOf(postedAt: number): number | undefined {
  if (!Number.isFinite(postedAt)) return undefined;
  return new Date(postedAt).getUTCHours();
}

/**
 * Measure an accepted posting-time change against its prior baseline (OAQ-9,
 * step 2 of the method in the module header).
 *
 * Pass the attributed-insight history covering the POST-acceptance window
 * (e.g. the N weeks after the decision log's `decidedAt`); the function is
 * window-agnostic like every growth function — the caller picks the window.
 * It buckets the experiment cell's posts (matching `pillarId` + `day`) by UTC
 * hour, scores the new-hour arm vs the prior arm with `scoreInsight` →
 * `shrinkScore` (shrunk toward the cell mean so a thin arm can't fluke a win),
 * and verdicts with a ±{@link AB_DEAD_BAND} dead-band of the cell mean. Either
 * arm under `minSample` → `'insufficient-data'` (arms are still reported so
 * the operator can see the counts grow). PURE + deterministic.
 */
export function measurePostingTimeChange(
  history: readonly AttributedInsight[],
  experiment: PostingTimeExperiment,
  opts?: { minSample?: number },
): AbMeasurement {
  const minSample = Math.max(1, opts?.minSample ?? AB_MIN_SAMPLE);

  // The experiment's cell: same pillar + weekday, with a usable timestamp.
  const cell = history
    .filter((i) => i.pillarId === experiment.pillarId && i.day === experiment.day)
    .map((insight) => ({ hour: hourOf(insight.postedAt), score: scoreInsight(insight) }))
    .filter((r): r is { hour: number; score: number } => r.hour !== undefined);

  const cellMean = mean(cell.map((r) => r.score));

  const newScores = cell.filter((r) => r.hour === experiment.newHour).map((r) => r.score);
  const priorScores = cell
    .filter((r) =>
      experiment.priorHour !== undefined
        ? r.hour === experiment.priorHour
        : r.hour !== experiment.newHour,
    )
    .map((r) => r.score);

  const newArm: AbArm = {
    hour: experiment.newHour,
    posts: newScores.length,
    avgScore: mean(newScores),
    score: shrinkScore(mean(newScores), newScores.length, cellMean),
  };
  const priorArm: AbArm = {
    ...(experiment.priorHour !== undefined ? { hour: experiment.priorHour } : {}),
    posts: priorScores.length,
    avgScore: mean(priorScores),
    score: shrinkScore(mean(priorScores), priorScores.length, cellMean),
  };

  let verdict: AbMeasurement['verdict'];
  if (newArm.posts < minSample || priorArm.posts < minSample) {
    verdict = 'insufficient-data';
  } else {
    const margin = AB_DEAD_BAND * cellMean;
    if (newArm.score - priorArm.score > margin) verdict = 'new-wins';
    else if (priorArm.score - newArm.score > margin) verdict = 'prior-wins';
    else verdict = 'inconclusive';
  }

  return { newArm, priorArm, minSample, verdict };
}
