/**
 * v1.2 Tool Registry — `trending_search` tool.
 *
 * Wraps the existing `lib/camofox` client (sidecar preferred) with a
 * web-search fallback, exposes a single `tool()` definition for the
 * Vercel AI SDK agent loop.
 *
 * Why this lives in `lib/agent-tools/` and not in `lib/camofox/`:
 * the `agent-tools` layer is the *typed* surface the AI SDK consumes
 * — it owns the Zod schema, the `tool()` wrapper, and the Result
 * shaping. `lib/camofox/` stays a low-level sidecar client that
 * nothing else in the agent loop has to know about.
 *
 * Interface (per task brief):
 *   { niches, ideaConcept } → TrendResult[]
 *
 * The output schema (TrendingSearchOutput) is slightly richer than
 * the brief — it includes `servedBy` so the route can render the
 * source-attribution badge correctly. The `results` field is the
 * pure TrendResult[] the brief asks for.
 */
import { tool } from 'ai';
import {
  TrendingSearchInput,
  TrendingSearchOutput,
  zTrendingSearchInput,
  zTrendingSearchOutput,
  type TrendResult,
} from './schemas';
import { ToolExecutionError, safeExecute, type ToolResult } from './errors';
// Static import for @/lib/camofox so vi.mock in tests reliably
// intercepts the calls. (vi.mock factory is hoisted, but a
// `await import('@/lib/camofox')` inside `loadCamofox` was racing
// the mock setup under parallel `Promise.allSettled` calls — using
// a top-level import lets vitest's module resolver route the
// SUT through the mock deterministically.)
import * as camofoxModule from '@/lib/camofox';
import * as webSearchModule from '@/lib/web-search';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Pick the camofox macro for a niche. v1.1.0 ships 14 macros; we
 * bias toward Google's general web search and the macro that best
 * fits the niche vibe. This is intentionally simple — the Director
 * loop calls `trending_search` with up to 6 niches in one call, so
 * a single macro is fine. v1.2.4 will make this per-niche.
 */
function pickMacroForNiche(_niche: string): '@google_search' {
  return '@google_search';
}

/**
 * Build the web-search provider chain from env-configured keys. Runs
 * server-side (the Director loop), where `lib/desktop-env` has already
 * hydrated config.json keys into `process.env`. Serper.dev is the new
 * default backend (V1.6 — M1.4); without a key the chain falls to DDG,
 * which now bot-blocks — hence the recurring empty trending results.
 */
function buildAgentSearchOptions(): webSearchModule.WebSearchOptions | undefined {
  const serperApiKey = (process.env.SERPER_API_KEY ?? '').trim();
  const braveApiKey = (process.env.BRAVE_API_KEY ?? '').trim();
  const opts: webSearchModule.WebSearchOptions = {};
  if (serperApiKey) opts.serperApiKey = serperApiKey;
  if (braveApiKey) opts.braveApiKey = braveApiKey;
  return opts.serperApiKey || opts.braveApiKey ? opts : undefined;
}

/**
 * Run a single niche through camofox-or-fallback, mapping the
 * raw `WebSearchResult` rows to `TrendResult` rows with the niche
 * tag attached. The `count` argument caps how many rows we return
 * PER niche — the agent's effective budget is `count * niches.length`.
 */
async function searchNiche(opts: {
  niche: string;
  ideaConcept: string | undefined;
  count: number;
  signal: AbortSignal | undefined;
}): Promise<TrendResult[]> {
  const { niche, ideaConcept, count, signal } = opts;
  const query = ideaConcept ? `${ideaConcept} ${niche}` : niche;
  const macro = pickMacroForNiche(niche);

  const sessionKey = `agent-tools:trending_search:${niche}:${Date.now()}`;

  const rows = await camofoxModule.withCamofoxHealth(
    () =>
      camofoxModule.camofoxSearch({
        userId: 'agent-tools',
        sessionKey,
        macro,
        query,
        count,
        ...(signal ? { signal } : {}),
      }),
    () => webSearchModule.webSearch(query, count, signal, buildAgentSearchOptions()),
  );

  return rows.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet ?? '',
    niche,
    source: macro,
  }));
}

/**
 * Pure helper: was the result set served by camofox or by the
 * web-search fallback? We don't have a direct signal from the
 * wrappers, so we infer it from the absence of `CamofoxUnavailableError`
 * (a successful camofox call doesn't throw, the fallback does).
 *
 * For tool output the caller doesn't actually need this — `results`
 * has the data; `servedBy` is metadata. Exposed for testability.
 */
async function detectServedBy(): Promise<'camofox' | 'web-search'> {
  try {
    // If withCamofoxHealth returns the camofox path (the primary
    // closure) without throwing, servedBy is 'camofox'. We can
    // detect this by probing status: withCamofoxHealth itself
    // pre-checks `camofoxStatus`, so any successful primary
    // resolution means camofox was reachable.
    const result = await camofoxModule.withCamofoxHealth(
      async () => 'camofox' as const,
      async () => 'web-search' as const,
    );
    return result;
  } catch {
    return 'web-search';
  }
}

// ---------------------------------------------------------------------------
// Public API: typed execute() for non-SDK callers (tests, route handlers)
// ---------------------------------------------------------------------------

/**
 * Execute the `trending_search` tool's logic without the AI SDK
 * wrapper. Useful for unit tests and for any non-agent call site
 * that wants the same shape (the /api/trending route, for one).
 *
 * @returns a `ToolResult<TrendingSearchOutput>` — never throws.
 *   Validation failures become ValidationError, provider failures
 *   become ToolExecutionError, etc.
 */
export async function executeTrendingSearch(
  rawInput: unknown,
  opts: { signal?: AbortSignal; userId?: string } = {},
): Promise<ToolResult<TrendingSearchOutput>> {
  return safeExecute(async () => {
    // Schema validation. The AI SDK normally does this before
    // calling execute(), but direct callers (tests, the legacy
    // /api/trending route) skip the SDK, so we validate here.
    const parsed = zTrendingSearchInput.safeParse(rawInput);
    if (!parsed.success) {
      // Re-throw as ZodError so safeExecute converts to ValidationError.
      throw parsed.error;
    }
    const input = parsed.data;
    const signal = opts.signal;

    if (input.niches.length === 0) {
      throw new ToolExecutionError('trending_search', 'no niches supplied', {
        retryable: false,
      });
    }

    // Per-niche search, in parallel — the Director loop is the
    // bottleneck, not us.
    const perNiche = await Promise.allSettled(
      input.niches.map((niche) =>
        searchNiche({ niche, ideaConcept: input.ideaConcept, count: input.count, signal }),
      ),
    );

    const allRows: TrendResult[] = [];
    const nichesWithHits: string[] = [];
    for (let i = 0; i < perNiche.length; i++) {
      const settled = perNiche[i];
      if (!settled) continue;
      if (settled.status === 'fulfilled') {
        if (settled.value.length > 0) {
          nichesWithHits.push(input.niches[i]!);
          allRows.push(...settled.value);
        }
      } else {
        // One niche failing shouldn't kill the whole tool — log
        // through the cause chain and continue. The Director loop
        // gets the partial result and can decide whether to retry.
        const reason = settled.reason instanceof Error
          ? settled.reason.message
          : String(settled.reason);
        throw new ToolExecutionError(
          'trending_search',
          `niche "${input.niches[i]}" search failed: ${reason}`,
          { retryable: true, cause: settled.reason },
        );
      }
    }

    // Dedup by URL — overlapping niches can return the same row
    // (e.g. "Mythic Legends" and "Sci-Fi & Fantasy" might both
    // surface the same Warhammer 40k post).
    const seen = new Set<string>();
    const deduped: TrendResult[] = [];
    for (const row of allRows) {
      if (seen.has(row.url)) continue;
      seen.add(row.url);
      deduped.push(row);
    }

    const servedBy = await detectServedBy();

    const output = zTrendingSearchOutput.parse({
      results: deduped,
      nichesWithHits,
      servedBy,
    });
    return output;
  });
}

// ---------------------------------------------------------------------------
// Vercel AI SDK `tool()` definition
// ---------------------------------------------------------------------------

/**
 * The `trending_search` tool, ready to drop into a Vercel AI SDK
 * `generateText({ tools: { trending_search, ... } })` call.
 *
 * The AI SDK wires the Zod schema into the model's tool-call
 * payload AND validates the model's output before invoking
 * `execute()`. We re-validate in `executeTrendingSearch` for the
 * non-SDK call path; both paths funnel into the same logic.
 */
export const trendingSearchTool = tool({
  description:
    "Search the web (via the camofox sidecar, falling back to web-search) for what's currently trending in one or more user-selected content pillars. Returns a deduped set of titles + URLs that the Director can use to flavour the next prompt draft.",
  inputSchema: zTrendingSearchInput,
  outputSchema: zTrendingSearchOutput,
  execute: async (input, options) => {
    const result = await executeTrendingSearch(input, {
      signal: options?.abortSignal,
    });
    if (!result.ok) {
      // Surface typed errors to the model as tool-result errors.
      // The AI SDK re-raises this on the route layer, where the
      // `app/api/ai/prompt/route.ts` error handler catches and
      // emits the SSE error event.
      throw result.error;
    }
    return result.value;
  },
});

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { zTrendingSearchInput, zTrendingSearchOutput, type TrendResult } from './schemas';

// Internal helpers exposed only for testability — not part of the
// public surface (no barrel re-export from index.ts).
export const __test__ = { pickMacroForNiche };
