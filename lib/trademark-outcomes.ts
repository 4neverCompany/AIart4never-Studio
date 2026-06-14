// TRADEMARK-LEARNING (2026-05-21, per-model rewrite 2026-05-23):
// localStorage-backed outcome store for known-IP names. Companion to
// lib/extract-trademark-names.ts.
//
// The pipeline records two signals into this store as it runs:
//
// 1. Pre-flight (in useIdeaProcessor.triggerImageGeneration) — extract
//    names from the prompt, look each up, and rewrite the prompt to
//    replace 'blocked' names with generic equivalents BEFORE submitting
//    to the provider. Saves the API call and the user-visible "blocked,
//    retrying" status flash.
//
// 2. Post-flight outcome — when generation comes back with TRADEMARK
//    moderation, mark the extracted name 'blocked' FOR THE SPECIFIC
//    MODEL that returned the block. When generation succeeds without
//    moderation, mark every extracted name 'allowed' for that model
//    (but only when not already 'blocked' — a blocked name doesn't get
//    revived by a coincidental successful prompt that contained it).
//
// IMG-INVEST-001 issue 2: the store is now PER-MODEL. Different image
// providers (Leonardo's nano-banana family vs MiniMax-native vs GPT-Image
// models) have very different moderation strictness — a name blocked by
// nano-banana-2 might happily pass through gpt-image-2. The previous flat
// `Record<string, NameOutcome>` poisoned all models with a single
// upstream's filter; per-model storage lets each model learn its own
// blocklist organically.
//
// Storage shape: `Record<name, Record<modelId, NameOutcome>>`.
//
// Bootstrap: no seed list. Brief explicitly says "system must relearn
// per model going forward." First-time users start with an empty store;
// the post-flight TRADEMARK signal fills it in as the pipeline runs.
//
// Migration: the v1 key `mashup_trademark_outcomes` (flat model-agnostic
// map) and the v1 whitelist key `mashup_trademark_user_whitelist` are
// wiped on the first v2 read. Users will re-experience some moderation
// blocks until the per-model store fills back up — that's the expected
// "relearn" behaviour.

import { TRADEMARK_SEED_LIST, extractTrademarkNames } from './extract-trademark-names';

export type NameOutcome = 'blocked' | 'allowed' | 'unknown';

const STORAGE_KEY = 'mashup_trademark_outcomes_v2';
const LEGACY_STORAGE_KEY = 'mashup_trademark_outcomes';

/** name → modelId → outcome. */
type OutcomeMap = Record<string, Record<string, NameOutcome>>;

let legacyWiped = false;
function wipeLegacyOnce(): void {
  if (legacyWiped) return;
  legacyWiped = true;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_USER_WHITELIST_KEY);
  } catch {
    // Best-effort.
  }
}

function readMap(): OutcomeMap {
  if (typeof window === 'undefined') return {};
  wipeLegacyOnce();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as OutcomeMap;
      }
    }
  } catch {
    // Parse failure or storage access denied — start fresh.
  }
  return {};
}

function writeMap(map: OutcomeMap): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Quota exceeded or storage unavailable — best-effort.
  }
}

/** Return the recorded outcome for `name` on `modelId`. Unknown = no observation yet. */
export function getOutcome(name: string, modelId: string): NameOutcome {
  const map = readMap();
  return map[name]?.[modelId] ?? 'unknown';
}

/**
 * BUG-FIX-2026-06-06: per-model blocklist grouping for the Settings UI.
 *
 * Returns a map of modelId → sorted list of names currently flagged
 * 'blocked' for that model. The user-whitelist still wins (a name the
 * user has whitelisted never appears in any model's blocked list, since
 * the whitelist is the user-override layer). Names with no recorded
 * observation for a given model (outcome = 'unknown' / 'allowed' for
 * that model) are excluded.
 *
 * Used by SettingsModal to render a per-model breakdown like:
 *   Nano-banana-2 (3): Spider-Man, Iron Man, Yoda
 *   GPT-Image-2 (1):   Spider-Man
 * so the user can see at a glance which model is the stricter filter.
 */
export function getBlockedByModel(): Record<string, string[]> {
  const map = readMap();
  const whitelist = readUserWhitelist();
  const out: Record<string, string[]> = {};
  for (const [name, perModel] of Object.entries(map)) {
    if (whitelist.has(name)) continue;
    for (const [modelId, outcome] of Object.entries(perModel)) {
      if (outcome !== 'blocked') continue;
      if (!out[modelId]) out[modelId] = [];
      out[modelId].push(name);
    }
  }
  // Sort each model's blocked list alphabetically for stable display.
  for (const modelId of Object.keys(out)) {
    out[modelId].sort((a, b) => a.localeCompare(b));
  }
  return out;
}

/**
 * Record an outcome for `name` on `modelId`. Idempotent. A 'blocked'
 * marking on a specific (name, modelId) pair never gets overwritten by
 * 'allowed' — once a name has reliably failed on this model, subsequent
 * coincidental successes shouldn't revive it.
 */
export function setOutcome(name: string, outcome: NameOutcome, modelId: string): void {
  const map = readMap();
  const cur = map[name]?.[modelId];
  if (cur === 'blocked' && outcome !== 'blocked') return;
  if (!map[name]) map[name] = {};
  map[name][modelId] = outcome;
  writeMap(map);
}

/**
 * Return every name currently flagged 'blocked'. Used by the AI prompt
 * builder to inject a "TRADEMARKED CHARACTERS TO AVOID" line so the
 * upstream prompt-enhance step learns from past failures.
 *
 * - With `modelId`: names blocked specifically for that model.
 * - Without `modelId`: the union — any name blocked for at least one
 *   model. Useful when the caller hasn't picked a model yet (e.g. the
 *   pipeline's expandIdeaToPrompt step runs before model selection).
 */
export function getAllBlocked(modelId?: string): string[] {
  const map = readMap();
  // TRADEMARK-STAGED-PIPELINE (2026-05-22): respect the user whitelist
  // — names the user has explicitly marked safe must not appear in
  // the blocked list (the AI prompt hint shouldn't tell the model to
  // avoid a name the user has greenlit).
  const whitelist = readUserWhitelist();
  const out: string[] = [];
  for (const [name, perModel] of Object.entries(map)) {
    if (whitelist.has(name)) continue;
    if (modelId === undefined) {
      if (Object.values(perModel).some((v) => v === 'blocked')) out.push(name);
    } else if (perModel[modelId] === 'blocked') {
      out.push(name);
    }
  }
  return out;
}

/** Test seam — clear the store entirely (only test files use this). */
export function __resetForTests(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(USER_WHITELIST_KEY);
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_USER_WHITELIST_KEY);
  } catch {
    // Best-effort.
  }
  // Reset the once-flag so tests that re-stub localStorage see the
  // legacy wipe fire again on the next read.
  legacyWiped = false;
}

// ── User whitelist (TRADEMARK-STAGED-PIPELINE, 2026-05-22) ──────────────
//
// Maurice flagged that the auto outcome store's sticky-blocked guard
// blocks the user from un-blocking names they know are safe (e.g.
// Mandalorian historically passed gallery generations but got
// auto-flagged once and stayed blocked). The user-whitelist layer is a
// hard override that sits on top of the auto outcome store: any name
// in the whitelist is treated as ALLOWED regardless of what the auto
// store says. Auto-marking ('blocked') still happens on TRADEMARK
// failures (see useIdeaProcessor onModelError) but its read-side
// effect is suppressed by the whitelist.
//
// The whitelist is intentionally NOT per-model: it expresses user
// intent ("I personally vouch this name is safe") which doesn't depend
// on which model is rendering.

const USER_WHITELIST_KEY = 'mashup_trademark_user_whitelist_v2';
const LEGACY_USER_WHITELIST_KEY = 'mashup_trademark_user_whitelist';

function readUserWhitelist(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  wipeLegacyOnce();
  try {
    const raw = window.localStorage.getItem(USER_WHITELIST_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

function writeUserWhitelist(s: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(USER_WHITELIST_KEY, JSON.stringify([...s]));
  } catch {
    // Best-effort.
  }
}

/** Add a name to the user-whitelist. Idempotent. */
export function addUserWhitelist(name: string): void {
  const s = readUserWhitelist();
  s.add(name);
  writeUserWhitelist(s);
}

/** Remove a name from the user-whitelist. Idempotent. */
export function removeUserWhitelist(name: string): void {
  const s = readUserWhitelist();
  s.delete(name);
  writeUserWhitelist(s);
}

/** True iff the user has explicitly whitelisted this name. */
export function isUserWhitelisted(name: string): boolean {
  return readUserWhitelist().has(name);
}

/** All names the user has whitelisted (sorted for stable UI display). */
export function getAllUserWhitelisted(): string[] {
  return [...readUserWhitelist()].sort();
}

/**
 * Effective "should I block this name on this model?" check. True only
 * when the auto outcome store says blocked for the given model AND the
 * user hasn't whitelisted it. This is what the retry-substitution path
 * should use — getOutcome() alone misses the user-whitelist override.
 */
export function isEffectivelyBlocked(name: string, modelId: string): boolean {
  if (isUserWhitelisted(name)) return false;
  return getOutcome(name, modelId) === 'blocked';
}

/**
 * Map a known-blocked trademarked name to a safe generic descriptor.
 * Lookup is case-insensitive against the exact canonical name as
 * extracted by `extractTrademarkNames`. Fallback for names not in this
 * table is a permissive "a popular character" — enough signal for the
 * model to keep the visual cue without quoting the IP verbatim.
 *
 * TRADEMARK-SURGICAL-REWRITE (2026-05-21): generics enriched per
 * Maurice's "generic descriptions are NOT acceptable — they lose what
 * makes the character distinct" rule. Previously entries like
 * "a patriotic shield-bearing hero" stripped Captain America down to
 * something the model couldn't visualize correctly. Now each entry
 * carries enough visual cues (colors, silhouette, signature props) to
 * keep the visual identity recoverable without the name.
 */
const GENERIC_FOR: Record<string, string> = {
  // Marvel — Spider-Family
  'spider-man': 'a red and blue spider-themed hero in a web-pattern suit with a black spider emblem',
  'spidey': 'a red and blue spider-themed hero in a web-pattern suit',
  'web-slinger': 'a red and blue spider-themed hero in a web-pattern suit',
  'miles morales': 'a young black-and-red spider-themed hero in a hooded web-pattern suit',
  'peter parker': 'a red and blue spider-themed hero in a web-pattern suit',
  'gwen stacy': 'a white-and-pink spider-themed heroine with hood up and ballet pose',
  'spider-gwen': 'a white-and-pink spider-themed heroine with hood up and ballet pose',
  // Marvel — Avengers / X-Men
  'iron man': 'a hero in red and gold high-tech armored battlesuit with glowing chest reactor',
  'tony stark': 'a hero in red and gold high-tech armored battlesuit with glowing chest reactor',
  'captain america': 'a hero in a red, white, and blue armored suit with a star emblem and round shield with concentric stripes',
  'steve rogers': 'a hero in a red, white, and blue armored suit with a star emblem and round shield with concentric stripes',
  'thor': 'a blonde norse-themed warrior in armor and red cape wielding a short hammer with crackling lightning',
  'loki': 'a horned-helmeted trickster in green and gold robes holding twin daggers',
  'hulk': 'a giant green-skinned muscular brute in torn purple pants',
  'bruce banner': 'a giant green-skinned muscular brute in torn purple pants',
  'black widow': 'a redhead spy in a black tactical bodysuit with wrist gauntlets',
  'hawkeye': 'an archer in a purple-and-black tactical suit with a compound bow',
  'black panther': 'a sleek black-armored panther-themed warrior with silver claws and tribal vibranium accents',
  't\'challa': 'a sleek black-armored panther-themed warrior with silver claws and tribal vibranium accents',
  'doctor strange': 'a goateed sorcerer in red Cloak of Levitation with mandala-glowing-rune hand gestures',
  'scarlet witch': 'a crimson-clad witch with a tiara and chaos-magic energy crackling around her hands',
  'vision': 'a synthetic android with red skin, green-and-yellow tunic, and a glowing yellow forehead gem',
  'wolverine': 'a stocky clawed mutant in yellow-and-blue suit with three retractable metal claws per hand',
  'logan': 'a stocky clawed mutant in yellow-and-blue suit with three retractable metal claws per hand',
  'deadpool': 'a red-and-black masked mercenary in a tactical suit with twin katanas crossed on his back',
  'wade wilson': 'a red-and-black masked mercenary in a tactical suit with twin katanas crossed on his back',
  'storm': 'a white-haired mutant in a black-and-white cape with crackling weather-energy around her',
  'cyclops': 'a blue-suited mutant in a yellow X-emblem with a glowing red visor firing optic beams',
  'jean grey': 'a red-haired mutant in green-and-gold suit haloed in fiery telepathic energy',
  'magneto': 'a regal silver-haired villain in a red helmet and purple-and-red cape controlling floating metal',
  'professor x': 'a bald telepathic mentor in a wheelchair, fingers to temple, surrounded by mind-glow',
  'doctor doom': 'a regal villain in green-cloaked iron-faced armor with metal mask and gauntlets',
  'thanos': 'a colossal purple-skinned cosmic warlord in golden armor with a gauntlet of glowing gems',
  // DC
  'batman': 'a brooding vigilante in matte-black armored bat-suit with cape, cowl, and yellow utility belt',
  'bruce wayne': 'a brooding vigilante in matte-black armored bat-suit with cape, cowl, and yellow utility belt',
  'superman': 'a flying caped hero in a blue suit, red cape, and red boots with a stylized chest emblem',
  'clark kent': 'a flying caped hero in a blue suit, red cape, and red boots with a stylized chest emblem',
  'wonder woman': 'an amazonian warrior in red-and-blue armor with golden tiara, lasso, and silver bracers',
  'diana prince': 'an amazonian warrior in red-and-blue armor with golden tiara, lasso, and silver bracers',
  'flash': 'a speedster in a head-to-toe crimson suit with yellow lightning-bolt emblem and ear-wings',
  'barry allen': 'a speedster in a head-to-toe crimson suit with yellow lightning-bolt emblem and ear-wings',
  'aquaman': 'a long-haired ocean king in golden scale-armor and green pants wielding a glowing trident',
  'green lantern': 'a hero in a black-and-green suit projecting green energy constructs from a glowing ring',
  'joker': 'a cackling pale-faced villain with green hair, red lips, and a purple suit',
  'harley quinn': 'a red-and-black harlequin-themed antihero with bleached pigtails and an oversized mallet',
  'catwoman': 'a feline thief in a sleek black leather catsuit with goggles and a whip',
  // Star Wars
  'darth vader': 'a tall black-armored sith lord in flowing cape, ribbed black helmet, and red glowing lightsaber',
  'anakin skywalker': 'a tall black-armored sith lord in flowing cape, ribbed black helmet, and red glowing lightsaber',
  'luke skywalker': 'a young jedi knight in black tunic with a green glowing lightsaber',
  'leia organa': 'a rebel princess in flowing white robes with twin-bun hairstyle and a determined gaze',
  'princess leia': 'a rebel princess in flowing white robes with twin-bun hairstyle and a determined gaze',
  'han solo': 'a roguish space smuggler in a white shirt, black vest, and side-holstered blaster pistol',
  'obi-wan kenobi': 'a robed jedi mentor with greying beard and a blue glowing lightsaber',
  'yoda': 'a tiny long-eared green alien sage in beige robes holding a wooden cane',
  'grogu': 'a tiny long-eared green-skinned alien child in beige robes with huge dark eyes',
  'baby yoda': 'a tiny long-eared green-skinned alien child in beige robes with huge dark eyes',
  'mandalorian': 'a bounty hunter in matte beskar armor and T-visor helmet with a jetpack and shoulder cape',
  'din djarin': 'a bounty hunter in matte beskar armor and T-visor helmet with a jetpack and shoulder cape',
  'jedi': 'a robed sci-fi knight wielding a glowing blue or green plasma sword',
  'sith': 'a black-robed dark sci-fi warlord wielding a glowing red plasma sword',
  'boba fett': 'a bounty hunter in green-and-rust mandalorian armor with a T-visor helmet and jetpack',
  'jango fett': 'a bounty hunter in blue-and-silver mandalorian armor with a T-visor helmet and jetpack',
  'kylo ren': 'a black-robed sith apprentice in cracked silver-cross helmet wielding a crossguard red plasma sword',
  // Warhammer 40k
  'astartes': 'a colossal armored sci-fi super-soldier in painted ceramite power armor with bolter',
  'space marine': 'a colossal armored sci-fi super-soldier in painted ceramite power armor with bolter',
  'tyranid': 'a chitinous alien xenomorph-like creature with scythed forelimbs and a maw of fangs',
  'tyranids': 'a swarm of chitinous alien creatures with scythed forelimbs and fanged maws',
  'imperial guard': 'human conscript soldiers in olive-drab flak armor with peaked caps and lasguns',
  'astra militarum': 'human conscript soldiers in olive-drab flak armor with peaked caps and lasguns',
  'primarch': 'a colossal genetically-engineered armored warlord, twice the size of a super-soldier',
  'custodes': 'a golden-armored elite guardian with crested helmet and tall guardian spear',
  'inquisitor': 'a grim-faced cloaked sci-fi agent in dark robes with rosette pendant and bolt pistol',
  'ork': 'a green-skinned brutish alien warrior with tusks, plate scrap-armor, and a heavy shoota',
  'orks': 'green-skinned brutish alien warriors with tusks, plate scrap-armor, and heavy shootas',
  'eldar': 'a graceful tall alien in form-fitting blue armor with pointed crested helmet',
  'necron': 'a skeletal robotic alien with glowing green eyes wielding a gauss flayer',
  'tau': 'a sleek alien soldier in white-and-orange battlesuit with a pulse rifle',
  'tau empire': 'sleek alien soldiers in white-and-orange battlesuits with pulse rifles',
  // Other
  'master chief': 'a hulking armored super-soldier in olive-green Mjolnir power armor with mirrored gold visor',
  'geralt of rivia': 'a stoic white-haired monster hunter in black armor with twin swords on his back',
  'mario': 'a stocky mustachioed plumber in red shirt, blue overalls, and red cap with white "M" emblem',
  'luigi': 'a tall mustachioed plumber in green shirt, blue overalls, and green cap with white "L" emblem',
  'link': 'a young blonde-haired hero in a green tunic and pointed cap wielding a master sword',
  'zelda': 'a princess with golden hair in flowing royal blue-and-white robes with triforce emblem',
  'pikachu': 'a small yellow electric mouse creature with red cheek-spots and a lightning-bolt tail',
};

export function genericFor(name: string): string {
  return GENERIC_FOR[name.toLowerCase()] ?? 'a popular character';
}

// ── Staged retry helpers (TRADEMARK-STAGED-PIPELINE, 2026-05-22) ────────
//
// Maurice's spec: a TRADEMARK/COPYRIGHT block triggers a 3-stage
// retry, not a single attempt. Stage 1 is the original prompt; stage
// 2 is a minimal placeholder swap of ONE term; stage 3 is the same
// term swapped with the rich GENERIC_FOR descriptor. The picker below
// is the single source of truth for "which term should we swap?" so
// both retry sites (submitWithOneRetry, submitViaAiImageWithOneRetry,
// useComparison inline retry) pick the same target.
//
// Selection precedence:
//   1. Skip any name the user has whitelisted (hard override).
//   2. Prefer names recorded as outcome='blocked' for THIS MODEL in
//      the auto store — the system has already learned these are real
//      blockers for this specific provider.
//   3. Within each tier, prefer the LONGEST canonical name — multi-
//      word names are more specific (e.g. "Miles Morales" before
//      "Morales") and reduce false-positive substring matches.
//   4. If no candidate survives, return null and the caller surfaces
//      the original moderation error.
//
// We deliberately do NOT use the LLM to pick the target — the failed
// prompt's text + the outcome store are deterministic signals; an LLM
// pick would re-introduce the variance Maurice flagged in earlier
// iterations of the rewrite path.

const MINIMAL_PLACEHOLDER = 'a character';

function replaceNameInPrompt(prompt: string, name: string, replacement: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'gi');
  return prompt.replace(re, replacement);
}

export interface StagedSubstitutionPlan {
  /** The single trademark name targeted across stages 2 and 3. */
  targetName: string;
  /** Original prompt with `targetName` replaced by a minimal placeholder. */
  stage2Prompt: string;
  /** Original prompt with `targetName` replaced by its rich GENERIC_FOR descriptor. */
  stage3Prompt: string;
}

/**
 * Pick the single trademark term to substitute and build the stage 2
 * + stage 3 prompts. Returns null when no candidate is eligible (the
 * caller must then rethrow the original moderation error).
 *
 * `modelId` scopes Tier 1 (history-blocked) lookups to a single model
 * — a name blocked by Leonardo nano-banana-2 doesn't bias the picker
 * when planning a retry for gpt-image-2. Tier 2 (any extracted name)
 * stays model-agnostic.
 *
 * `extractedCandidates` is optional — pass `extractTrademarkNames(prompt)`
 * here if you already computed it (avoids duplicate scans).
 */
export function planStagedSubstitution(
  prompt: string,
  modelId: string,
  extractedCandidates?: string[],
): StagedSubstitutionPlan | null {
  const names = extractedCandidates ?? extractTrademarkNames(prompt);
  if (names.length === 0) return null;

  const whitelist = readUserWhitelist();
  const eligible = names.filter((n) => !whitelist.has(n));
  if (eligible.length === 0) return null;

  // Tier 1: explicitly blocked FOR THIS MODEL. Tier 2: any extracted name.
  const blocked = eligible.filter((n) => getOutcome(n, modelId) === 'blocked');
  const tier = blocked.length > 0 ? blocked : eligible;
  // Longest canonical first — multi-word > single-word.
  const sorted = [...tier].sort((a, b) => b.length - a.length);
  const targetName = sorted[0];

  return {
    targetName,
    stage2Prompt: replaceNameInPrompt(prompt, targetName, MINIMAL_PLACEHOLDER),
    stage3Prompt: replaceNameInPrompt(prompt, targetName, genericFor(targetName)),
  };
}

// Re-export the seed list so callers that need to know "what names
// might be in this store" (e.g. UI surfaces, debug views) have one
// import.
export { TRADEMARK_SEED_LIST } from './extract-trademark-names';
