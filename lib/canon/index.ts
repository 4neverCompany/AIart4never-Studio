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
// Characters (the recurring entities; each has locked look + hard rules + Element)
// ---------------------------------------------------------------------------

const KAEL: CanonCharacter = {
  id: 'kael',
  name: 'Master4never (Kael)',
  reality: 'prime',
  isPrime: true,
  role: 'Protagonist + narrator: a master Netrunner who travels the multiverse and meets variants of himself + other heroes.',
  lookLocks: [
    'ashen grey-blue skin',
    'pointed elf-like ears',
    'glowing amber/orange eyes',
    'cyan circuit-lines tracing his skin',
    'sharp, inhuman, handsome features',
    'dark hair',
    'forehead cyberdeck / nanotech tech-core (PRIME-only signature)',
    'AIART4NEVER channel tag worn legibly on his clothing in the logo\'s stylized orange lettering (PRIME-only; placement/size flexible)',
  ],
  personality:
    'The calm apex — main-character aura from unshakable composure, not volume. Perceptive, adaptive, quietly confident, curious about every reality, dry wit, deeply principled; bends to a reality\'s rules without ever losing himself (the meaning of "Master4never"). Flaw: detached — he observes more than he commits.',
  voice:
    'First-person, reflective, economical, a touch of dry humor — narrates the multiverse like a seasoned traveler\'s log, occasionally philosophical about identity ("every reality has a version of you; the only question is which choices made him").',
  onCamera:
    'The still point in the storm — enters a reality, reads it, then acts. Signature beat: his cyberdeck flares cyan as it adapts/materializes gear. Cool under pressure, lands a dry one-liner, rarely the aggressor unless forced.',
  rules: [
    'ALWAYS wears the forehead cyberdeck — his signature; PRIME-only, no variant has it.',
    'ALWAYS wears the AIART4NEVER channel tag somewhere legible on his clothing in the orange logo lettering (PRIME-only). Placement/size flexible — collar by default; can be chest, sleeve, or a large back-print. Only constant: present and reads as the brand.',
    'EDIT from his locked reference / Element; never regenerate from scratch.',
    'Lock identity explicitly ("keep the SAME man, same face + bone structure, same features") so any transformation keeps him unmistakably himself.',
  ],
  persistence: {
    elementId: '9349dc19-0801-40de-8bb6-e433328f83e2',
    soulId: '7930f6de',
    lockedRefs: [
      '_reference/Master4never__PRIME__channel-tag__AIART4NEVER-collar.png',
      '_reference/Master4never_element_image_3d03fb8a.png',
    ],
  },
};

const KAELUS_VORNE: CanonCharacter = {
  id: 'kaelus-vorne',
  name: 'Kaelus Vorne (The Iron Halo)',
  reality: 'w40k',
  isPrime: false,
  role: 'The W40K-native variant of Master4never: Chapter Master of the "Ashen Halo". A SEPARATE character — the reality\'s own son of war, not Kael visiting.',
  lookLocks: [
    'young',
    'short dark beard',
    'battle scars',
    '3 metal service studs on the left brow',
    'cybernetic port at the right temple',
    'ashen grey-blue skin',
    'pointed elf-like ears',
    'glowing amber eyes',
    'sharp inhuman features',
    'CLEAN forehead (NO cyberdeck)',
    'crimson + black ceramite power armor, gold trim, massive pauldrons',
    'radiant golden Iron Halo behind the head; heraldry = a burning golden halo encircling an upright sword',
  ],
  personality:
    'The grimdark mirror of Kael — the path-not-taken. Where Kael wanders and observes, Kaelus committed: stern, iron-disciplined, duty- and faith-bound, weary gravitas. Has buried too many brothers and believes in the mission absolutely; honor before self. Rare, grim humor; zealous but a leader, not a fanatic.',
  voice:
    'Formal, archaic-militant 40K cadence — low, measured, commanding. Invokes the Emperor and the burning halo ("By the Ashen Halo…", "The Emperor protects."). Speaks rarely and with weight; silence is a tool.',
  onCamera:
    'Command presence — stillness reads as menace; bare-headed always (helm mag-locked or held). In action: economical, brutal, decisive. The Iron Halo flares with his resolve. Meeting Kael: a long weighing silence, mutual recognition of one soul on a different road.',
  rules: [
    'NO cyberdeck — the forehead tech-core is PRIME-only; never on a variant, especially the face.',
    'Service studs / skull implants ARE allowed (native Astartes iconography; ~one stud per century of service).',
    'Does NOT wear the AIART4NEVER channel tag (PRIME-only); his published content gets the watermark Element overlaid at publish time instead.',
    'No helmet in hero shots (Main Character Aura); helm held or mag-locked.',
    'EDIT from his locked reference / Element; never regenerate from scratch. Lock the face explicitly ("keep the SAME man; do NOT age him") — then any weathering keeps his identity.',
  ],
  persistence: {
    elementId: '812c9a78-4b78-4910-a301-3083c8c65ecc',
    lockedRefs: [
      'KaelusVorne-W40K-VARIANT__SoulV1/KaelusVorne__W40K__CANON-FACE__young-beard-scars-studs.png',
      'KaelusVorne-W40K-VARIANT__SoulV1/KaelusVorne__W40K__CANON__chapter-master-ashen-halo__armor-v1.png',
    ],
  },
};

const KAELUS_ALT: CanonCharacter = {
  id: 'kaelus-alt',
  name: 'Kaelus (modern-hightech)',
  reality: 'w40k-alt',
  isPrime: false,
  role: 'Design study: modernized-but-clearly-Astartes armor on Kaelus\' face. Not yet a locked Element.',
  lookLocks: [
    "Kaelus' face (young, short beard, scars, brow studs, NO cyberdeck)",
    'modernized high-tech power armor that still reads clearly as Astartes',
    'black + crimson + orange palette (candidate)',
  ],
  personality: 'Same character as Kaelus Vorne — an alt-armor study; reads with the same stern, duty-bound gravitas.',
  voice: 'Same as Kaelus Vorne (archaic-militant 40K cadence).',
  onCamera: 'Same command presence as Kaelus Vorne.',
  rules: [
    'Design study only — no registered Element yet; the candidate reference must be locked before reuse.',
    'Same hard rules as Kaelus Vorne: NO cyberdeck, does NOT wear the AIART4NEVER tag, service studs OK.',
    'EDIT from the candidate reference; never regenerate from scratch.',
  ],
  persistence: {
    lockedRefs: ['KaelusVorne-ALT-modern-hightech/KaelusVorne__W40K-ALT__takeB2-40K-black-crimson-orange.png'],
  },
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
 * The Higgsfield anchor token for a character: `<<<elementId>>>` when the
 * character has a registered Element, else undefined (the caller must fall
 * back to a locked reference image — see the character's persistence.lockedRefs).
 */
export function getElementRef(id: CharacterId): string | undefined {
  const el = getCharacter(id).persistence.elementId;
  return el ? `<<<${el}>>>` : undefined;
}

// ---------------------------------------------------------------------------
// System-prompt injection
// ---------------------------------------------------------------------------

/**
 * Build the canon system-prompt block for a character — the persona + locked
 * look + hard rules + the persistence mandate + the reality hallmarks. This is
 * injected into the LLM system prompt (text + director modes) so every prompt,
 * caption, and plan stays on-model.
 */
export function buildCanonSystemBlock(id: CharacterId): string {
  const c = getCharacter(id);
  const reality = getReality(c.reality);
  const anchor = getElementRef(id) ?? `locked reference image (${c.persistence.lockedRefs[0]})`;
  const bullets = (xs: readonly string[]) => xs.map((x) => `- ${x}`).join('\n');

  return [
    `## Canon character: ${c.name} — reality: ${reality.label}`,
    `Role: ${c.role}`,
    `Personality: ${c.personality}`,
    `Voice: ${c.voice}`,
    `On-camera: ${c.onCamera}`,
    '',
    '### Locked look (must never drift across generations)',
    bullets(c.lookLocks),
    '',
    '### Hard canon rules (apply as explicit locks in every prompt)',
    bullets(c.rules),
    '',
    `### Reality hallmarks — ${reality.name} (${reality.vibe})`,
    bullets(reality.hallmarks),
    '',
    '### Persistence (anchored generation)',
    CONSISTENCY_MANDATE,
    `Anchor for this character: ${anchor}.`,
  ].join('\n');
}

/**
 * A compact look + rules fragment for injection into an IMAGE prompt (vs the
 * full system block). Returns the identity-lock the image model needs.
 */
export function buildCharacterLockBlock(id: CharacterId): string {
  const c = getCharacter(id);
  const anchor = getElementRef(id);
  const lines = [
    `Identity lock — ${c.name}: keep the SAME man, same face + bone structure + features. Do not drift the look.`,
    `Locked look: ${c.lookLocks.join('; ')}.`,
    `Rules: ${c.rules.join(' ')}`,
  ];
  if (anchor) lines.push(`Anchor element: ${anchor}.`);
  else lines.push(`Anchor: edit from ${c.persistence.lockedRefs[0]} (no registered Element yet).`);
  return lines.join('\n');
}
