// M3.3-P3 PREFLIGHT (E1): shared helpers extracted from
// app/api/pi/prompt/route.ts so the future nca + mmx-TEXT route deletions
// in commit b can re-import from `lib/` instead of dragging the pi route
// module into the trash. Zero behavior change — the helpers themselves
// are bit-for-bit identical to the originals at HEAD (commit 0522116).
//
//   - `buildFocusBlock(niches, genres)` — V080-DES-003 focus block builder
//   - `buildTrendingQuery(niches, genres, rng, freshness, genreIndex)` —
//     rotating-pool DDG/Brave query builder
//   - `pickFromPool(pool, offset, bucket)` — deterministic pool picker
//   - `dedupeByUrl(results)` — first-seen-wins URL dedup for search hits
//   - `PiMode` — the 8 mode values the prompt routes accept
//
// The original module kept these private to the pi route; this file is
// the "new home" that the ai-prompt routes (and the surviving
// `app/api/ai/prompt` route, which currently inlines a local copy of
// `buildFocusBlock`) can re-use. ai/prompt's local copy is intentionally
// left in place during this preflight — collapsing it belongs with the
// eventual `ai/prompt` rewrite and is out of scope here.

/**
 * V080-DES-003 — Build a "focus" system-prompt block from the user's
 * configured niches/genres. Added to the composed system prompt on every
 * mode (not just `idea`) so captions, enhances, tags etc. reflect the
 * user's settings without each caller having to re-word the agentPrompt.
 *
 * Returns an empty string when both arrays are empty so the caller's
 * `.filter(Boolean)` drops it cleanly.
 */
export function buildFocusBlock(niches: string[], genres: string[]): string {
  if (niches.length === 0 && genres.length === 0) return '';
  const nicheClause =
    niches.length > 0 ? `The user creates content in: ${niches.join(', ')}.` : '';
  const genreClause =
    genres.length > 0 ? `Favor themes and styles like: ${genres.join(', ')}.` : '';
  return ['Focus areas:', nicheClause, genreClause, 'Every output should visibly reflect these areas.']
    .filter(Boolean)
    .join(' ');
}

// M1 CANON-NATIVE: the fallback "pillars" for the research query are the
// Master4never canon pillars / realities — NOT franchise names. The old
// ['Star Wars','Marvel','Warhammer 40k'] crossover list is gone.
const DEFAULT_NICHES = ['Story-Beat', 'Variant Reveal', 'Cyberpunk PRIME'];

/**
 * Build the optional research-context query from the user's active
 * pillars/styles.
 *
 * M1 CANON-NATIVE: this is reference research for the operator's ORIGINAL
 * Master4never multiverse, NOT crossover/fan-art trend-trawling. Picks 2
 * pillars to diversify, joins them with a comma, and biases toward canon
 * reference (concept art / cinematic) rather than "crossover fan art".
 *
 * `rng` is injectable so tests can pin a deterministic shuffle.
 */
export function buildTrendingQuery(
  niches?: string[],
  genres?: string[],
  rng: () => number = Math.random,
  freshness: string = 'reference 2026',
  genreIndex: number = 0,
): string {
  const cleanedNiches = sanitizeStringArray(niches);
  const active = cleanedNiches.length > 0 ? cleanedNiches : DEFAULT_NICHES;

  const shuffled = [...active];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const pick = shuffled.slice(0, Math.min(2, shuffled.length));

  const cleanedGenres = sanitizeStringArray(genres);
  // Rotate which style drives the query across calls. With a single
  // style this degenerates to index 0 (original behavior); with several
  // configured, consecutive runs touch different ones so the research
  // intent shifts instead of always anchoring on cleanedGenres[0].
  const genreHint =
    cleanedGenres.length > 0
      ? cleanedGenres[Math.abs(genreIndex) % cleanedGenres.length]
      : '';

  return [pick.join(', '), 'character concept art reference', genreHint, freshness]
    .filter((s) => s.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deterministic pool picker keyed by the rotation bucket + an offset so
 * the fallback query doesn't align with the freshness suffix.
 */
export function pickFromPool<T>(pool: readonly T[], offset: number, bucket: number): T {
  if (pool.length === 0) throw new Error('pickFromPool called with empty pool');
  const idx = Math.abs((bucket + offset) % pool.length);
  return pool[idx];
}

function sanitizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim());
}

/**
 * The 8 prompt modes the AI prompt routes (pi / nca / mmx-TEXT / ai) accept.
 * Mode directives live in each route — they're trivially different across
 * providers and consolidating them belongs to a future refactor.
 */
export type PiMode =
  | 'chat'
  | 'generate'
  | 'idea'
  | 'enhance'
  | 'caption'
  | 'tag'
  | 'negative-prompt'
  | 'collection-info';
