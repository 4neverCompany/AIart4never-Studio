/**
 * Canon engine (M1 / FR-1, FR-2, FR-4, FR-5) — the in-product encoding of the
 * Master4never multiverse + the helpers the generation pipeline uses to stay
 * on-model.
 *
 * Faithful to I:\w40k-master4never\ (MULTIVERSE.md, CHANNEL-STRATEGY.md, the
 * per-character CANON.md). The data below is the single place to update when
 * the operator's canon evolves; everything downstream (system prompts, anchored
 * generation, locks, the weekly plan) reads from here.
 *
 * Load-bearing fact: the canon's #1 rule is "always EDIT from a locked
 * reference, never generate from scratch" — implemented via Higgsfield Elements
 * (`<<<id>>>`) / `--image` anchoring. MiniMax image-01 cannot take a reference
 * image, so character-anchored generation runs through the Higgsfield MCP;
 * MiniMax is the LLM (planning/prompts/captions) and an option only for
 * non-character scene plates. See RENDER_METHOD.
 */

import type {
  CanonCharacter,
  CharacterId,
  ContentPillar,
  Reality,
  RealityId,
  WatermarkRecipe,
  WeeklySlot,
} from './types';
// Story 2.8 — `getElementRef` resolves the character's anchor from the per-turn
// RunContext memo (written by the live `show_reference_elements` lookup). This is
// a type-only cycle from run-context's side (it `import type`s CharacterId), so
// there is no runtime import cycle.
import { currentRunContext } from '@/lib/agent-loop/run-context';

export * from './types';

// ---------------------------------------------------------------------------
// Realities
// ---------------------------------------------------------------------------

export const REALITIES: Readonly<Record<RealityId, Reality>> = Object.freeze({
  prime: {
    id: 'prime',
    name: 'PRIME',
    label: 'Cyberpunk PRIME',
    vibe: 'cyberpunk netrunner who slips between realities; the multiverse-traveling home reality',
    hallmarks: ['neon cyberpunk', 'netrunner tech + circuitry', 'rain-slick high-tech city', 'cyan circuit-line glow'],
  },
  w40k: {
    id: 'w40k',
    name: 'W40K',
    label: 'Grimdark W40K (inspired-by)',
    vibe: 'grimdark Warhammer-40k-INSPIRED; an original chapter, no third-party trademarks in captions',
    hallmarks: ['grimdark gothic sci-fi', 'ceramite power armor', 'candle-lit cathedral-industrial', 'battle-worn, weathered'],
  },
  'w40k-alt': {
    id: 'w40k-alt',
    name: 'W40K-ALT',
    label: 'Modern-hightech W40K',
    vibe: 'modernized-but-clearly-Astartes design study',
    hallmarks: ['modernized high-tech power armor', 'clean tech surfaces', 'still unmistakably Astartes silhouette'],
  },
});

// ---------------------------------------------------------------------------
// Characters — Story 2.8 SPINE only (routing keys). The locked look, hard
// rules, persona, and Higgsfield Element id are NO LONGER hardcoded here: they
// live in each character's CURRENT Higgsfield reference Element and are resolved
// live (`show_reference_elements` → RunContext memo → getElementRef). These
// records exist only for planning / tagging / the roster / the structural guard.
// ---------------------------------------------------------------------------

const KAEL: CanonCharacter = {
  id: 'kael',
  name: 'Master4never (Kael)',
  reality: 'prime',
  isPrime: true,
};

const KAELUS_VORNE: CanonCharacter = {
  id: 'kaelus-vorne',
  name: 'Kaelus Vorne (The Iron Halo)',
  reality: 'w40k',
  isPrime: false,
};

const KAELUS_ALT: CanonCharacter = {
  id: 'kaelus-alt',
  name: 'Kaelus (modern-hightech)',
  reality: 'w40k-alt',
  isPrime: false,
};

const CHARACTERS: Readonly<Record<CharacterId, CanonCharacter>> = Object.freeze({
  kael: KAEL,
  'kaelus-vorne': KAELUS_VORNE,
  'kaelus-alt': KAELUS_ALT,
});

// ---------------------------------------------------------------------------
// Channel strategy: pillars + the recurring weekly template
// ---------------------------------------------------------------------------

export const CONTENT_PILLARS: readonly ContentPillar[] = Object.freeze([
  { id: 'story-beat', name: 'Story-Beat', description: 'Kael visits a reality / meets a variant.', format: 'carousel' },
  { id: 'variant-reveal', name: 'Variant Reveal', description: 'A new variant or hero, one hero-shot.', format: 'reel' },
  { id: 'same-soul', name: 'Same Soul, Different Reality', description: 'Variants side-by-side (save-bait).', format: 'carousel' },
  { id: 'lore-poll', name: 'Lore / Poll', description: 'Short lore drop or "which reality next?".', format: 'story' },
]);

/**
 * The recurring weekly template. Only the Friday Story-Beat guarantees NEW
 * generation; every other slot reuses the existing library (reuse-first /
 * FR-2) to keep the cadence sustainable on a flat subscription.
 */
export const WEEKLY_TEMPLATE: readonly WeeklySlot[] = Object.freeze([
  { day: 'mon', pillarId: 'variant-reveal', format: 'carousel', guaranteesNewGen: false },
  { day: 'tue', pillarId: 'lore-poll', format: 'story', guaranteesNewGen: false },
  { day: 'wed', pillarId: 'same-soul', format: 'carousel', guaranteesNewGen: false },
  { day: 'thu', pillarId: 'lore-poll', format: 'story', guaranteesNewGen: false },
  { day: 'fri', pillarId: 'story-beat', format: 'carousel', guaranteesNewGen: true },
  { day: 'sun', pillarId: 'variant-reveal', format: 'single', guaranteesNewGen: false },
]);

// ---------------------------------------------------------------------------
// Locked recipes / mandates
// ---------------------------------------------------------------------------

/** LOCKED watermark recipe (MULTIVERSE.md §8). */
export const WATERMARK: WatermarkRecipe = Object.freeze({
  logoElementId: '6c36180d-28ba-4535-8655-dfd2b502f9ae',
  asset: '_branding-work/watermark_transparent.png',
  position: 'bottom-right',
  opacity: 0.75,
  widthFraction: 0.16,
  marginFraction: 0.03,
});

/** THE consistency rule (MULTIVERSE.md §4) — injected into every generation. */
export const CONSISTENCY_MANDATE =
  'Always EDIT from a locked reference (the character\'s Higgsfield Element `<<<id>>>` or a locked reference image fed as `--image`). NEVER generate a recurring character from scratch. A strong reference plus an explicit identity lock ("keep the SAME man, same face + bone structure, same features") anchors identity, so any transformation — new armor, new reality, even heavy aging/weathering — keeps the character unmistakably himself. Generating fresh is exactly what produced the "old man" identity-replacement failures.';

/** How the image engine renders (MULTIVERSE.md §5). */
export const RENDER_METHOD =
  'Image engine = Higgsfield (Nano Banana Pro / `nano_banana_2`) via the Higgsfield MCP, because it supports reference Elements (`<<<element_id>>>`) and `--image` anchoring that the edit-from-reference rule REQUIRES. MiniMax image-01 cannot take a reference image, so it is NOT used for character-anchored generation (LLM/planning/captions only, or non-character scene plates). Defaults: aspect 2:3, resolution 2k. Feed the character\'s locked face ref + (for a new look) a style/armor ref; multiple references fuse. Prompt = scene/pose/wardrobe + explicit identity lock + the reality\'s hallmark checklist.';

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export function getCharacter(id: CharacterId): CanonCharacter {
  const c = CHARACTERS[id];
  if (!c) throw new Error(`Unknown canon character: ${id}`);
  return c;
}

export function listCharacters(): CanonCharacter[] {
  return Object.values(CHARACTERS);
}

export function getReality(id: RealityId): Reality {
  const r = REALITIES[id];
  if (!r) throw new Error(`Unknown reality: ${id}`);
  return r;
}

export function getPillar(id: string): ContentPillar | undefined {
  return CONTENT_PILLARS.find((p) => p.id === id);
}

/**
 * The Higgsfield anchor token for a character: `<<<elementId>>>`, or undefined
 * when the character has not been resolved this turn.
 *
 * Story 2.8 — resolves SOLELY from the per-turn RunContext memo
 * (`resolvedElements`), which the live `show_reference_elements` lookup populates
 * with the character's CURRENT Higgsfield Element. There is no hardcoded id
 * anymore; a character with no live resolution returns undefined and the spend
 * path fails safe (refuses to generate un-anchored). `id` is accepted for a
 * stable call-site signature even though resolution is by the memo key.
 */
export function getElementRef(id: CharacterId): string | undefined {
  const resolved = currentRunContext()?.resolvedElements?.get(id)?.elementId;
  return resolved ? `<<<${resolved}>>>` : undefined;
}

// ---------------------------------------------------------------------------
// System-prompt injection
// ---------------------------------------------------------------------------

/**
 * Build the canon system-prompt block for a character — STRUCTURAL only
 * (Story 2.8). The per-character persona / locked look / hard rules are NO
 * LONGER hardcoded here: they live in the character's CURRENT Higgsfield Element
 * `description`, which the agent resolves live via `show_reference_elements`.
 * This block carries only the character/reality framing, the reality hallmarks
 * (structural, from REALITIES), the persistence mandate, and the standing
 * instruction to resolve the Element first. It emits NO anchor — at prompt-build
 * time nothing is resolved yet; the `<<<element>>>` anchor is prepended at spend
 * time from the RunContext memo.
 */
export function buildCanonSystemBlock(id: CharacterId): string {
  const c = getCharacter(id);
  const reality = getReality(c.reality);
  const bullets = (xs: readonly string[]) => xs.map((x) => `- ${x}`).join('\n');

  return [
    `## Canon character: ${c.name} — reality: ${reality.label}`,
    '',
    'This character\'s locked look, hard rules, and lore are NOT restated here —',
    'they live in the character\'s CURRENT Higgsfield reference Element. Resolve it',
    'with `show_reference_elements` BEFORE drafting a generation prompt; the',
    'Element `description` is the authoritative canon and overrides memory.',
    '',
    `### Reality hallmarks — ${reality.name} (${reality.vibe})`,
    bullets(reality.hallmarks),
    '',
    '### Persistence (anchored generation)',
    CONSISTENCY_MANDATE,
  ].join('\n');
}

/**
 * A compact identity-lock fragment for injection into an IMAGE prompt (vs the
 * full system block). Story 2.8: the character-AGNOSTIC lock only — the locked
 * look / hard rules now come from the live Element `description`, and the
 * `<<<element>>>` anchor is prepended at spend time from the resolved RunContext
 * memo (not here, where nothing is resolved yet).
 */
export function buildCharacterLockBlock(id: CharacterId): string {
  const c = getCharacter(id);
  return [
    `Identity lock — ${c.name}: keep the SAME man, same face + bone structure + features. Do not drift the look.`,
    'Edit from the character\'s resolved Higgsfield Element reference — never generate a recurring character from scratch.',
  ].join('\n');
}
