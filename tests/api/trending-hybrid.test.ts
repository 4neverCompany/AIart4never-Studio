/**
 * V1.1.3-ORCH (2026-06-07): vitest for the hybrid CLIENT_SEARCH_REQUIRED
 * branch of /api/trending.
 *
 * Pins:
 *   1. When the Server-Side camofox path returns nothing AND the
 *      request includes `x-client-can-search: true`, the route
 *      surfaces a `CLIENT_SEARCH_REQUIRED` envelope with the
 *      `queries` and `cacheKey` the frontend orchestrator needs.
 *   2. When the camofox path returns nothing AND the
 *      `x-client-can-search` header is NOT set, the route falls
 *      through to the existing v1.1.2 behavior (empty results +
 *      "Limited trending data" note) — the new branch is opt-in.
 *   3. When the camofox path returns results, the route ignores
 *      the header and returns the results as-is.
 *   4. The cacheKey is stable across identical inputs.
 *
 * Test isolation follows the project's `vi.doMock` + `vi.resetModules`
 * pattern (see tests/api/trending-camofox-only.test.ts) so each
 * test gets a fresh route import and a fresh `withCamofoxHealth`
 * mock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function makePost(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://x/api/trending', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** Mock the camofox module so `withCamofoxHealth` either returns
 *  the primary call's result or falls through to `[]` (i.e. camofox
 *  is "unreachable" for the route). The route treats both as
 *  "no Server-Side data". */
async function runWithMockedCamofoxServer(opts: {
  serverCamofoxResults: Array<{ title: string; url: string; snippet: string }> | null;
  headers: Record<string, string>;
}): Promise<Response> {
  vi.doMock('@/lib/camofox', () => ({
    withCamofoxHealth: async <T,>(
      primary: () => Promise<T>,
      fallback: () => Promise<T>,
    ): Promise<T> => {
      if (opts.serverCamofoxResults === null) {
        return await fallback();
      }
      try {
        return await primary();
      } catch {
        return await fallback();
      }
    },
    camofoxSearch: async () => opts.serverCamofoxResults ?? [],
  }));
  const { POST: trendingPost } = await import('@/app/api/trending/route');
  return trendingPost(
    makePost(
      { tags: ['Marvel'], niches: ['Marvel'], genres: [], ideaConcept: 'Iron Man vs Darth Vader' },
      opts.headers,
    ),
  );
}

describe('POST /api/trending — V1.1.3-ORCH hybrid branch', () => {
  it('returns CLIENT_SEARCH_REQUIRED when server camofox is unreachable AND x-client-can-search: true', async () => {
    const res = await runWithMockedCamofoxServer({
      serverCamofoxResults: null,
      headers: { 'x-client-can-search': 'true' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.note).toBe('CLIENT_SEARCH_REQUIRED');
    expect(body.results).toEqual([]);
    expect(body.summary).toBe('');
    expect(Array.isArray(body.queries)).toBe(true);
    expect(body.queries.length).toBeGreaterThan(0);
    expect(typeof body.cacheKey).toBe('string');
    expect(body.cacheKey.length).toBeGreaterThan(0);
  });

  it('the queries in the CLIENT_SEARCH_REQUIRED envelope contain the per-niche search strings', async () => {
    const res = await runWithMockedCamofoxServer({
      serverCamofoxResults: null,
      headers: { 'x-client-can-search': 'true' },
    });
    const body = await res.json();
    // Per-niche queries (e.g. "Marvel news 2026", "Marvel announcement")
    // are what the route would have run Server-Side.
    const joined = body.queries.join(' | ').toLowerCase();
    expect(joined).toContain('marvel');
  });

  it('returns the existing graceful-degradation path when x-client-can-search is NOT set', async () => {
    const res = await runWithMockedCamofoxServer({
      serverCamofoxResults: null,
      headers: {}, // no opt-in
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.note).not.toBe('CLIENT_SEARCH_REQUIRED');
    expect(body.results).toEqual([]);
    // The v1.1.2 "limited data" note should be present (the route
    // only adds it when results.length < 3, which 0 satisfies).
    expect(body.note).toMatch(/limited/i);
  });

  it('returns the v1.1.2 success path when server camofox returns results, regardless of the header', async () => {
    const res = await runWithMockedCamofoxServer({
      serverCamofoxResults: [
        { title: 'Marvel Phase 6 reveal', url: 'https://x/1', snippet: '' },
        { title: 'Iron Man crossover', url: 'https://x/2', snippet: '' },
        { title: 'Star Wars news', url: 'https://x/3', snippet: '' },
      ],
      headers: { 'x-client-can-search': 'true' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.note).not.toBe('CLIENT_SEARCH_REQUIRED');
    expect(body.results.length).toBe(3);
  });

  it('returns the v1.1.2 success path when server camofox returns results, even with header absent', async () => {
    const res = await runWithMockedCamofoxServer({
      serverCamofoxResults: [
        { title: 'Marvel Phase 6 reveal', url: 'https://x/1', snippet: '' },
      ],
      headers: {},
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.note).not.toBe('CLIENT_SEARCH_REQUIRED');
  });

  it('treats x-client-can-search: false the same as header absent (strict equality check)', async () => {
    const res = await runWithMockedCamofoxServer({
      serverCamofoxResults: null,
      headers: { 'x-client-can-search': 'false' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.note).not.toBe('CLIENT_SEARCH_REQUIRED');
  });

  it('returns a stable cacheKey for identical inputs', async () => {
    const res1 = await runWithMockedCamofoxServer({
      serverCamofoxResults: null,
      headers: { 'x-client-can-search': 'true' },
    });
    const body1 = await res1.json();
    // Second call gets a fresh module (vi.resetModules), but the
    // cacheKey derivation in the route is purely a function of the
    // sorted tags+niches+genres+ideaConcept — no time component.
    const res2 = await runWithMockedCamofoxServer({
      serverCamofoxResults: null,
      headers: { 'x-client-can-search': 'true' },
    });
    const body2 = await res2.json();
    expect(body1.cacheKey).toBe(body2.cacheKey);
  });

  it('the cacheKey contains the niche values (sanity check that input flows through)', async () => {
    const res = await runWithMockedCamofoxServer({
      serverCamofoxResults: null,
      headers: { 'x-client-can-search': 'true' },
    });
    const body = await res.json();
    // Cache key is built from sorted tags+niches+genres+ideaConcept
    // joined with "|". With Marvel niche + Iron Man idea, we expect
    // both substrings.
    expect(body.cacheKey).toContain('Marvel');
  });
});
