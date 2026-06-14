/**
 * CAMOFOX-CAMOUFOX-1.1.0 (2026-06-06): camofox-browser macro list.
 *
 * Source of truth: `@askjo/camofox-browser@1.11.2` macro list
 * (see docs/camofox-api-research.md §"Search-Macros"). 14 macros
 * total; 13 HTML-snapshot macros + 1 JSON macro (`@reddit_search`).
 *
 * `@pinterest_search` is missing upstream — see R9 in the master
 * plan and the Q9/Q11 "out of scope" decision. Workaround (manual
 * `navigate` to a Pinterest search URL) is NOT implemented in
 * v1.1.0; tracked for a future release.
 */

export const CAMOFOX_MACROS = [
  '@google_search',
  '@youtube_search',
  '@amazon_search',
  '@reddit_search',
  '@reddit_subreddit',
  '@wikipedia_search',
  '@twitter_search',
  '@yelp_search',
  '@spotify_search',
  '@netflix_search',
  '@linkedin_search',
  '@instagram_search',
  '@tiktok_search',
  '@twitch_search',
] as const;

export type CamofoxMacro = (typeof CAMOFOX_MACROS)[number];

/**
 * Default port for the camofox sidecar. The Rust side (`lib.rs`)
 * uses the same constant; the two MUST stay in sync. If Hermes
 * agent (per Maurice Q3) is using 9377 already, the Rust side
 * finds that via the 3-stage port discovery and reuses the
 * existing instance.
 */
export const CAMOFOX_DEFAULT_PORT = 9377;

/**
 * Convenience check: does the macro return JSON directly? If yes,
 * the client skips the `/links` step and parses the snapshot body
 * as JSON. The only JSON-returning macro in v1.11.2 is
 * `@reddit_search` (Reddit exposes a `.json` variant of its search
 * endpoint that the macro navigates to).
 */
export const JSON_RETURNING_MACROS: ReadonlySet<CamofoxMacro> = new Set([
  '@reddit_search',
  '@reddit_subreddit',
]);

/**
 * URL builder for manual `navigate` calls (used as a workaround
 * when a macro is missing — e.g. Pinterest). The camofox REST
 * API takes a `url` field on `/tabs/:id/navigate` instead of
 * `macro+query`. We build that URL here.
 *
 * Not used in v1.1.0 (we don't have any manual-navigate
 * call-sites), but the helper exists for future Pinterest-style
 * fallback work.
 */
export function buildManualSearchUrl(site: 'pinterest', query: string): string {
  const q = encodeURIComponent(query);
  switch (site) {
    case 'pinterest':
      return `https://www.pinterest.com/search/pins/?q=${q}`;
  }
}
