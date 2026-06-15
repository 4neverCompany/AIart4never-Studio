/**
 * M2 keystone — the AUTONOMY LOOP orchestrator.
 *
 * `runAutonomyTick` is the single side-effecting step the scheduler fires when
 * a tick is due. It:
 *   1. resolves the local weekday and loads the asset library;
 *   2. builds the canon weekly plan (lib/canon/content-plan) for the active
 *      character and finds the slot for today;
 *   3. REUSES an on-canon library asset, GENERATES a fresh one via the director
 *      (then persists it as `approved:false`), or SKIPS when there's no slot;
 *   4. records what it did and whether an asset was QUEUED for the human gate.
 *
 * Hard invariant — the loop NEVER publishes. There is no publish dependency in
 * `deps`, this module imports nothing from `lib/publish`, and the only durable
 * effect on a generate-day is `persistAsset`, which lands the asset with
 * `approved:false` (the pending-the-human-gate state). Publishing stays
 * operator-gated downstream.
 *
 * ALL side effects are injected via `deps` so the loop is fully testable with no
 * real clock, storage, LLM, or network: `now`, `loadLibrary`, `runDirector`
 * (matching the director's `RunDirectorLoopInput`/`RunDirectorLoopResult`), and
 * `persistAsset` (matching `executePersistAsset`'s input shape).
 */

import { buildWeeklyContentPlan, assetMatchesCanon, canonTags } from '@/lib/canon/content-plan';
import { getCharacter, getPillar } from '@/lib/canon';
import type {
  RunDirectorLoopInput,
  RunDirectorLoopResult,
} from '@/lib/agent-loop';
import type { Step } from '@/lib/agent-loop/log';
import type { PersistAssetInput } from '@/lib/agent-tools/schemas';
import type { GeneratedImage } from '@/types/mashup';

import { weekdayOf, shouldTick } from './scheduler';
import type {
  AutonomyConfig,
  AutonomyState,
  AutonomyTickResult,
  Weekday,
} from './types';

// ---------------------------------------------------------------------------
// Injected dependencies (all side effects)
// ---------------------------------------------------------------------------

export interface AutonomyTickDeps {
  /** The current time. Pure — the loop never reads the wall clock itself. */
  now: Date;
  /** Load the asset library to plan + reuse against. */
  loadLibrary: () => Promise<GeneratedImage[]>;
  /**
   * Run the director loop for a generate-day. Shape matches
   * `lib/agent-loop`'s `runDirector`; tests inject a fn that returns a canned
   * `RunDirectorLoopResult` so no LLM/network is touched.
   */
  runDirector: (input: RunDirectorLoopInput) => Promise<RunDirectorLoopResult>;
  /**
   * Persist a produced asset. Shape matches `executePersistAsset`'s input — it
   * lands the asset as `approved:false` (the human approval queue). Returns the
   * AIart4never Studio-internal asset id.
   */
  persistAsset: (input: PersistAssetInput) => Promise<{ assetId: string }>;
}

// ---------------------------------------------------------------------------
// Director input derivation (per-pillar)
// ---------------------------------------------------------------------------

/**
 * The director consumes a creative brief (`niches`, `genres`, `ideaConcept`)
 * plus a `userId`, NOT a canon pillar/slot directly — so the autonomy loop
 * translates today's plan slot into that brief. The `characterId` carries the
 * canon (persona + locked look + hard rules) into the director, and the
 * per-tick `budgetUsd` is the director's hard cost cap.
 *
 * The brief is derived deterministically from canon so a generate-day is fully
 * reproducible: the pillar name seeds `niches`, the reality vibe seeds
 * `genres`, and the pillar's content description + character name seeds
 * `ideaConcept`.
 *
 * NOTE: the director's input has NO per-pillar/canon-aware field of its own —
 * this mapping is the autonomy loop's own contract. If the director later grows
 * a first-class "pillar" or "slot" input, wire it here. (Called out in the
 * handback so the mapping can be tightened precisely.)
 */
const AUTONOMY_USER_ID = 'autonomy';

function buildDirectorInput(
  cfg: AutonomyConfig,
  pillarId: string,
): RunDirectorLoopInput {
  const character = getCharacter(cfg.activeCharacterId);
  const pillar = getPillar(pillarId);
  const pillarName = pillar?.name ?? pillarId;
  const pillarDesc = pillar?.description ?? '';

  // niches: the canon pillar (subject matter). >=1 required by the director.
  const niches = [pillarName];
  // genres: a couple of canon-derived style tags from the character's reality.
  const genres = ['Cinematic Crossovers', 'Visual Storytelling'];
  // ideaConcept: the day's creative angle, anchored to the character + pillar.
  const ideaConcept =
    `${character.name} — ${pillarName}${pillarDesc ? `: ${pillarDesc}` : ''}`.slice(0, 400);

  return {
    niches,
    genres,
    ideaConcept,
    characterId: cfg.activeCharacterId,
    userId: AUTONOMY_USER_ID,
    budgetUsd: cfg.dailyBudgetUsd,
  };
}

// ---------------------------------------------------------------------------
// Produced-asset extraction from the director result
// ---------------------------------------------------------------------------

/**
 * The director's result surfaces no single `assetRef` field — the produced
 * asset is the `assetRef` on the LAST `generate_image` / `generate_video`
 * tool-result step in `result.steps`. Walk the log backwards and pull the
 * first one we find. Returns `{ assetRef, kind }` or null when the run produced
 * no asset (e.g. it stopped on budget before generating).
 */
type ProducedAsset = {
  assetRef: { provider: string; id: string; url: string };
  kind: 'image' | 'video';
};

function extractProducedAsset(steps: readonly Step[]): ProducedAsset | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (!step || step.type !== 'tool_result') continue;
    if (step.tool !== 'generate_image' && step.tool !== 'generate_video') continue;
    const out = step.output as { assetRef?: unknown } | null | undefined;
    const ref = out?.assetRef as
      | { provider?: unknown; id?: unknown; url?: unknown }
      | undefined;
    if (
      ref &&
      typeof ref.provider === 'string' &&
      typeof ref.id === 'string' &&
      typeof ref.url === 'string'
    ) {
      return {
        assetRef: { provider: ref.provider, id: ref.id, url: ref.url },
        kind: step.tool === 'generate_video' ? 'video' : 'image',
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reuse-asset selection
// ---------------------------------------------------------------------------

/**
 * Pick the best on-canon library asset for a reuse-day: the most recently
 * saved asset whose canon tags match the active character + this pillar. The
 * library is what `buildWeeklyContentPlan` already proved has a match, so this
 * just re-runs the same `assetMatchesCanon` facet check and returns the freshest.
 */
function pickReuseAsset(
  library: GeneratedImage[],
  characterId: AutonomyConfig['activeCharacterId'],
  pillarId: string,
): GeneratedImage | null {
  const matches = library.filter((a) =>
    assetMatchesCanon(a, { characterId, pillarId }),
  );
  if (matches.length === 0) return null;
  // Freshest first (savedAt desc); fall back to first when savedAt is absent.
  matches.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
  return matches[0] ?? null;
}

// ---------------------------------------------------------------------------
// runAutonomyTick — the orchestrator
// ---------------------------------------------------------------------------

/**
 * Execute one autonomy tick. Returns an {@link AutonomyTickResult} describing
 * what happened. A thrown error from any dependency is caught and folded into
 * `{ ...partial, queued:false, error }` so a failed tick never crashes the
 * scheduler.
 */
export async function runAutonomyTick(
  cfg: AutonomyConfig,
  deps: AutonomyTickDeps,
): Promise<AutonomyTickResult> {
  const at = deps.now.getTime();
  const day: Weekday = weekdayOf(deps.now);

  try {
    const library = await deps.loadLibrary();
    const plan = buildWeeklyContentPlan({
      featuredCharacterId: cfg.activeCharacterId,
      library,
    });
    const slot = plan.slots.find((s) => s.day === day);

    // 2. No slot for today → skip.
    if (!slot) {
      return {
        at,
        day,
        decision: 'skip',
        queued: false,
        note: `no slot for ${day}`,
      };
    }

    const pillarId = slot.pillarId;

    // 3. Reuse-day → choose the best matching library asset; queue it. Do NOT
    //    re-persist or publish — the asset is already in the library.
    if (slot.decision === 'reuse') {
      const chosen = pickReuseAsset(library, cfg.activeCharacterId, pillarId);
      if (!chosen) {
        // The plan said reuse, but no concrete match resolved — degrade to a
        // skip rather than silently generating (that would surprise the budget).
        return {
          at,
          day,
          pillarId,
          decision: 'skip',
          queued: false,
          note: `reuse planned for ${pillarId} but no matching library asset resolved`,
        };
      }
      return {
        at,
        day,
        pillarId,
        decision: 'reuse',
        assetId: chosen.id,
        queued: true,
        note: `reused on-canon ${slot.format} for ${slot.pillarName} (${pillarId})`,
      };
    }

    // 4. Generate-day → run the director, persist the produced asset as
    //    approved:false (the human approval queue).
    const directorInput = buildDirectorInput(cfg, pillarId);
    const result = await deps.runDirector(directorInput);

    // 5. Budget: the director enforces `budgetUsd`; reflect a budget stop.
    const budgetNote =
      result.truncatedBy === 'budget'
        ? ` (director stopped on budget at $${result.totalCost.toFixed(2)} of $${cfg.dailyBudgetUsd.toFixed(2)})`
        : '';

    if (result.truncatedBy === 'error') {
      return {
        at,
        day,
        pillarId,
        decision: 'generate',
        queued: false,
        note: `director errored before producing an asset for ${slot.pillarName} (${pillarId})`,
        error: 'director run failed',
      };
    }

    const produced = extractProducedAsset(result.steps);
    if (!produced) {
      return {
        at,
        day,
        pillarId,
        decision: 'generate',
        queued: false,
        note: `director produced no asset for ${slot.pillarName} (${pillarId})${budgetNote}`,
      };
    }

    const persistInput: PersistAssetInput = {
      assetRef: produced.assetRef as PersistAssetInput['assetRef'],
      metadata: {
        title: directorInput.ideaConcept,
        ...(result.finalPrompt ? { caption: result.finalPrompt.slice(0, 2200) } : {}),
        // Stamp canon facet tags so reuse-first finds this asset next week.
        tags: canonTags(cfg.activeCharacterId, pillarId),
        kind: produced.kind,
      },
    };
    const { assetId } = await deps.persistAsset(persistInput);

    return {
      at,
      day,
      pillarId,
      decision: 'generate',
      assetId,
      queued: true,
      note: `generated + queued ${produced.kind} for ${slot.pillarName} (${pillarId})${budgetNote}`,
    };
  } catch (e: unknown) {
    // A failed tick must NOT crash the scheduler. Fold the error into the
    // result; the scheduler still advances `lastTickAt`.
    return {
      at,
      day,
      decision: 'skip',
      queued: false,
      note: 'autonomy tick failed',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---------------------------------------------------------------------------
// runAutonomyOnceIfDue — scheduler entry
// ---------------------------------------------------------------------------

/**
 * Run a tick ONLY if one is due (per the pure `shouldTick`), then return the
 * new state. When due, advances `lastTickAt` to now and records `lastResult`.
 * When not due, returns the prior `state` unchanged (no work, no clock churn).
 */
export async function runAutonomyOnceIfDue(
  cfg: AutonomyConfig,
  state: AutonomyState,
  deps: AutonomyTickDeps,
): Promise<AutonomyState> {
  if (!shouldTick(deps.now, state.lastTickAt, cfg)) {
    return state;
  }
  const lastResult = await runAutonomyTick(cfg, deps);
  return {
    lastTickAt: deps.now.getTime(),
    lastResult,
  };
}
