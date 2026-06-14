/**
 * V1.1.3-ORCH (2026-06-07): vitest for the /api/trending/results
 * receiver. Pins:
 *   1. Dedup-by-headline-prefix (mirrors the parent route's logic).
 *   2. Cache write + cache hit on a second call with the same key
 *      within the 5-minute TTL.
 *   3. Cache miss / fresh write on a different cacheKey.
 *   4. Bad-input guard (missing cacheKey / non-array results).
 *   5. The 15-result cap (MAX_RESULTS) is enforced.
 *   6. Score-bracket prefix `[42↑] ` is stripped before dedup
 *      (so a Reddit score-bracket variant of the same title
 *      doesn't survive as a duplicate).
 *
 * Test isolation: we use `vi.resetModules()` to drop the
 * module-scope `trendCache` between tests so the cache state
 * doesn't leak across the suite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
});

function makePost(body: unknown): NextRequest {
  return new NextRequest('http://x/api/trending/results', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function importRoute() {
  const mod = await import('@/app/api/trending/results/route');
  return mod.POST;
}

describe('POST /api/trending/results — V1.1.3-ORCH dedup + cache', () => {
  it('returns 400 when cacheKey is missing', async () => {
    const POST = await importRoute();
    const res = await POST(
      makePost({ results: [{ title: 'X', url: 'https://x' }] }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('returns 400 when results is not an array', async () => {
    const POST = await importRoute();
    const res = await POST(
      makePost({ cacheKey: 'k1', results: 'not-an-array' }),
    );
    expect(res.status).toBe(400);
  });

  it('dedupes by headline prefix — same title from two queries collapses to one', async () => {
    const POST = await importRoute();
    const shared = 'Marvel Cinematic Universe Phase 6 reveal';
    const res = await POST(
      makePost({
        cacheKey: 'marvel|k1',
        results: [
          { title: shared, url: 'https://x/1' },
          { title: shared, url: 'https://x/1' },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    const matches = body.results.filter(
      (r: { headline: string }) => r.headline === shared,
    );
    expect(matches.length).toBe(1);
  });

  it('strips Reddit score bracket [42↑] before dedup', async () => {
    const POST = await importRoute();
    const res = await POST(
      makePost({
        cacheKey: 'marvel|k2',
        results: [
          { title: 'Star Wars new republic show', url: 'https://x/1' },
          { title: '[42↑] Star Wars new republic show', url: 'https://x/1' },
        ],
      }),
    );
    const body = await res.json();
    expect(body.results.length).toBe(1);
  });

  it('keeps different headlines as separate results', async () => {
    const POST = await importRoute();
    const res = await POST(
      makePost({
        cacheKey: 'k3',
        results: [
          { title: 'Headline A', url: 'https://x/a' },
          { title: 'Headline B', url: 'https://x/b' },
        ],
      }),
    );
    const body = await res.json();
    expect(body.results.length).toBe(2);
  });

  it('caps results at MAX_RESULTS (15)', async () => {
    const POST = await importRoute();
    const items = Array.from({ length: 25 }, (_, i) => ({
      title: `Unique headline number ${i} about Marvel`,
      url: `https://x/${i}`,
    }));
    const res = await POST(
      makePost({ cacheKey: 'k-cap', results: items }),
    );
    const body = await res.json();
    expect(body.results.length).toBe(15);
  });

  it('skips items with empty title or url', async () => {
    const POST = await importRoute();
    const res = await POST(
      makePost({
        cacheKey: 'k-empty',
        results: [
          { title: '', url: 'https://x/1' },
          { title: '   ', url: 'https://x/2' },
          { title: 'Valid headline', url: '' },
          { title: 'Valid headline 2', url: 'https://x/3' },
        ],
      }),
    );
    const body = await res.json();
    expect(body.results.length).toBe(1);
    expect(body.results[0].headline).toBe('Valid headline 2');
  });

  it('writes to the cache on the first call (cacheHit: false)', async () => {
    const POST = await importRoute();
    const res = await POST(
      makePost({
        cacheKey: 'k-cache-write',
        results: [{ title: 'First call result', url: 'https://x/1' }],
      }),
    );
    const body = await res.json();
    expect(body.cacheHit).toBe(false);
    expect(body.results.length).toBe(1);
  });

  it('returns cacheHit: true on a second call with the same key + different body (cache wins)', async () => {
    const POST = await importRoute();
    // First call writes the cache.
    await POST(
      makePost({
        cacheKey: 'k-cache-read',
        results: [{ title: 'Cached headline', url: 'https://x/1' }],
      }),
    );
    // Second call with the same key but a different body. The
    // cache should win — we don't re-merge.
    const res = await POST(
      makePost({
        cacheKey: 'k-cache-read',
        results: [{ title: 'Newer headline', url: 'https://x/2' }],
      }),
    );
    const body = await res.json();
    expect(body.cacheHit).toBe(true);
    const headlines = body.results.map((r: { headline: string }) => r.headline);
    expect(headlines).toContain('Cached headline');
    expect(headlines).not.toContain('Newer headline');
  });

  it('treats a different cacheKey as a fresh write', async () => {
    const POST = await importRoute();
    await POST(
      makePost({
        cacheKey: 'kA',
        results: [{ title: 'Headline for A', url: 'https://x/a' }],
      }),
    );
    const res = await POST(
      makePost({
        cacheKey: 'kB',
        results: [{ title: 'Headline for B', url: 'https://x/b' }],
      }),
    );
    const body = await res.json();
    expect(body.cacheHit).toBe(false);
    const headlines = body.results.map((r: { headline: string }) => r.headline);
    expect(headlines).toEqual(['Headline for B']);
  });

  it('emits a "limited data" note when fewer than 3 results survive dedup', async () => {
    const POST = await importRoute();
    const res = await POST(
      makePost({
        cacheKey: 'k-limited',
        results: [{ title: 'Only one', url: 'https://x/1' }],
      }),
    );
    const body = await res.json();
    expect(body.note).toMatch(/limited/i);
  });

  it('emits a human-readable summary block', async () => {
    const POST = await importRoute();
    const res = await POST(
      makePost({
        cacheKey: 'k-summary',
        results: [
          { title: 'Marvel reveal', url: 'https://x/a' },
          { title: 'Star Wars news', url: 'https://x/b' },
        ],
      }),
    );
    const body = await res.json();
    expect(typeof body.summary).toBe('string');
    expect(body.summary).toContain('Marvel reveal');
    expect(body.summary).toContain('Star Wars news');
  });
});
