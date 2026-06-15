/**
 * 4NE-16 — Web-research module types.
 *
 * The SENSE-step research source: niche/trend suggestions that feed the weekly
 * plan. Replaces MashupForge's broken homegrown web-search with a reliable
 * MCP-connector dispatch (Exa primary + Tavily fallback). These types are the
 * shared vocabulary across `providers.ts` (pure mapping) and `research.ts`
 * (the live, fallback-aware dispatcher).
 */

/** Which web-search provider produced a suggestion / served a query. */
export type ResearchProvider = 'exa' | 'tavily';

/**
 * One niche/trend suggestion, normalised across providers. `source` records
 * which provider it came from; `score` / `publishedAt` / `url` are best-effort
 * (providers don't all supply them). `summary` is a short text blurb (the
 * snippet / text / content the provider returned), possibly empty.
 */
export interface NicheSuggestion {
  title: string;
  summary: string;
  url?: string;
  source: ResearchProvider;
  score?: number;
  /** ISO-8601 (or whatever the provider returned), passed through untouched. */
  publishedAt?: string;
}

/** A research request. `maxResults` / `recencyDays` are advisory hints. */
export interface ResearchQuery {
  query: string;
  maxResults?: number;
  recencyDays?: number;
}

/**
 * The result of a research run.
 *   - `suggestions` — the mapped niche suggestions (possibly empty).
 *   - `usedProvider` — which provider actually produced the returned
 *     suggestions, or `null` if none did.
 *   - `degraded` — `true` when we did NOT serve from the primary (Exa) on its
 *     first try: a fallback to Tavily, or a total failure, both count as
 *     degraded. The caller can surface this in the plan ("research degraded").
 *   - `notes` — human-readable breadcrumbs (e.g. why Exa was skipped / failed
 *     and that Tavily served instead). Never throws — research failure must not
 *     crash a run, so failures land here as notes + `usedProvider:null`.
 */
export interface ResearchOutcome {
  suggestions: NicheSuggestion[];
  usedProvider: ResearchProvider | null;
  degraded: boolean;
  notes: string[];
}
