/**
 * Reuse-first weekly content plan (M1 / FR-2).
 *
 * The channel is credit-sustainable because most weekly slots REUSE an
 * existing on-canon asset; only the Friday Story-Beat guarantees NEW
 * generation (CHANNEL-STRATEGY.md). This module turns the canon WEEKLY_TEMPLATE
 * into a concrete plan, deciding reuse-vs-generate per slot against the asset
 * library, and reports how many new generations the week actually costs.
 *
 * Assets become reusable-by-facet through standardized canon TAGS
 * (`character:<id>`, `reality:<id>`, `pillar:<id>`) applied at generation time
 * (canonTags). The library query is structural — any record with a `tags`
 * array (e.g. a GeneratedImage) works — so this stays decoupled from storage.
 */

import { WEEKLY_TEMPLATE, getCharacter, getPillar } from './index';
import type { CharacterId, ContentPillar, RealityId, WeeklySlot } from './types';

/**
 * Standardized canon tags to stamp on a generated asset so it can be reused by
 * character / reality / pillar. Apply these via the image metadata `tags` on
 * generation; reuse-first then finds the asset by facet.
 */
export function canonTags(characterId: CharacterId, pillarId?: string): string[] {
  const c = getCharacter(characterId);
  const tags = [`character:${characterId}`, `reality:${c.reality}`];
  if (pillarId) tags.push(`pillar:${pillarId}`);
  return tags;
}

/** Minimal asset shape the planner needs — anything tag-bearing (e.g. GeneratedImage). */
export interface TaggedAsset {
  tags?: readonly string[];
}

/** Does an asset match the given canon facets (by its tags)? */
export function assetMatchesCanon(
  asset: TaggedAsset,
  facets: { characterId?: CharacterId; pillarId?: string },
): boolean {
  const t = asset.tags ?? [];
  if (facets.characterId && !t.includes(`character:${facets.characterId}`)) return false;
  if (facets.pillarId && !t.includes(`pillar:${facets.pillarId}`)) return false;
  return true;
}

export type PlanDecision = 'reuse' | 'generate';

export interface PlannedSlot {
  day: WeeklySlot['day'];
  pillarId: string;
  pillarName: string;
  format: ContentPillar['format'];
  characterId: CharacterId;
  realityId: RealityId;
  decision: PlanDecision;
  /** Why this slot reuses or generates. */
  reason: string;
}

export interface WeeklyPlanInput {
  /** The character the week features. Default 'kael' (the protagonist). */
  featuredCharacterId?: CharacterId;
  /** The asset library to reuse from (each item is any tag-bearing record). */
  library?: ReadonlyArray<TaggedAsset>;
}

export interface WeeklyPlan {
  slots: PlannedSlot[];
  /** Count of slots that require NEW generation this week — reuse-first keeps
   *  this minimal (ideally just the Friday Story-Beat). */
  newGenCount: number;
  /** Count of slots served from the existing library. */
  reuseCount: number;
}

/**
 * Build the week's content plan from the canon WEEKLY_TEMPLATE, deciding
 * reuse-vs-generate per slot:
 *   - a `guaranteesNewGen` slot (the Friday Story-Beat) always generates;
 *   - otherwise reuse if the library has an on-canon asset for that
 *     character + pillar; else generate (the library hasn't grown into that
 *     slot yet — a one-time cost that amortizes as the library fills).
 *
 * v1 features ONE character per week (the `featuredCharacterId`); richer
 * per-pillar casting (e.g. the "Same Soul" pair) is a later refinement.
 */
export function buildWeeklyContentPlan(input: WeeklyPlanInput = {}): WeeklyPlan {
  const featured = input.featuredCharacterId ?? 'kael';
  const realityId = getCharacter(featured).reality;
  const library = input.library ?? [];

  const slots: PlannedSlot[] = WEEKLY_TEMPLATE.map((slot) => {
    const hasReusable = library.some((a) =>
      assetMatchesCanon(a, { characterId: featured, pillarId: slot.pillarId }),
    );

    let decision: PlanDecision;
    let reason: string;
    if (slot.guaranteesNewGen) {
      decision = 'generate';
      reason = 'guaranteed new-generation slot (the Friday Story-Beat)';
    } else if (hasReusable) {
      decision = 'reuse';
      reason = 'an on-canon asset for this character + pillar already exists';
    } else {
      decision = 'generate';
      reason = 'no reusable on-canon asset for this slot yet (one-time cost)';
    }

    return {
      day: slot.day,
      pillarId: slot.pillarId,
      pillarName: getPillar(slot.pillarId)?.name ?? slot.pillarId,
      format: slot.format,
      characterId: featured,
      realityId,
      decision,
      reason,
    };
  });

  const newGenCount = slots.filter((s) => s.decision === 'generate').length;
  return { slots, newGenCount, reuseCount: slots.length - newGenCount };
}
