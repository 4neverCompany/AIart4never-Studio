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
 * Persistence tiers for a recurring entity (MULTIVERSE.md §3):
 *  T1 locked reference image(s) → T2 Higgsfield Element (reusable by id) →
 *  T3 Soul (high-fidelity, only after the look is final).
 * Anchored generation prefers the Element id (embed as `<<<id>>>`), falling
 * back to a locked reference image fed as `--image`.
 */
export interface CharacterPersistence {
  /** Higgsfield Element id (T2). Embed in a prompt as `<<<elementId>>>` for
   *  Nano Banana / GPT Image / Seedream / Kling / Cinema (NOT Soul models). */
  elementId?: string;
  /** Higgsfield Soul id (T3) — only for hero recurring characters once final. */
  soulId?: string;
  /** T1 locked reference image path(s), relative to the canon source root.
   *  The minimum anchor; always present. */
  lockedRefs: string[];
}

export interface CanonCharacter {
  id: CharacterId;
  /** Display name, e.g. "Master4never (Kael)". */
  name: string;
  reality: RealityId;
  /** PRIME (Kael) carries traits no variant has (cyberdeck, AIART4NEVER tag). */
  isPrime: boolean;
  /** One-line role. */
  role: string;
  /** The LOCKED look — fixed visual traits that must never drift across gens. */
  lookLocks: string[];
  /** Narrative personality (for captions, on-camera, voice-of-narration). */
  personality: string;
  /** Voice / narration register. */
  voice: string;
  /** On-camera behavior for reels/videos. */
  onCamera: string;
  /** HARD canon rules — the do-nots/musts that keep the character on-model.
   *  These become explicit locks in every generation prompt. */
  rules: string[];
  /** Persistence anchors (Element / Soul / locked refs). */
  persistence: CharacterPersistence;
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
