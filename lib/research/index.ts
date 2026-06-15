/**
 * 4NE-16 — Web-research module: public surface.
 *
 * The SENSE-step research source that replaces MashupForge's broken homegrown
 * web-search. `providers.ts` is PURE (tool slugs + defensive result mappers);
 * `research.ts` is the live, fallback-aware dispatcher (Exa primary + Tavily
 * fallback) that runs through `lib/mcp` like `lib/publish` / `lib/analytics`.
 * Import from `@/lib/research` rather than the individual files.
 */

export type {
  ResearchProvider,
  NicheSuggestion,
  ResearchQuery,
  ResearchOutcome,
} from './types';

export {
  EXA_SEARCH_TOOL,
  EXA_FETCH_TOOL,
  TAVILY_SEARCH_TOOL,
  mapExaResult,
  mapTavilyResult,
} from './providers';

export { researchNiches } from './research';
export type { ResearchDeps } from './research';
