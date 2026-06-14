/**
 * V1.1.3-ORCH (2026-06-07): vitest for the `lib/trending-client.ts`
 * orchestrator. Pins the end-to-end hybrid flow with both
 * transports mocked:
 *
 *   1. Server-Side success path — the route returns normal
 *      results, the orchestrator forwards them as-is, no client
 *      call happens.
 *   2. CLIENT_SEARCH_REQUIRED → client-side search → results
 *      route. The orchestrator hits `clientSideCamofoxSearch`
 *      once per query, then POSTs the merged list back to
 *      `/api/trending/results` and returns the final response.
 *   3. Results-route unreachable fallback — the orchestrator
 *      does its own dedup and returns the client-side results
 *      with a note explaining the fallback.
 *   4. Initial /api/trending unreachable — returns a
 *      `{ success: false, error, ... }` shape and does NOT throw.
 *   5. The orchestrator always sets `x-client-can-search: true`
 *      when running in a windowed environment (Tauri OR web).
 *
 * Test isolation: `vi.resetModules()` between tests so the
 * dynamic-import cache for `@/lib/camofox-client` is fresh.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_WINDOW = (globalThis as unknown as { window?: unknown }).window;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_WINDOW === undefined) {
    delete (globalThis as unknown as { window?: unknown }).window;
  } else {
    (globalThis as unknown as { window: unknown }).window = ORIGINAL_WINDOW;
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = {};
});

interface FetchReply {
  url: string;
  status?: number;
  body?: unknown;
}

function makeFetchMock(replies: FetchReply[]): ReturnType<typeof vi.fn> {
  let i = 0;
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    // Match by substring; the first matching reply wins.
    for (let j = i; j < replies.length; j++) {
      if (url.includes(replies[j].url)) {
        i = j + 1;
        const r = replies[j];
        return new Response(
          typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}),
          {
            status: r.status ?? 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
    }
    throw new Error(`mock fetch: no reply for ${url}`);
  }) as unknown as ReturnType<typeof vi.fn>;
}

describe('fetchTrendingHybrid — V1.1.3-ORCH orchestrator', () => {
  it('forwards server-side results as-is when route returns normal results', async () => {
    const fetchMock = makeFetchMock([
      {
        url: '/api/trending',
        body: {
          success: true,
          results: [
            { topic: 'Marvel', headline: 'Phase 6', source: 'camofox', url: 'https://x/1' },
            { topic: 'Marvel', headline: 'Iron Man', source: 'camofox', url: 'https://x/2' },
          ],
          summary: '- [camofox] Phase 6\n- [camofox] Iron Man',
        },
      },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { fetchTrendingHybrid } = await import('@/lib/trending-client');
    const out = await fetchTrendingHybrid({ tags: ['Marvel'], niches: ['Marvel'] });
    expect(out.success).toBe(true);
    expect(out.results).toHaveLength(2);
    expect(out.hybridTriggered).toBeFalsy();
    // The orchestrator sets x-client-can-search: true; we don't
    // assert that here — the route test covers the header
    // handling. We DO assert only ONE fetch happened (the route,
    // no results-route round-trip).
    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
  });

  it('runs the client-side search + results POST when route returns CLIENT_SEARCH_REQUIRED', async () => {
    // Mock the @tauri-apps/api/core dynamic import so the
    // clientSideCamofoxSearch helper goes down the Tauri path
    // (we don't need to actually start a Tauri runtime).
    vi.doMock('@tauri-apps/api/core', () => ({
      invoke: vi.fn(async (_cmd: string, args: Record<string, unknown>) => {
        // Echo the query back as a single result so the
        // orchestrator sees a non-empty list to merge.
        return [
          {
            title: `Result for ${args.query}`,
            url: `https://x/?q=${encodeURIComponent(String(args.query))}`,
            snippet: '',
          },
        ];
      }),
    }));
    // We MUST set __TAURI_INTERNALS__ on the window so the
    // helper picks the Tauri transport.
    (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window = {
      __TAURI_INTERNALS__: { invoke: vi.fn() },
    };
    const fetchMock = makeFetchMock([
      {
        url: '/api/trending',
        body: {
          success: true,
          results: [],
          summary: '',
          note: 'CLIENT_SEARCH_REQUIRED',
          queries: ['Marvel news 2026', 'Marvel announcement'],
          cacheKey: 'marvel',
        },
      },
      {
        url: '/api/trending/results',
        body: {
          success: true,
          results: [
            { topic: 'client-search', headline: 'Result for Marvel news 2026', source: 'camofox-client', url: 'https://x/?q=Marvel%20news%202026' },
            { topic: 'client-search', headline: 'Result for Marvel announcement', source: 'camofox-client', url: 'https://x/?q=Marvel%20announcement' },
          ],
          summary: '- [camofox-client] Result for Marvel news 2026\n- [camofox-client] Result for Marvel announcement',
          note: undefined,
        },
      },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { fetchTrendingHybrid } = await import('@/lib/trending-client');
    const out = await fetchTrendingHybrid({ tags: ['Marvel'], niches: ['Marvel'] });
    expect(out.success).toBe(true);
    expect(out.hybridTriggered).toBe(true);
    expect(out.results).toHaveLength(2);
    const headlines = out.results.map((r) => r.headline);
    expect(headlines).toContain('Result for Marvel news 2026');
    expect(headlines).toContain('Result for Marvel announcement');
    // Both fetches happened: route + results route.
    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(2);
  });

  it('does a client-side dedup when the results route is unreachable', async () => {
    vi.doMock('@tauri-apps/api/core', () => ({
      invoke: vi.fn(async (_cmd: string, _args: Record<string, unknown>) => {
        return [
          { title: 'Marvel reveal', url: 'https://x/1', snippet: '' },
          { title: 'Marvel reveal', url: 'https://x/1', snippet: '' }, // dup
          { title: 'Star Wars news', url: 'https://x/2', snippet: '' },
        ];
      }),
    }));
    (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window = {
      __TAURI_INTERNALS__: { invoke: vi.fn() },
    };
    // Single fetch implementation: reply to /api/trending with the
    // CLIENT_SEARCH_REQUIRED envelope, throw on any other URL.
    // This avoids the vitest mock-queue footgun where
    // `mockImplementationOnce` runs BEFORE the default impl.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('/api/trending') && !url.includes('/results')) {
        return new Response(
          JSON.stringify({
            success: true,
            results: [],
            summary: '',
            note: 'CLIENT_SEARCH_REQUIRED',
            queries: ['Marvel reveal'],
            cacheKey: 'marvel',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new TypeError('Failed to fetch');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { fetchTrendingHybrid } = await import('@/lib/trending-client');
    const out = await fetchTrendingHybrid({ tags: ['Marvel'], niches: ['Marvel'] });
    expect(out.success).toBe(true);
    expect(out.hybridTriggered).toBe(true);
    expect(out.note).toMatch(/client-side dedup/i);
    // The dedup collapsed the 2 Marvel reveal entries + kept
    // the Star Wars one = 2 unique results.
    expect(out.results).toHaveLength(2);
  });

  it('returns success:false when the initial /api/trending call fails', async () => {
    (globalThis as unknown as { window: Record<string, unknown> }).window = {};
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    const { fetchTrendingHybrid } = await import('@/lib/trending-client');
    const out = await fetchTrendingHybrid({ tags: ['Marvel'], niches: ['Marvel'] });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/unreachable/i);
    expect(out.results).toEqual([]);
  });

  it('returns empty results + hybridTriggered when CLIENT_SEARCH_REQUIRED has no queries', async () => {
    vi.doMock('@tauri-apps/api/core', () => ({
      invoke: vi.fn(async () => []),
    }));
    (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window = {
      __TAURI_INTERNALS__: { invoke: vi.fn() },
    };
    const fetchMock = makeFetchMock([
      {
        url: '/api/trending',
        body: {
          success: true,
          results: [],
          summary: '',
          note: 'CLIENT_SEARCH_REQUIRED',
          queries: [], // empty
          cacheKey: 'marvel',
        },
      },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { fetchTrendingHybrid } = await import('@/lib/trending-client');
    const out = await fetchTrendingHybrid({ tags: ['Marvel'], niches: ['Marvel'] });
    expect(out.success).toBe(true);
    expect(out.hybridTriggered).toBe(true);
    expect(out.results).toEqual([]);
    // The orchestrator should NOT have hit the results route —
    // it knew there was nothing to do.
    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
  });

  it('passes the count option through to clientSideCamofoxSearch', async () => {
    let lastCount: number | undefined;
    vi.doMock('@tauri-apps/api/core', () => ({
      invoke: vi.fn(async (_cmd: string, args: Record<string, unknown>) => {
        lastCount = args.count as number;
        return [];
      }),
    }));
    (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window = {
      __TAURI_INTERNALS__: { invoke: vi.fn() },
    };
    const fetchMock = makeFetchMock([
      {
        url: '/api/trending',
        body: {
          success: true,
          results: [],
          summary: '',
          note: 'CLIENT_SEARCH_REQUIRED',
          queries: ['q1'],
          cacheKey: 'k',
        },
      },
      {
        url: '/api/trending/results',
        body: { success: true, results: [], summary: '', note: undefined },
      },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { fetchTrendingHybrid } = await import('@/lib/trending-client');
    await fetchTrendingHybrid({ tags: ['X'] }, { count: 12 });
    expect(lastCount).toBe(12);
  });
});
