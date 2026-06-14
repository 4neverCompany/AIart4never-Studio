/**
 * Context-aware negative-prompt helper.
 *
 * The LLM generates a primary negative prompt per-item, but that prompt is
 * generic ("blurry, low quality, deformed"). This helper supplies a
 * fallback / baseline negative prompt built from the user's active
 * genres/niches so every generation gets a sensible set of "do-nots"
 * tuned to the kind of art being produced.
 *
 * Usage: pass the result as `options.negativePrompt` into
 * generateComparison / rerollImage. The per-model `enhancePromptForModel`
 * call will treat it as a starting point and may refine it further.
 */

/** Always-on technical-quality negatives. Applied regardless of genre. */
const BASE_NEGATIVES = [
  'blurry',
  'low quality',
  'low resolution',
  'deformed',
  'disfigured',
  'watermark',
  'signature',
  'text',
  'jpeg artifacts',
  // TRADEMARK-SELF-HEAL (2026-05-21): defense in depth alongside the
  // classification-aware retry rewrite in buildModerationRewriteInstruction.
  // Negative prompts don't catch everything (Leonardo's moderation runs
  // on the positive prompt, not these), but they nudge the upstream
  // prompt-enhance step to favour generic descriptors over named IP.
  'trademarked character names',
  'copyrighted franchise IP',
  'specific named characters',
];

/**
 * Genre-keyed additions. Matched case-insensitively against substrings
 * of each active genre so casual names still trigger the right bucket
 * (e.g. "Grimdark 40k" → dark bucket; "Fantasy Landscapes" → landscape).
 */
const GENRE_ADDITIONS: Array<{ match: RegExp; negatives: string[] }> = [
  {
    // Character / portrait art — hands and anatomy are the usual failure modes.
    match: /character|portrait|hero|villain|warrior|mashup|crossover/i,
    negatives: [
      'bad anatomy',
      'wrong proportions',
      'extra fingers',
      'mutated hands',
      'asymmetric eyes',
    ],
  },
  {
    // Landscape / environment — exposure and stray UI elements dominate.
    match: /landscape|environment|scenery|vista|nature|city|architect/i,
    negatives: [
      'overexposed',
      'washed out',
      'lens flare',
      'crooked horizon',
    ],
  },
  {
    // Action / combat — static poses and flat lighting kill the energy.
    match: /action|combat|battle|fight|dynamic|motion/i,
    negatives: [
      'motion blur',
      'static pose',
      'flat lighting',
      'frozen limbs',
    ],
  },
  {
    // Dark / grimdark / horror — cartoon styling flattens the mood.
    match: /dark|grimdark|horror|gothic|noir|cyberpunk/i,
    negatives: [
      'bright colors',
      'cartoon style',
      'flat shading',
      'cheerful lighting',
    ],
  },
  {
    // Sci-fi — anachronistic medieval elements break the aesthetic.
    match: /sci-?fi|space|futuristic|cyber/i,
    negatives: ['medieval elements', 'rustic textures'],
  },
  {
    // Fantasy — modern intrusions break immersion.
    match: /fantasy|medieval|mythic|magic/i,
    negatives: ['modern clothing', 'contemporary vehicles', 'electronics'],
  },
];

/**
 * Build a context-aware negative prompt from the user's selected
 * genres/niches. Deduplicates, trims, and returns a single
 * comma-separated string (Leonardo's expected format).
 *
 * Returns an empty string if no context is available AND no base
 * set should be returned — callers typically prefer the base set,
 * so this always returns at least the base negatives.
 */
export function generateNegativePrompt(
  genres: readonly string[] = [],
  niches: readonly string[] = [],
): string {
  const context = [...genres, ...niches].filter(Boolean);
  const additions = new Set<string>();

  for (const tag of context) {
    for (const bucket of GENRE_ADDITIONS) {
      if (bucket.match.test(tag)) {
        for (const n of bucket.negatives) additions.add(n);
      }
    }
  }

  const combined = [...BASE_NEGATIVES, ...additions];
  // Deduplicate case-insensitively while preserving first-seen casing.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const item of combined) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped.join(', ');
}
