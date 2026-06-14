// V1.1.2-CAMOFOX-ONLY: regression test for the camofox-only
// /api/trending rewrite. The pre-v1.1.2 design layered SearXNG,
// Reddit, and camofox as a 3-way fan-out; the new design is
// camofox-only with two macros (@google_search for general web,
// @reddit_search for franchise subreddit scoping). This test
// pins:
//   1. SearXNG + Reddit-JSON are NOT called anymore.
//   2. camofox results are folded into the response.
//   3. Empty camofox results still return 200 with an empty
//      results array (no 5xx) — graceful degradation.
//   4. Dedup-by-headline-prefix collapses overlap between
//      camofox calls.
//
// Test-isolation note: we mock `@/lib/camofox` per test with
// `vi.doMock` (runtime, not hoisted) so each test gets a fresh
// mock with its own state. This avoids the static-import
// module-cache issues we hit with the hoisted-mock approach.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  // Force the route to be re-imported on each test so the
  // vi.doMock mock takes effect.
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function makePost(body: unknown): NextRequest {
  return new NextRequest('http://x/api/trending', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Helper: vi.doMock the camofox module with a given result-thrower,
// then dynamically import the route (which captures the mock refs),
// then call the handler. Each test is fully isolated.
async function runWithMockedCamofox(opts: {
  result: Array<{ title: string; url: string; snippet: string }> | 'throw' | 'return-default';
}): Promise<Response> {
  vi.doMock('@/lib/camofox', () => ({
    withCamofoxHealth: async <T,>(
      primary: () => Promise<T>,
      fallback: () => Promise<T>,
    ): Promise<T> => {
      try {
        return await primary();
      } catch {
        return await fallback();
      }
    },
    camofoxSearch: async () => {
      if (opts.result === 'throw') {
        throw new Error('mock camofox failure');
      }
      if (opts.result === 'return-default') {
        return [{ title: 'mock result', url: 'https://x/v', snippet: '' }];
      }
      return opts.result;
    },
  }));
  const { POST: trendingPost } = await import('@/app/api/trending/route');
  return trendingPost(makePost({ tags: ['Marvel'], niches: ['Marvel'], genres: [] }));
}

describe('POST /api/trending — V1.1.2 camofox-only', () => {
  it('does NOT call fetch (SearXNG + Reddit JSON removed)', async () => {
    const res = await runWithMockedCamofox({ result: 'return-default' });
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 200 with empty results when camofox returns nothing (no 5xx)', async () => {
    const res = await runWithMockedCamofox({ result: [] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.results).toEqual([]);
    expect(body.note).toMatch(/limited/i);
  });

  it('folds camofox results into the response', async () => {
    const res = await runWithMockedCamofox({
      result: [
        { title: 'Marvel Phase 6 announcement', url: 'https://marvel.example/1', snippet: 'detail' },
        { title: 'Star Wars new republic show', url: 'https://sw.example/2', snippet: 'detail' },
      ],
    });
    const body = await res.json();
    expect(body.success).toBe(true);
    const headlines = body.results.map((r: { headline: string }) => r.headline);
    expect(headlines).toContain('Marvel Phase 6 announcement');
    expect(headlines).toContain('Star Wars new republic show');
  });

  it('dedup by headline prefix collapses overlap between camofox calls', async () => {
    const shared = 'Marvel Cinematic Universe Phase 6 reveal';
    const res = await runWithMockedCamofox({
      result: [{ title: shared, url: 'https://x/v', snippet: '' }],
    });
    const body = await res.json();
    const matches = body.results.filter(
      (r: { headline: string }) => r.headline === shared,
    );
    expect(matches.length).toBe(1);
  });

  it('passes the franchise subreddit list in the response metadata', async () => {
    vi.doMock('@/lib/camofox', () => ({
      withCamofoxHealth: async <T,>(
        primary: () => Promise<T>,
        fallback: () => Promise<T>,
      ): Promise<T> => {
        try { return await primary(); } catch { return await fallback(); }
      },
      camofoxSearch: async () => [{ title: 'mock', url: 'https://x/v', snippet: '' }],
    }));
    const { POST: trendingPost } = await import('@/app/api/trending/route');
    const res = await trendingPost(makePost({ tags: ['Star Wars'], niches: ['Star Wars'], genres: [] }));
    const body = await res.json();
    expect(body.queriesUsed.redditSubs).toContain('StarWars');
  });

  it('gracefully returns 200 when camofox throws (fallback to [])', async () => {
    const res = await runWithMockedCamofox({ result: 'throw' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([]);
  });
});
