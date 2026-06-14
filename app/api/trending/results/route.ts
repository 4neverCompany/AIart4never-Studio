/**
 * POST /api/trending/results
 *
 * V1.1.3-ORCH (2026-06-07): results-receiver for the hybrid
 * client-side trending path. The companion to `/api/trending`:
 *
 *   1. `lib/trending-client.ts` POSTs to `/api/trending`.
 *   2. The route falls through to the CLIENT_SEARCH_REQUIRED
 *      envelope (Server-Side camofox unreachable, but the
 *      frontend has the `x-client-can-search: true` opt-in
 *      header set).
 *   3. The frontend runs each query through
 *      `clientSideCamofoxSearch()` and POSTs the merged raw
 *      results back here.
 *   4. THIS route runs the same dedup + cache logic the
 *      Server-Side path runs, so subsequent calls with the
 *      same cacheKey short-circuit to the cached result.
 *
 * We duplicate the small `TrendResult` shape + dedup logic
 * here instead of importing from the parent route. Reason:
 * Next.js route files are evaluated per-request; importing a
 * sibling route file would drag the entire trending route's
 * constants in (and would re-execute the `trendCache` Map
 * constructor on every import in some bundler modes). The
 * dedup function is small enough to keep two copies honest;
 * a 3-way test pins the behavior across both files.
 *
 * NOTE: the cache lives in module scope. In a long-running
 * server (the Node sidecar in Tauri-Web build), this is a
 * stable in-memory map. In the Vercel-Web build, the route
 * is serverless and the cache is per-instance — the 5-minute
 * TTL keeps that from being a correctness problem, only a
 * cache-effectiveness problem.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/errors';

interface TrendResult {
  topic: string;
  headline: string;
  source: string;
  url: string;
}

interface ClientSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

interface ResultsRequest {
  /** The cache key the original /api/trending call returned. */
  cacheKey: string;
  /** Raw camofox results from the client-side search, one entry
   *  per query the orchestrator ran. We dedupe across all of
   *  them at the route level. */
  results: ClientSearchResult[];
}

const trendCache = new Map<string, { results: TrendResult[]; timestamp: number; note?: string }>();
const CACHE_TTL = 5 * 60 * 1000;
const MAX_RESULTS = 15;

/**
 * Dedup by headline prefix (mirrors the parent route's logic —
 * strips Reddit's `[42↑] ` score bracket so the same title
 * doesn't land twice from different sources). Returns up to
 * `MAX_RESULTS` entries.
 */
function dedupAndLimit(raw: ClientSearchResult[]): TrendResult[] {
  const seen = new Set<string>();
  const unique: TrendResult[] = [];
  for (const r of raw) {
    if (!r || typeof r.title !== 'string' || typeof r.url !== 'string') continue;
    if (!r.title.trim() || !r.url.trim()) continue;
    const headline = r.title.trim();
    const key = headline
      .toLowerCase()
      .replace(/^\[\d+↑\]\s*/, '')
      .slice(0, 60);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      topic: 'client-search',
      headline,
      source: 'camofox-client',
      url: r.url.trim(),
    });
    if (unique.length >= MAX_RESULTS) break;
  }
  return unique;
}

function pruneCacheIfLarge(): void {
  if (trendCache.size <= 50) return;
  const now = Date.now();
  for (const [key, entry] of trendCache) {
    if (now - entry.timestamp > CACHE_TTL) trendCache.delete(key);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body: ResultsRequest = await req.json();
    if (!body || typeof body.cacheKey !== 'string' || !Array.isArray(body.results)) {
      return NextResponse.json(
        { success: false, error: 'cacheKey (string) and results (array) are required' },
        { status: 400 },
      );
    }

    const cacheKey = body.cacheKey;
    const cached = trendCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return NextResponse.json({
        success: true,
        results: cached.results,
        summary: cached.results
          .slice(0, MAX_RESULTS)
          .map((item) => `- [${item.source}] ${item.headline}`)
          .join('\n'),
        cacheHit: true,
      });
    }

    const topResults = dedupAndLimit(body.results);
    const note = topResults.length < 3
      ? 'Limited trending data — consider broader niches'
      : undefined;
    const summary = topResults
      .map((item) => `- [${item.source}] ${item.headline}`)
      .join('\n');

    trendCache.set(cacheKey, { results: topResults, timestamp: Date.now(), note });
    pruneCacheIfLarge();

    return NextResponse.json({
      success: true,
      results: topResults,
      summary,
      note,
      cacheHit: false,
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { success: false, error: getErrorMessage(e), results: [], summary: '' },
      { status: 500 },
    );
  }
}
