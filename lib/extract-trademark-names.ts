// TRADEMARK-LEARNING (2026-05-21): named-IP extraction utility for the
// pre-flight allowlist check in the pipeline. The companion outcome
// store (lib/trademark-outcomes.ts) records which names have been
// observed to fail / succeed at moderation; this file's job is just to
// surface candidate names from a prompt string so the store has
// something to look up.
//
// Seed list curated from Marvel / DC / Star Wars / Warhammer / a few
// other franchises Maurice's pipeline has historically targeted. The
// list is intentionally MAYBE-trademarked (some entries like "Yoda"
// have actually been observed to pass Leonardo's moderation); the
// outcome store filters down to the KNOWN-blocked subset on read. Adding
// a name here is cheap — a false positive at extraction time just means
// one extra lookup against the store.
//
// Matching is case-insensitive whole-word/phrase scan. Multi-word names
// (e.g. "Miles Morales") use a literal substring lookup with case fold
// because regex word boundaries get awkward across hyphens and titles.

const TRADEMARK_SEED_NAMES: readonly string[] = [
  // Marvel — Spider-Family
  'Spider-Man', 'Spidey', 'Web-Slinger',
  'Miles Morales', 'Peter Parker',
  'Gwen Stacy', 'Spider-Gwen',
  // Marvel — Avengers / X-Men
  'Iron Man', 'Tony Stark',
  'Captain America', 'Steve Rogers',
  'Thor', 'Loki',
  'Hulk', 'Bruce Banner',
  'Black Widow', 'Natasha Romanoff',
  'Hawkeye',
  'Black Panther', 'T\'Challa',
  'Doctor Strange', 'Stephen Strange',
  'Scarlet Witch', 'Wanda Maximoff',
  'Vision',
  'Wolverine', 'Logan',
  'Deadpool', 'Wade Wilson',
  'Storm', 'Cyclops', 'Jean Grey', 'Magneto', 'Professor X',
  'Doctor Doom',
  'Thanos',
  // DC
  'Batman', 'Bruce Wayne',
  'Superman', 'Clark Kent',
  'Wonder Woman', 'Diana Prince',
  'Flash', 'Barry Allen',
  'Aquaman',
  'Green Lantern',
  'Joker',
  'Harley Quinn',
  'Catwoman',
  // Star Wars
  'Darth Vader', 'Anakin Skywalker',
  'Luke Skywalker',
  'Leia Organa', 'Princess Leia',
  'Han Solo',
  'Obi-Wan Kenobi',
  'Yoda', 'Grogu', 'Baby Yoda',
  'Mandalorian', 'Din Djarin',
  'Jedi', 'Sith',
  'Boba Fett', 'Jango Fett',
  'Kylo Ren',
  // Warhammer 40k
  'Astartes', 'Space Marine',
  'Tyranid', 'Tyranids',
  'Imperial Guard', 'Astra Militarum',
  'Primarch',
  'Custodes',
  'Inquisitor',
  'Ork', 'Orks',
  'Eldar',
  'Necron',
  'Tau', 'Tau Empire',
  // Other major IP
  'Master Chief',
  'Geralt of Rivia',
  'Mario', 'Luigi',
  'Link', 'Zelda',
  'Pikachu',
];

/**
 * Extract trademarked names that appear in the prompt. Case-insensitive
 * substring scan against the seed list. Returns the canonical-cased
 * variants from the seed list (not the user's casing), which the outcome
 * store keys on for stable lookup across prompts.
 *
 * Order matters: longer multi-word names are checked FIRST so "Miles
 * Morales" wins over a bare "Miles" mention. Same for "Peter Parker"
 * vs "Peter".
 */
export function extractTrademarkNames(prompt: string): string[] {
  if (!prompt) return [];
  const lower = prompt.toLowerCase();
  // Sort longest-first so multi-word matches consume their substrings
  // before a single-word seed catches a fragment.
  const ordered = [...TRADEMARK_SEED_NAMES].sort((a, b) => b.length - a.length);
  const found = new Set<string>();
  for (const name of ordered) {
    if (lower.includes(name.toLowerCase())) {
      found.add(name);
    }
  }
  return Array.from(found);
}

/** Exposed for tests + the outcome store's "seed defaults" path. */
export const TRADEMARK_SEED_LIST: readonly string[] = TRADEMARK_SEED_NAMES;
