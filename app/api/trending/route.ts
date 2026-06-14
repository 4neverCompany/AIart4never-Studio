/**
 * POST /api/trending
 *
 * Trending research endpoint for the content pipeline. v1.1.2
 * makes this **camofox-only** — SearXNG and Reddit are removed.
 *
 * Why drop SearXNG + Reddit:
 *   - SearXNG on `localhost:34567` is a dev-only meta-search; on a
 *     typical user machine (no dev setup), it returns zero results
 *     and the pipeline silently fails with "No trending data found".
 *   - Reddit JSON with franchise-targeted subreddits returns a
 *     few hits but is rate-limited and not battle-tested for the
 *     fan-out volume the pipeline wants.
 *   - camofox (anti-bot hardened, fresh index, runs as a Tauri
 *     sidecar on Maurice's machine) is the only reliable source.
 *     It's the one that actually works in production.
 *
 * v1.1.1's camofox-as-tertiary approach didn't go far enough —
 * when SearXNG+Reddit returned nothing, the route surfaced an
 * empty `results` array and the pipeline logged the same error.
 * The user has explicitly asked for camofox-only.
 *
 * The mac camofox macros we use:
 *   - `@google_search` for general web/news context.
 *   - `@reddit_search` for the franchise subreddit chatter that
 *     the old Reddit-JSON path used to provide (we just route
 *     the same per-topic queries through camofox instead of the
 *     raw JSON API; the underlying subreddit list stays the same).
 *
 * Caching: 5 minutes per unique tag/niche/genre combination.
 * Date filter: 30-day cutoff for hits that expose a publishedDate.
 * Dedup: by headline prefix (strips Reddit's `[42↑] ` score
 * bracket so the same title doesn't land twice from different
 * sort orders).
 *
 * V1.1.3-ORCH (2026-06-07) — hybrid client-side fallback:
 *
 *   The Server-Side route is on the Vercel/Web build, where the
 *   Node sidecar runs on `127.0.0.1` but the browser enforces
 *   CORS for cross-origin fetch. If the sidecar doesn't emit CORS
 *   headers (current state of `@askjo/camofox-browser@1.11.2`),
 *   the route falls through to "no results".
 *
 *   As an escape hatch, the frontend (Tauri-WebView OR a browser
 *   with the CORS-proxy workaround) can reach the same sidecar
 *   directly. When the request includes the
 *   `x-client-can-search: true` header (set by
 *   `lib/trending-client.ts` after the frontend has confirmed
 *   `window.__TAURI_INTERNALS__` is set OR a direct fetch probe
 *   succeeds), AND the Server-Side camofox path returns nothing,
 *   we surface a `CLIENT_SEARCH_REQUIRED` envelope containing the
 *   queries the frontend should run, plus the cacheKey. The
 *   frontend then calls `clientSideCamofoxSearch()` per query and
 *   POSTs the merged results back to `/api/trending/results` for
 *   dedup + caching.
 *
 *   This branch is opt-in: without the header, the route behaves
 *   exactly as before (returns the empty/limited results with a
 *   graceful note).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/errors';
import { readDesktopConfigValue } from '@/lib/desktop-env';
import { withCamofoxHealth, camofoxSearch } from '@/lib/camofox';
import { CAMOFOX_MACROS, type CamofoxMacro } from '@/lib/camofox/macros';
import { webSearch, type WebSearchOptions, type WebSearchResult } from '@/lib/web-search';

interface TrendingRequest {
  tags?: string[];
  niches?: string[];
  genres?: string[];
  ideaConcept?: string;
}

interface TrendResult {
  topic: string;
  headline: string;
  source: string;
  url: string;
}

const trendCache = new Map<string, { results: TrendResult[]; timestamp: number; note?: string }>();
const CACHE_TTL = 5 * 60 * 1000;
const WEB_RESULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Franchise → targeted subreddits. Reused from the v1.0.x Reddit-JSON
 * path so the camofox @reddit_search fan-out hits the same subs the
 * user-tuned settings expect.
 */
const FRANCHISE_SUBREDDITS: Record<string, string[]> = {
  'star wars': ['StarWars', 'StarWarsCantina', 'MawInstallation'],
  'marvel': ['MarvelStudios', 'marvelstudiosspoilers', 'comicbooks'],
  'dc': ['DCcomics', 'DC_Cinematic', 'comicbooks'],
  'warhammer': ['Warhammer40k', 'Warhammer', 'ageofsigmar'],
  'anime': ['Anime', 'AnimeArt', 'ImaginaryAnime'],
  'cyberpunk': ['cyberpunkgame', 'cyberpunk'],
  'lord of the rings': ['lotr', 'MiddleEarth'],
  'star trek': ['startrek', 'DaystromInstitute'],
  'doctor who': ['doctorwho', 'gallifrey'],
  'harry potter': ['harrypotter', 'HPMOR'],
  'game of thrones': ['gameofthrones', 'asoiaf'],
  'zelda': ['zelda', 'truezelda'],
  'pokemon': ['pokemon', 'pokemonTCG'],
  'minecraft': ['Minecraft', 'MinecraftBuilds'],
  'destiny': ['DestinyTheGame'],
  'halo': ['halo', 'halostory'],
  'final fantasy': ['FinalFantasy', 'FFXIV'],
  'one piece': ['OnePiece', 'MangaCollectors'],
  'demon slayer': ['KimetsuNoYaiba'],
  'jujutsu kaisen': ['JuJutsuKaisen'],
  'dragon ball': ['dragonball', 'dbz'],
  'transformers': ['transformers'],
  'jurassic park': ['JurassicPark'],
  'alien': ['LV426', 'aliensfranchise'],
  'predator': ['PredatorMovies'],
};

const ART_SUBREDDITS = ['ImaginaryCharacterArt', 'DigitalArt', 'ImaginaryMonsters', 'conceptart'];

/**
 * Parse camofox's `publishedDate` / `pubdate` / `date` field and
 * return a Date or null. camofox normalizes these in 2026 but some
 * upstream pages still send `pubdate: '2 days ago'` or
 * `publishedDate: '2026-05-15T12:34:56Z'`; both should work.
 */
function parseRelativeDate(raw: string | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (!Number.isNaN(t)) return t;
  // Very loose 'N days/hours ago' fallback.
  const m = raw.match(/^(\d+)\s+(day|hour|minute|second)s?\s+ago$/i);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    const ms = unit === 'day' ? n * 86400_000
            : unit === 'hour' ? n * 3600_000
            : unit === 'minute' ? n * 60_000
            : n * 1000;
    return Date.now() - ms;
  }
  return null;
}

/**
 * Resolve a web-search API key. Prefers the value hydrated into
 * `process.env` at server boot (covers the Vercel/web build), then
 * falls back to a live read of the desktop `config.json` so a key the
 * user just pasted in Settings takes effect without a restart.
 */
function resolveSearchKey(name: string): string {
  return (process.env[name] ?? readDesktopConfigValue(name) ?? '').trim();
}

/**
 * Build the web-search provider chain options from configured keys.
 * Serper.dev is the new default backend (V1.6 — M1.4): DDG's
 * HTML-scrape endpoint now bot-blocks automated traffic, so an
 * unkeyed `webSearch` returned nothing — the root of the recurring
 * "No trending data found". With a Serper (or Brave) key the chain
 * Serper → Brave → DDG produces real results again.
 */
function buildSearchOptions(): WebSearchOptions | undefined {
  const serperApiKey = resolveSearchKey('SERPER_API_KEY');
  const braveApiKey = resolveSearchKey('BRAVE_API_KEY');
  const opts: WebSearchOptions = {};
  if (serperApiKey) opts.serperApiKey = serperApiKey;
  if (braveApiKey) opts.braveApiKey = braveApiKey;
  return opts.serperApiKey || opts.braveApiKey ? opts : undefined;
}

/**
 * Map a camofox result to a TrendResult. Skips hits older than
 * 30 days if camofox returned a parseable date.
 */
function toTrendResult(r: WebSearchResult, topic: string): TrendResult | null {
  if (!r.title || !r.url) return null;
  return {
    topic,
    headline: r.title.trim(),
    source: 'camofox',
    url: r.url,
  };
}

/**
 * Fetch a single trending search. camofox is the primary source;
 * V1.5-TRENDING-FALLBACK adds a DDG/Brave `webSearch` backstop so the
 * pipeline still gets results when camofox is down OR up-but-empty.
 *
 * Before v1.5 the camofox-only refactor (v1.1.2) left the server-side
 * fallback as `async () => []`, so a user whose camofox sidecar wasn't
 * running got "No trending data found" on every pipeline run. The
 * fallback to webSearch is exactly what `lib/agent-tools/trending-search`
 * and `app/api/ai/prompt` already use; we mirror it here so the
 * standalone trending route has the same resilience.
 */
async function fetchCamofox(query: string, macro: CamofoxMacro): Promise<TrendResult[]> {
  try {
    // Primary: camofox. withCamofoxHealth returns [] when the sidecar
    // is unreachable; it returns camofox's own (possibly empty) result
    // when the sidecar is up.
    const camofoxResults = await withCamofoxHealth<WebSearchResult[]>(
      () =>
        camofoxSearch({
          userId: 'trending-route',
          sessionKey: `trend-${macro}-${Date.now()}`,
          macro,
          query,
          count: 8,
        }),
      async () => [],
    );
    let results = camofoxResults;
    // Backstop: if camofox produced nothing (down OR up-but-empty),
    // fall through to the Serper → Brave → DDG chain. This is what
    // makes trending work on a machine without a running camofox
    // sidecar. Passing the configured keys is essential — an unkeyed
    // call only reaches DDG, which now bot-blocks (the recurring
    // "No trending data found" bug).
    if (results.length === 0) {
      try {
        results = await webSearch(query, 8, undefined, buildSearchOptions());
      } catch {
        results = [];
      }
    }
    return results
      .map((r) => toTrendResult(r, query))
      .filter((r): r is TrendResult => Boolean(r));
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body: TrendingRequest = await req.json();
    const { tags = [], niches = [], genres = [], ideaConcept = '' } = body;

    const cacheKeyParts = [...tags, ...niches, ...genres].sort();
    if (ideaConcept) cacheKeyParts.push(ideaConcept);
    const cacheKey = cacheKeyParts.join('|');

    // V1.1.3-ORCH: detect the opt-in client-side search header.
    // Frontend sets this when it has confirmed it can reach camofox
    // directly (Tauri-WebView with the `camofox_search` Tauri command
    // wired, or a web build where the CORS-proxy workaround is in
    // place). Without the header, the existing camofox-fallback
    // path runs unchanged.
    const clientCanSearch = req.headers.get('x-client-can-search') === 'true';

    const cached = trendCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return NextResponse.json({
        success: true,
        results: cached.results,
        summary: cached.results.slice(0, 15).map((item) => `- [${item.source}] ${item.headline}`).join('\n'),
        queriesUsed: ['(cached)'],
        note: cached.note,
      });
    }

    const allTopics = [...new Set([...tags, ...niches])];
    const lowerNiches = allTopics.map((n) => n.toLowerCase());
    const currentYear = new Date().getUTCFullYear();

    // Build the targeted sub list per matched franchise. The list
    // is the same one the v1.0.x Reddit-JSON path used; we just
    // route the queries through camofox's @reddit_search macro.
    //
    // FRANCHISE SUBS FIRST: the downstream `slice(0, 3)` in the
    // @reddit_search scoped-query builder is the only place these
    // subs get named in the query string, so the franchise hits
    // (MarvelStudios, StarWars, etc.) MUST land in the first 3
    // entries. ART_SUBREDDITS goes after so they fill any
    // remaining slots in the slice.
    const targetedSubs: string[] = [];
    for (const niche of lowerNiches) {
      for (const [franchise, subs] of Object.entries(FRANCHISE_SUBREDDITS)) {
        if (niche.includes(franchise)) {
          targetedSubs.push(...subs);
        }
      }
    }
    targetedSubs.push(...ART_SUBREDDITS);
    const uniqueSubs = [...new Set(targetedSubs.map((s) => s.trim()).filter(Boolean))].slice(0, 12);

    // Build the per-macro query list.
    //
    // `@google_search` fires for the freshest web/news context.
    // We build a small set of distinct queries: per-niche news +
    // announcement + new-release, plus the user's ideaConcept if
    // they provided one.
    //
    // `@reddit_search` fires with a single combined query per
    // request — the route's other modes (hot/new) don't apply
    // here because camofox's @reddit_search doesn't expose sort
    // granularity the way the raw Reddit JSON API does. The
    // franchise-subreddit scoping happens via the query string
    // (e.g. "marvel star wars crossover site:reddit.com/r/MarvelStudios")
    // — the macro handles the site-restriction for us.
    const googleQueries: string[] = [];
    for (const topic of allTopics.slice(0, 4)) {
      googleQueries.push(`${topic} news ${currentYear}`);
      googleQueries.push(`${topic} announcement`);
      googleQueries.push(`${topic} new release upcoming`);
    }
    if (ideaConcept) {
      const keywords = ideaConcept
        .split(/[\s,;.]+/)
        .filter((w) => w.length > 3 && !['with', 'from', 'that', 'this', 'what', 'where', 'when', 'wielding', 'wearing', 'standing', 'fighting'].includes(w.toLowerCase()))
        .slice(0, 4);
      if (keywords.length > 0) {
        googleQueries.push(`${keywords.join(' ')} fanart 2026`);
      }
    }
    const dedupedGoogle = [...new Set(googleQueries)].slice(0, 6);

    const redditQueryParts = [
      ...lowerNiches.slice(0, 3),
      ideaConcept,
    ].filter((s) => s && s.length > 0);
    const redditQuery = redditQueryParts.join(' ');
    const redditSubs = uniqueSubs.join('+');

    // Dispatch everything in parallel.
    const fetches: Promise<TrendResult[]>[] = [];
    for (const q of dedupedGoogle) {
      fetches.push(fetchCamofox(q, '@google_search'));
    }
    if (redditQuery && CAMOFOX_MACROS.includes('@reddit_search')) {
      // camofox's @reddit_search macro can take a subreddit list via
      // its built-in subreddit-scoping (passed in the query string).
      // We append `site:reddit.com/r/<sub>` per sub to bias results
      // toward the franchise subs the v1.0.x Reddit path used.
      const scopedQuery = `${redditQuery} ${uniqueSubs.slice(0, 3).map((s) => `site:reddit.com/r/${s}`).join(' ')}`;
      fetches.push(fetchCamofox(scopedQuery, '@reddit_search'));
    }

    const allResults: TrendResult[] = [];
    const settled = await Promise.allSettled(fetches);
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        allResults.push(...result.value);
      }
    }

    // Dedup by headline prefix (strips Reddit's score bracket so
    // the same title doesn't land twice from different sources).
    const seen = new Set<string>();
    const unique: TrendResult[] = [];
    for (const item of allResults) {
      const key = item.headline
        .toLowerCase()
        .replace(/^\[\d+↑\]\s*/, '')
        .slice(0, 60);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(item);
      }
    }

    // V1.1.3-ORCH: hybrid client-side fallback branch. If the
    // Server-Side camofox path returned nothing (the sidecar
    // was unreachable from inside the Node sidecar — typically
    // CORS on the Vercel-Web build) AND the request opted in
    // via `x-client-can-search: true`, surface a
    // `CLIENT_SEARCH_REQUIRED` envelope instead of an empty
    // result. The frontend orchestrator
    // (`lib/trending-client.ts`) will then run the same
    // queries through `clientSideCamofoxSearch()` and POST the
    // results back to `/api/trending/results` for dedup +
    // caching.
    //
    // The queries we ship are the same ones we would have run
    // Server-Side — the frontend doesn't need to rebuild them.
    if (unique.length === 0 && clientCanSearch) {
      // Build the query list the client should run. We
      // deliberately reuse `dedupedGoogle` and the scoped
      // redditQuery so the work the frontend does is a
      // mirror of what we'd do Server-Side.
      const clientQueries: string[] = [...dedupedGoogle];
      if (redditQuery && CAMOFOX_MACROS.includes('@reddit_search')) {
        const scopedQuery = `${redditQuery} ${uniqueSubs
          .slice(0, 3)
          .map((s) => `site:reddit.com/r/${s}`)
          .join(' ')}`;
        clientQueries.push(scopedQuery);
      }
      return NextResponse.json({
        success: true,
        results: [],
        summary: '',
        note: 'CLIENT_SEARCH_REQUIRED',
        queries: clientQueries,
        cacheKey,
      });
    }

    const note = unique.length < 3
      ? 'Limited trending data — consider broader niches'
      : undefined;

    const topResults = unique.slice(0, 15);
    const summary = topResults
      .map((item) => `- [${item.source}] ${item.headline}`)
      .join('\n');

    trendCache.set(cacheKey, { results: topResults, timestamp: Date.now(), note });

    if (trendCache.size > 50) {
      const now = Date.now();
      for (const [key, entry] of trendCache) {
        if (now - entry.timestamp > CACHE_TTL) trendCache.delete(key);
      }
    }

    return NextResponse.json({
      success: true,
      results: topResults,
      summary,
      queriesUsed: {
        google: dedupedGoogle,
        reddit: redditQuery ? [redditQuery] : [],
        redditSubs,
      },
      note,
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { success: false, error: getErrorMessage(e), results: [], summary: '' },
      { status: 500 },
    );
  }
}
