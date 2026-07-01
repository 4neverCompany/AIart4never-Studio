/**
 * Canon engine — type model for the Master4never multiverse (M1 / FR-1, FR-4, FR-5).
 *
 * The canon is the product's source of truth for WHO the recurring characters
 * are, WHAT they look like (locked, never-drifting traits), the HARD rules that
 * keep them on-model, and the persistence "Elements" used to anchor generation.
 *
 * Source of truth for the content: I:\w40k-master4never\ (MULTIVERSE.md,
 * CHANNEL-STRATEGY.md, per-character CANON.md). This module is the in-product
 * encoding the generation pipeline injects into prompts. Keep it faithful; when
 * the operator's canon evolves, update the data here (see lib/canon/index.ts).
 */

export type RealityId = 'prime' | 'w40k' | 'w40k-alt';

export interface Reality {
  id: RealityId;
  /** Short canonical name, e.g. "PRIME", "W40K". */
  name: string;
  /** Human label for pickers, e.g. "Cyberpunk PRIME". */
  label: string;
  /** One-line vibe used to orient the LLM. */
  vibe: string;
  /** Visual hallmarks of the reality — the mandatory checklist when rendering
   *  a NEW look in this reality (modernize only surfaces; keep the hallmarks). */
  hallmarks: string[];
}

export type CharacterId = 'kael' | 'kaelus-vorne' | 'kaelus-alt';

/**
 * A recurring character — Story 2.8 SPINE only. The identity that used to live
 * here (locked look, hard rules, persona, and the Higgsfield Element id) is NO
 * LONGER hardcoded: it lives in the character's CURRENT Higgsfield reference
 * Element and is resolved live (the `show_reference_elements` tool writes the
 * resolved id into the RunContext; `getElementRef` reads it). What remains are
 * the stable ROUTING KEYS used by non-generation subsystems (planning, tagging,
 * the roster/UI, the structural guard).
 */
export interface CanonCharacter {
  id: CharacterId;
  /** Display name, e.g. "Master4never (Kael)". */
  name: string;
  reality: RealityId;
  /** PRIME (Kael) is the hero; variants are separate characters. Structural
   *  routing flag only — NOT a lore trait (the lore is the live Element). */
  isPrime: boolean;
}

export interface ContentPillar {
  id: string;
  name: string;
  /** What the post does. */
  description: string;
  /** Default format. */
  format: 'carousel' | 'reel' | 'single' | 'story';
}

/** A weekly cadence slot (the recurring template that keeps output sustainable). */
export interface WeeklySlot {
  day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
  pillarId: string;
  format: ContentPillar['format'];
  /** True only for the one slot that guarantees NEW generation (the Friday beat);
   *  every other slot reuses the existing library (reuse-first / FR-2). */
  guaranteesNewGen: boolean;
}

/** The LOCKED watermark recipe (MULTIVERSE.md §8 step 5). */
export interface WatermarkRecipe {
  /** Higgsfield logo Element id the badge derives from. */
  logoElementId: string;
  /** Asset path of the transparent circular badge. */
  asset: string;
  position: 'bottom-right';
  /** 0..1 opacity. */
  opacity: number;
  /** Fraction of image width. */
  widthFraction: number;
  /** Fraction of image width used as margin. */
  marginFraction: number;
}
