/**
 * M3 loop-closer — the ADAPTIVE WEEKLY PLANNER (4NE-15 "→ plan feedback" +
 * 4NE-17 "converge toward best slots").
 *
 * This is the last link in the OBSERVE → ORIENT → DECIDE → ACT → LEARN loop: it
 * takes the growth-brain's DECIDE-step signals (the attribution report's
 * {@link TemplateAdjustment}s, the per-slot {@link SlotRecommendation}s, and the
 * per-pillar {@link HookRecommendation}s) and folds them back into the canon
 * weekly template, so next week's plan converges toward the times/hooks/pillars
 * that have actually earned engagement.
 *
 * It does NOT build the final reuse-vs-generate plan — that stays in
 * {@link import('@/lib/canon/content-plan').buildWeeklyContentPlan}. This module's
 * job is strictly to produce the ADAPTED TEMPLATE (an annotated
 * {@link AdaptedSlot}[]) that feeds INTO that planner. The intended wiring is:
 *
 *     const { slots } = adaptWeeklyTemplate({ attribution, slotRecs, hookRecs });
 *     // → feed `slots` (as the baseTemplate) into buildWeeklyContentPlan(...)
 *
 * ## Canon invariants this module preserves (quoted from `lib/canon/index.ts`)
 *
 * `WEEKLY_TEMPLATE` is a frozen, FIXED-STRUCTURE array of 6 `WeeklySlot`s
 * (`mon..sun`), each a fixed `{ day, pillarId, format, guaranteesNewGen }`. There
 * are no spare/ambiguous slots and no resize API, so we treat adjustments as
 * `rationale`-annotated PREFERENCES, never as restructuring:
 *
 *   1. THE FRIDAY NEW-GEN GUARANTEE — the docstring says *"Only the Friday
 *      Story-Beat guarantees NEW generation; every other slot reuses the existing
 *      library"*. The Friday slot is the sole `guaranteesNewGen: true` slot. We
 *      never flip a `guaranteesNewGen` flag, never move the Friday slot, and never
 *      apply a `decrease` to the `story-beat` pillar that Friday carries.
 *   2. NO PILLAR DROPS TO ZERO — every pillar that appears in the base template
 *      keeps its slot(s). Because we only annotate (never delete/reassign slots),
 *      a `decrease` can at most discourage an EXTRA appearance of a pillar; the
 *      template has no extra appearances to remove, so in practice a decrease is
 *      recorded as a preference annotation only.
 *   3. STABLE SLOT COUNT — the 6 slots in, the same 6 slots out. We map 1:1 over
 *      the base template and only enrich each slot in place.
 *
 * Because the structure is fixed, "frequency nudges" cannot literally change how
 * many times a pillar appears in a single week's 6-slot template. We therefore
 * apply the FREQUENCY-NUDGE semantics as the safe interpretation the canon
 * template supports: an `increase`/`decrease` becomes a per-slot preference
 * annotation (`rationale`) on the matching pillar's slot(s), which the planner
 * (and a future resizable template) can read. The {@link AdaptiveResult.adjustments}
 * are passed through verbatim so a later resizable template can act on them
 * literally without re-deriving them.
 *
 * ## Exploit-by-default, bounded exploration
 *
 * Annotation EXPLOITS by default — it picks the top-ranked hour/hook for each
 * slot. To keep learning (and avoid locking onto an early local optimum), each
 * hook/time decision runs an ε-greedy coin flip: with probability
 * `explorationRate` (default 0.15) we instead pick a NON-top candidate for that
 * slot and record the slot key in `explored`. Exploration is bounded three ways:
 * the rate is small (≤15% per decision by default), it only ever swaps to another
 * REAL candidate from the same pillar's ranked list (never an invented one), and
 * it never touches the canon invariants above (pillar assignment, the Friday
 * guarantee, the slot count). The rng is injectable so tests are deterministic.
 *
 * PURE + deterministic: no `Date.now`, no I/O; randomness comes only through the
 * injected `rng` (default `Math.random`).
 */

import { WEEKLY_TEMPLATE, getPillar } from '@/lib/canon';
import type { WeeklySlot } from '@/lib/canon';
import { proposeTemplateAdjustments } from './attribution';
import type {
  AttributionReport,
  HookRecommendation,
  SlotRecommendation,
  TemplateAdjustment,
} from './types';

/**
 * A canon {@link WeeklySlot} enriched with the growth-brain's per-slot signals.
 * It is a structural SUPERSET of `WeeklySlot` (same `day`/`pillarId`/`format`/
 * `guaranteesNewGen`), so an `AdaptedSlot[]` is a drop-in `baseTemplate` for the
 * downstream planner.
 */
export type AdaptedSlot = WeeklySlot & {
  /** Recommended hour-of-day (0..23) for this slot, from the matching slotRec. */
  recommendedHour?: number;
  /** Recommended creative hook id for this slot's pillar, from the hookRecs. */
  hookId?: string;
  /** True when ANY growth signal (adjustment / hour / hook) was applied here. */
  adapted: boolean;
  /** Human-readable summary of what was applied (and why) to this slot. */
  rationale?: string;
};

/**
 * Inputs to {@link adaptWeeklyTemplate}. Everything is optional so the function
 * degrades gracefully: with nothing, it returns the canon template untouched
 * (cold start).
 */
export interface AdaptiveInput {
  /** The template to adapt. Defaults to the canon {@link WEEKLY_TEMPLATE}. */
  baseTemplate?: WeeklySlot[];
  /** The attribution report driving frequency nudges. Absent ⇒ cold start. */
  attribution?: AttributionReport;
  /** Per-(pillar, day) posting-time recommendations (4NE-17). */
  slotRecs?: SlotRecommendation[];
  /** Per-pillar hook recommendations (4NE-17), best-first. */
  hookRecs?: HookRecommendation[];
  /** ε for ε-greedy exploration (probability of exploring per decision). Default 0.15. */
  explorationRate?: number;
  /** Injected RNG for deterministic tests. Default `Math.random`. */
  rng?: () => number;
  /** Min posts a key needs before its adjustment is trusted (passed through). Default 5. */
  minSample?: number;
}

/**
 * Result of {@link adaptWeeklyTemplate}.
 */
export interface AdaptiveResult {
  /** The adapted template — same length/structure as the base, enriched in place. */
  slots: AdaptedSlot[];
  /** The frequency-nudge proposals from the attribution report (passed through). */
  adjustments: TemplateAdjustment[];
  /** Slot keys (`day:pillarId`) where ε-greedy chose to EXPLORE rather than exploit. */
  explored: string[];
  /** True when there was no signal to act on — the base template is returned untouched. */
  coldStart: boolean;
}

/** Default ε-greedy exploration rate (15% per hook/time decision). */
export const DEFAULT_EXPLORATION_RATE = 0.15;

/** Stable per-slot key used in `explored` and for matching slot recs. */
function slotKey(slot: { day: WeeklySlot['day']; pillarId: string }): string {
  return `${slot.day}:${slot.pillarId}`;
}

/** A pillar's human name for rationales, falling back to the raw id. */
function pillarLabel(pillarId: string): string {
  return getPillar(pillarId)?.name ?? pillarId;
}

/**
 * Pick from a best-first candidate list with ε-greedy exploration.
 *
 * EXPLOIT (the default): return the top candidate. EXPLORE: with probability
 * `rate`, and only when there is a real alternative to explore, return the
 * SECOND candidate instead (a non-top but still real option from the same
 * ranked list) and flag `explored: true`. With a single candidate there is
 * nothing to explore, so it always exploits. The rng is drawn exactly once per
 * decision so a test can pin behavior precisely.
 */
function epsilonGreedy<T>(
  ranked: T[],
  rate: number,
  rng: () => number,
): { pick: T | undefined; explored: boolean } {
  if (ranked.length === 0) return { pick: undefined, explored: false };
  // Only spend a coin flip when exploration is possible (≥2 candidates, rate>0).
  if (ranked.length >= 2 && rate > 0 && rng() < rate) {
    return { pick: ranked[1], explored: true };
  }
  return { pick: ranked[0], explored: false };
}

/**
 * Fold the growth-brain's signals back into the weekly template (the M3
 * loop-closer). See the module header for the canon invariants preserved and
 * the exploit-by-default / bounded-exploration policy.
 *
 * Steps:
 *  1. `baseTemplate` defaults to the canon {@link WEEKLY_TEMPLATE}.
 *  2. COLD START — no `attribution`, or `sampleSize` 0 → return the base template
 *     unchanged (every slot `adapted: false`), `coldStart: true`, empty
 *     `adjustments`/`explored`. Never invent signal from nothing.
 *  3. Otherwise compute `adjustments = proposeTemplateAdjustments(attribution,
 *     { minSample })` and record them as `rationale`-annotated PREFERENCES on the
 *     matching pillar's slot(s) (the canon template is fixed-structure, so
 *     adjustments are preferences, not restructuring — see header).
 *  4. Annotate each slot with `recommendedHour` (from a `slotRec` matching
 *     pillar+day) and `hookId` (top `hookRec` for that pillar), setting
 *     `adapted: true` + a `rationale` whenever a signal was applied.
 *  5. ε-greedy: with probability `explorationRate` per hook/time decision, pick a
 *     non-top candidate to keep learning, using the injected `rng`; record the
 *     explored slot key in `explored`.
 */
export function adaptWeeklyTemplate(input: AdaptiveInput = {}): AdaptiveResult {
  const base = input.baseTemplate ?? (WEEKLY_TEMPLATE as readonly WeeklySlot[]);
  const rate = input.explorationRate ?? DEFAULT_EXPLORATION_RATE;
  const rng = input.rng ?? Math.random;

  // (2) Cold start: no attribution, or a zero-sample report → nothing to learn
  // from. Return the base template verbatim; never fabricate signal.
  const coldStart = !input.attribution || input.attribution.sampleSize === 0;
  if (coldStart) {
    return {
      slots: base.map((slot) => ({ ...slot, adapted: false })),
      adjustments: [],
      explored: [],
      coldStart: true,
    };
  }

  // (3) Frequency nudges from attribution, applied as preferences (fixed template).
  const adjustments = proposeTemplateAdjustments(input.attribution!, {
    minSample: input.minSample,
  });
  // Index the actionable (non-hold) adjustments by pillar key for fast lookup.
  const pillarAdjust = new Map<string, TemplateAdjustment>();
  for (const adj of adjustments) {
    if (adj.dimension === 'pillar' && adj.kind !== 'hold') {
      // Keep the first actionable adjustment per pillar (proposals are 1-per-key).
      if (!pillarAdjust.has(adj.key)) pillarAdjust.set(adj.key, adj);
    }
  }

  const slotRecs = input.slotRecs ?? [];
  const hookRecs = input.hookRecs ?? [];
  const explored: string[] = [];

  const slots: AdaptedSlot[] = base.map((slot) => {
    const key = slotKey(slot);
    const reasons: string[] = [];

    // (4a) Posting-time: the slotRec matching this exact pillar+day, ranked by
    // score. ε-greedy may pick the runner-up to keep probing other hours.
    const timeCandidates = slotRecs
      .filter((r) => r.pillarId === slot.pillarId && r.day === slot.day)
      .sort((a, b) => b.score - a.score || b.basis - a.basis);
    let recommendedHour: number | undefined;
    if (timeCandidates.length > 0) {
      const { pick, explored: didExplore } = epsilonGreedy(timeCandidates, rate, rng);
      recommendedHour = pick?.recommendedHour;
      if (recommendedHour !== undefined) {
        reasons.push(
          didExplore
            ? `exploring hour ${recommendedHour}:00 (ε-greedy, non-top slot to keep learning)`
            : `posting hour ${recommendedHour}:00 (top slot by engagement)`,
        );
      }
      if (didExplore) explored.push(key);
    }

    // (4b) Hook: the best hookRec for this slot's pillar, ranked by score.
    // ε-greedy may pick the runner-up hook to keep probing alternatives.
    const hookCandidates = hookRecs
      .filter((h) => h.pillarId === slot.pillarId)
      .sort((a, b) => b.score - a.score || b.basis - a.basis);
    let hookId: string | undefined;
    if (hookCandidates.length > 0) {
      const { pick, explored: didExplore } = epsilonGreedy(hookCandidates, rate, rng);
      hookId = pick?.hookId;
      if (hookId !== undefined) {
        reasons.push(
          didExplore
            ? `exploring hook "${hookId}" (ε-greedy, non-top hook to keep learning)`
            : `hook "${hookId}" (top hook for this pillar)`,
        );
      }
      // Only flag the slot once even if both time and hook explored.
      if (didExplore && !explored.includes(key)) explored.push(key);
    }

    // (3 cont.) Frequency-nudge PREFERENCE for this slot's pillar. We never apply
    // a `decrease` to the Friday new-gen `story-beat` slot (invariant #1), and we
    // never restructure — the nudge is recorded as a preference only.
    const adj = pillarAdjust.get(slot.pillarId);
    if (adj) {
      const protectFridayNewGen = slot.guaranteesNewGen && adj.kind === 'decrease';
      if (protectFridayNewGen) {
        reasons.push(
          `held ${pillarLabel(slot.pillarId)} despite a decrease signal — this is the guaranteed new-gen slot (canon invariant)`,
        );
      } else if (adj.kind === 'increase') {
        reasons.push(`favor ${pillarLabel(slot.pillarId)} (over-performing; ${adj.confidence} confidence)`);
      } else if (adj.kind === 'decrease') {
        reasons.push(`de-emphasize ${pillarLabel(slot.pillarId)} (under-performing; ${adj.confidence} confidence)`);
      }
    }

    const adapted = reasons.length > 0;
    return {
      ...slot,
      ...(recommendedHour !== undefined ? { recommendedHour } : {}),
      ...(hookId !== undefined ? { hookId } : {}),
      adapted,
      ...(adapted ? { rationale: reasons.join('; ') } : {}),
    };
  });

  return { slots, adjustments, explored, coldStart: false };
}
