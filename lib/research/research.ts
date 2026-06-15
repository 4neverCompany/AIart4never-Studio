/**
 * 4NE-16 — Reliable web-research dispatcher (Exa primary + Tavily fallback).
 *
 * The SENSE step's research source: it produces niche/trend suggestions that
 * feed into the weekly plan. This REPLACES the legacy broken homegrown
 * web-search — instead of scraping ourselves, we dispatch through the operator's
 * Exa (primary) / Tavily (fallback) MCP connectors, exactly like `lib/publish`
 * and `lib/analytics` dispatch their connectors: resolve the tool slug, connect
 * via the INJECTED `connect`, call ONE search tool, map the result with the PURE
 * provider mapper, and ALWAYS close the client.
 *
 * Fallback decision tree (research must NEVER throw — a failed sense step can't
 * crash a run):
 *   1. Exa configured?
 *        - connect → call EXA_SEARCH_TOOL → map.
 *        - non-empty results → return { usedProvider:'exa', degraded:false }.
 *        - threw OR empty → record a note, fall through to Tavily.
 *        - ALWAYS close the Exa client.
 *   2. Tavily configured (reached only on Exa error/empty, OR when Exa wasn't
 *      configured at all)?
 *        - connect → call TAVILY_SEARCH_TOOL → map.
 *        - non-empty results → return { usedProvider:'tavily', degraded:true,
 *          notes:['exa <reason>; used tavily fallback'] }. (Degraded because we
 *          did not serve from the primary on its first try; if Exa was never
 *          configured the note records that instead.)
 *        - threw OR empty → record a note, fall through.
 *        - ALWAYS close the Tavily client.
 *   3. Neither produced suggestions → { suggestions:[], usedProvider:null,
 *      degraded:true, notes:[...] }.
 *
 * What needs the LIVE connection vs. what's unit-tested:
 *   - `researchNiches` is the impure piece: a real run needs the operator's Exa
 *     (primary) and/or Tavily (fallback) MCP connector configured + trusted in
 *     the registry. Its dispatch + fallback logic is exercised in tests with an
 *     INJECTED fake `connect` (no network).
 *   - `mapExaResult` / `mapTavilyResult` (in `providers.ts`) are PURE and are
 *     fixture-tested directly.
 */

import type { McpServerConfig } from '@/lib/mcp';
import { callMcpTool, connectMcp, getServer } from '@/lib/mcp';
import { getErrorMessage } from '@/lib/errors';
import {
  EXA_SEARCH_TOOL,
  TAVILY_SEARCH_TOOL,
  mapExaResult,
  mapTavilyResult,
} from './providers';
import type { NicheSuggestion, ResearchOutcome, ResearchProvider, ResearchQuery } from './types';

/** Default number of results to request when the query doesn't specify one. */
const DEFAULT_MAX_RESULTS = 8;

/**
 * Dependencies injected into {@link researchNiches}.
 *   - `exaConnectorId` / `tavilyConnectorId` — registry ids of the operator's
 *     connectors. Omit either to disable that provider for this run.
 *   - `connect` — the MCP connect function (real {@link connectMcp} in prod,
 *     a fake in tests).
 *   - `callTool` — the tool-call function; defaults to {@link callMcpTool},
 *     overridable in tests.
 *   - `getConnector` — connector-config resolver; defaults to the registry's
 *     `getServer`, injected so tests don't need a populated registry.
 *   - `exaSearchTool` / `tavilySearchTool` — override the tool slug after
 *     resolving it from the connector's advertised tool list at runtime.
 */
export interface ResearchDeps {
  exaConnectorId?: string;
  tavilyConnectorId?: string;
  connect: typeof connectMcp;
  callTool?: typeof callMcpTool;
  getConnector?: (id: string) => Promise<McpServerConfig | undefined> | McpServerConfig | undefined;
  exaSearchTool?: string;
  tavilySearchTool?: string;
}

/**
 * Build the per-provider search arguments. Both Exa and Tavily accept a `query`
 * plus a result-count cap; we also thread the recency hint through under both
 * providers' common spellings. Extra keys are harmless — connectors ignore what
 * they don't recognise.
 */
function buildSearchArgs(query: ResearchQuery): Record<string, unknown> {
  const num = query.maxResults && query.maxResults > 0 ? query.maxResults : DEFAULT_MAX_RESULTS;
  const args: Record<string, unknown> = {
    query: query.query,
    // Exa uses `numResults`; Tavily uses `max_results`. Send both.
    numResults: num,
    max_results: num,
  };
  if (query.recencyDays && query.recencyDays > 0) {
    // Tavily takes `days`; Exa supports a startPublishedDate. Provide both hints.
    args.days = query.recencyDays;
    args.startPublishedDate = new Date(Date.now() - query.recencyDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
  }
  return args;
}

/**
 * Run ONE provider: resolve config → connect → call its search tool → map.
 * Returns the mapped suggestions (possibly empty). ALWAYS closes the client.
 * Throws on a connect/tool/config failure — the caller turns that into a note
 * and decides whether to fall through.
 */
async function runProvider(
  provider: ResearchProvider,
  connectorId: string,
  tool: string,
  args: Record<string, unknown>,
  resolveConnector: NonNullable<ResearchDeps['getConnector']>,
  connect: typeof connectMcp,
  callTool: typeof callMcpTool,
): Promise<NicheSuggestion[]> {
  const cfg = await resolveConnector(connectorId);
  if (!cfg) {
    throw new Error(`unknown ${provider} connector "${connectorId}"`);
  }

  const connection = await connect(cfg);
  try {
    const raw = await callTool(connection.client, tool, args);
    return provider === 'exa' ? mapExaResult(raw) : mapTavilyResult(raw);
  } finally {
    // ALWAYS close — a failed close must not mask a result/error.
    try {
      await connection.close();
    } catch {
      /* ignore close error */
    }
  }
}

/**
 * Research niche/trend suggestions via the operator's Exa (primary) / Tavily
 * (fallback) MCP connectors. See the module docstring for the full fallback
 * decision tree. NEVER throws: every failure is captured into `notes` and
 * surfaced as `{ usedProvider:null, degraded:true }`.
 */
export async function researchNiches(
  query: ResearchQuery,
  deps: ResearchDeps,
): Promise<ResearchOutcome> {
  const resolveConnector = deps.getConnector ?? getServer;
  const callTool = deps.callTool ?? callMcpTool;
  const args = buildSearchArgs(query);
  const notes: string[] = [];

  // 1. PRIMARY — Exa.
  if (deps.exaConnectorId) {
    try {
      const suggestions = await runProvider(
        'exa',
        deps.exaConnectorId,
        deps.exaSearchTool ?? EXA_SEARCH_TOOL,
        args,
        resolveConnector,
        deps.connect,
        callTool,
      );
      if (suggestions.length > 0) {
        return { suggestions, usedProvider: 'exa', degraded: false, notes };
      }
      notes.push('exa returned no results');
    } catch (e) {
      notes.push(`exa failed: ${getErrorMessage(e)}`);
    }
  } else {
    notes.push('exa connector not configured');
  }

  // 2. FALLBACK — Tavily. Reached when Exa errored, returned empty, or was
  //    never configured. Serving from here is always `degraded` (we did not
  //    serve from the primary on its first try).
  if (deps.tavilyConnectorId) {
    try {
      const suggestions = await runProvider(
        'tavily',
        deps.tavilyConnectorId,
        deps.tavilySearchTool ?? TAVILY_SEARCH_TOOL,
        args,
        resolveConnector,
        deps.connect,
        callTool,
      );
      if (suggestions.length > 0) {
        return {
          suggestions,
          usedProvider: 'tavily',
          degraded: true,
          notes: [`${notes.join('; ') || 'exa unavailable'}; used tavily fallback`],
        };
      }
      notes.push('tavily returned no results');
    } catch (e) {
      notes.push(`tavily failed: ${getErrorMessage(e)}`);
    }
  } else {
    notes.push('tavily connector not configured');
  }

  // 3. Neither produced suggestions.
  return { suggestions: [], usedProvider: null, degraded: true, notes };
}
