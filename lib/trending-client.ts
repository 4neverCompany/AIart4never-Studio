/**
 * V1.1.3-ORCH (2026-06-07): Frontend orchestrator for the hybrid
 * trending path.
 *
 *  1. POST `/api/trending` with the user's tag/niche/genre payload
 *     + an `x-client-can-search: true` header (we set it because
 *     this orchestrator is the one that knows whether the
 *     frontend can run the search itself).
 *  2. If the route returns a `CLIENT_SEARCH_REQUIRED` envelope
 *     (Server-Side camofox unreachable), we run each query
 *     through `clientSideCamofoxSearch()` in parallel and POST
 *     the merged results back to `/api/trending/results`.
 *  3. Return the deduped + cached final results.
 *
 *  If the route returns normal results (Server-Side camofox
 *  worked), we forward them as-is. If everything fails (route
 *  unreachable, no camofox client, etc.) we return an empty
 *  shape — never throw.
 */
import { clientSideCamofoxSearch } from '@/lib/camofox-client';
import type { WebSearchResult } from '@/lib/web-search';

export interface TrendingClientRequest {
  tags?: string[];
  niches?: string[];
  genres?: string[];
  ideaConcept?: string;
}

export interface TrendResult {
  topic: string;
  headline: string;
  source: string;
  url: string;
}

export interface TrendingClientResponse {
  success: boolean;
  results: TrendResult[];
  summary: string;
  note?: string;
  /** True if we had to run camofox client-side because the
   *  Server-Side path returned CLIENT_SEARCH_REQUIRED. Useful
   *  for observability. */
  hybridTriggered?: boolean;
  /** Underlying error message, when the whole call failed. */
  error?: string;
}

const DEFAULT_COUNT = 8;
const MAX_RESULTS = 15;

/**
 * Detect whether the WebView is running in a Tauri shell, or
 * whether we have evidence the Web build can reach camofox
 * directly. The check is intentionally lightweight: probing
 * the sidecar happens lazily inside `clientSideCamofoxSearch`,
 * not up-front (an up-front probe would add 4×timeoutMs to
 * every trending call, which is exactly what we want to avoid
 * for the common case where Server-Side works).
 */
function frontendCanSearch(): boolean {
  if (typeof window === 'undefined') return false;
  // Tauri 2 sets `__TAURI_INTERNALS__` on the window in the
  // WebView context. The Tauri build can ALWAYS call
  // `invoke('camofox_search', ...)` directly.
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (w.__TAURI_INTERNALS__) return true;
  // Web build: we don't try to detect a sidecar pre-emptively.
  // The orchestrator sets the header unconditionally; the route
  // falls back to CLIENT_SEARCH_REQUIRED only if the Server-Side
  // path actually returned nothing, so the worst case for a
  // Web build without a sidecar is one wasted setHeader call.
  return true;
}

/**
 * Post a JSON body to an internal API route. Uses `fetch` so it
 * works in both the Tauri WebView and the Vercel-Web build.
 * Returns null on any transport failure — the caller treats
 * null as "fall back to empty result".
 */
async function postJson<TReq, TRes>(
  path: string,
  body: TReq,
  init: RequestInit = {},
): Promise<TRes | null> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      ...init,
    });
    if (!res.ok) return null;
    return (await res.json()) as TRes;
  } catch {
    return null;
  }
}

interface ServerTrendingResponse {
  success?: boolean;
  results?: TrendResult[];
  summary?: string;
  note?: string;
  queries?: string[];
  cacheKey?: string;
}

interface ServerResultsResponse {
  success?: boolean;
  results?: TrendResult[];
  summary?: string;
  note?: string;
  cacheHit?: boolean;
}

/**
 * Run the full hybrid trending flow.
 *
 * @param request The user's tag/niche/genre/ideaConcept payload
 * @param opts.signal Optional AbortSignal to cancel the in-flight
 *                    trending call.
 */
export async function fetchTrendingHybrid(
  request: TrendingClientRequest,
  opts: { signal?: AbortSignal; count?: number } = {},
): Promise<TrendingClientResponse> {
  const count = typeof opts.count === 'number' ? opts.count : DEFAULT_COUNT;
  const headers: Record<string, string> = {};
  if (frontendCanSearch()) {
    headers['x-client-can-search'] = 'true';
  }

  // Step 1: ask the route.
  const first = await postJson<TrendingClientRequest, ServerTrendingResponse>(
    '/api/trending',
    request,
    { headers, signal: opts.signal },
  );
  if (!first) {
    return {
      success: false,
      results: [],
      summary: '',
      error: '/api/trending unreachable',
    };
  }

  // Step 2: Server-Side path worked — forward as-is.
  if (first.note !== 'CLIENT_SEARCH_REQUIRED') {
    return {
      success: true,
      results: first.results ?? [],
      summary: first.summary ?? '',
      note: first.note,
    };
  }

  // Step 3: Server-Side path fell through. We need to run the
  // search ourselves.
  const queries = first.queries ?? [];
  const cacheKey = first.cacheKey ?? '';
  if (queries.length === 0 || !cacheKey) {
    return {
      success: true,
      results: [],
      summary: '',
      note: 'CLIENT_SEARCH_REQUIRED but no queries returned',
      hybridTriggered: true,
    };
  }

  // We don't know which queries are Google vs Reddit from the
  // route's response — the route sends a flat list. We use
  // `@google_search` for every query; that's the conservative
  // choice and matches the historical pre-camofox behavior
  // (the franchise-subreddit scoping is a "nice to have" that
  // the client-side path can fill in via a separate
  // `@reddit_search` call if needed; the orchestrator keeps
  // the simple fan-out for v1).
  const macro = '@google_search';
  const perQuery = await Promise.all(
    queries.map((q) =>
      clientSideCamofoxSearch({ macro, query: q, count, signal: opts.signal }),
    ),
  );
  const flat: WebSearchResult[] = [];
  for (const arr of perQuery) {
    for (const r of arr) flat.push(r);
  }

  // Step 4: POST back for dedup + caching.
  const second = await postJson<{ cacheKey: string; results: WebSearchResult[] }, ServerResultsResponse>(
    '/api/trending/results',
    { cacheKey, results: flat },
    { signal: opts.signal },
  );
  if (!second) {
    // Dedup + cache write failed; return what we have client-side,
    // deduped on the fly. Best-effort — we don't want to swallow
    // the user's input without ANY signal.
    const deduped = clientSideDedup(flat);
    return {
      success: true,
      results: deduped,
      summary: deduped
        .slice(0, MAX_RESULTS)
        .map((r) => `- [camofox-client] ${r.headline}`)
        .join('\n'),
      note: 'Client-side dedup (results route unreachable)',
      hybridTriggered: true,
    };
  }

  return {
    success: true,
    results: second.results ?? [],
    summary: second.summary ?? '',
    note: second.note,
    hybridTriggered: true,
  };
}

/**
 * Local dedup as a fallback when the results route is
 * unreachable. Same shape as the route's dedup, kept in sync
 * via a comment + manual test.
 */
function clientSideDedup(results: WebSearchResult[]): TrendResult[] {
  const seen = new Set<string>();
  const out: TrendResult[] = [];
  for (const r of results) {
    if (!r || !r.title || !r.url) continue;
    const key = r.title
      .toLowerCase()
      .replace(/^\[\d+↑\]\s*/, '')
      .slice(0, 60);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      topic: 'client-search',
      headline: r.title.trim(),
      source: 'camofox-client',
      url: r.url,
    });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}
