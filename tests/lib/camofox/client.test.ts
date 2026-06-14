/**
 * CAMOFOX-CAMOUFOX-1.1.0 (2026-06-06): unit tests for the camofox
 * client. We mock `fetch` with a vi.fn() (no MSW dep — keeps the
 * test surface small). Each test exercises one error path or
 * happy-path branch.
 *
 * Network-level tests (`withCamofoxHealth` integration, retry
 * timing) are timing-sensitive and would need a real camofox
 * fixture. We cover the contract-level behavior here and trust the
 * end-to-end integration test in `.github/workflows/camofox-integration.yml`
 * (Day 4) for the network-level coverage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  camofoxSearch,
  camofoxStatus,
  withCamofoxHealth,
  CamofoxUnavailableError,
  CamofoxParseError,
  scrubPii,
} from '@/lib/camofox/client';
import { CAMOFOX_MACROS, JSON_RETURNING_MACROS } from '@/lib/camofox/macros';

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

/** Helper: install a fetch mock that returns the given responses in order. */
function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  globalThis.fetch = vi.fn(async () => {
    const r = responses[i++] ?? responses[responses.length - 1];
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const baseOpts = {
  userId: 'pi-1',
  sessionKey: 's-1',
  macro: '@google_search' as const,
  query: 'best coffee beans',
  count: 5,
};

describe('camofoxSearch', () => {
  it('happy path: opens tab, navigates, fetches links, closes tab, returns mapped results', async () => {
    mockFetchSequence([
      // 1. POST /tabs
      { status: 200, body: { tabId: 't-1' } },
      // 2. POST /tabs/t-1/navigate
      { status: 200, body: { ok: true, snapshot: '...' } },
      // 3. GET /tabs/t-1/links?userId=pi-1
      {
        status: 200,
        body: [
          { ref: 'e4', url: 'https://example.com/a', text: 'Title A' },
          { ref: 'e5', url: 'https://example.com/b', text: 'Title B' },
        ],
      },
      // 4. DELETE /tabs/t-1
      { status: 200, body: { ok: true } },
    ]);
    const results = await camofoxSearch(baseOpts);
    expect(results).toEqual([
      { title: 'Title A', url: 'https://example.com/a', snippet: '' },
      { title: 'Title B', url: 'https://example.com/b', snippet: '' },
    ]);
    // 4 fetch calls (open, navigate, links, close).
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });

  it('throws CamofoxParseError when /tabs response is missing tabId', async () => {
    mockFetchSequence([{ status: 200, body: { id_not_tabId: 'oops' } }]);
    await expect(camofoxSearch(baseOpts)).rejects.toBeInstanceOf(CamofoxParseError);
  });

  it('throws CamofoxUnavailableError after persistent 5xx', async () => {
    // 4 attempts (initial + 3 retries), all 500. Each attempt has
    // 2 fetch calls (open + navigate — close doesn't run because
    // the error path skips it via the throw). Actually: open always
    // runs first; on open success the next call (navigate) hits
    // 500 and triggers retry. So 4 attempts × 2 calls = 8.
    mockFetchSequence(
      Array.from({ length: 8 }, () => ({ status: 500, body: { error: 'down' } })),
    );
    await expect(camofoxSearch(baseOpts)).rejects.toBeInstanceOf(CamofoxUnavailableError);
  }, 10_000);

  it('does NOT retry on 4xx (auth / bad request)', async () => {
    // 401 on the openTab call → throws immediately (no retry,
    // no closeTab). 1 fetch call total.
    mockFetchSequence([{ status: 401, body: { error: 'no auth' } }]);
    await expect(camofoxSearch(baseOpts)).rejects.toThrow(/HTTP 401/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('Reddit macro: parses JSON snapshot body, skips items without url', async () => {
    mockFetchSequence([
      // open
      { status: 200, body: { tabId: 't-r' } },
      // navigate (Reddit)
      { status: 200, body: { ok: true } },
      // snapshot (JSON body)
      {
        status: 200,
        body: JSON.stringify({
          data: {
            children: [
              { data: { title: 'Reddit Post 1', url: 'https://reddit.com/r/x/1' } },
              { data: { title: 'Reddit Post 2', permalink: '/r/x/2' } },
              { data: { title: 'Skipped (no url)' } },
            ],
          },
        }),
      },
      // close
      { status: 200, body: { ok: true } },
    ]);
    const results = await camofoxSearch({ ...baseOpts, macro: '@reddit_search' });
    expect(results).toEqual([
      { title: 'Reddit Post 1', url: 'https://reddit.com/r/x/1', snippet: '' },
      { title: 'Reddit Post 2', url: 'https://www.reddit.com/r/x/2', snippet: '' },
    ]);
  });

  it('clamps count to [1, 20]', async () => {
    // High count: only 25 links exist but we ask for 9999.
    mockFetchSequence([
      { status: 200, body: { tabId: 't-c' } },
      { status: 200, body: { ok: true } },
      { status: 200, body: Array.from({ length: 25 }, (_, i) => ({ ref: `e${i}`, url: `https://x/${i}`, text: `T${i}` })) },
      { status: 200, body: { ok: true } },
    ]);
    const r = await camofoxSearch({ ...baseOpts, count: 9999 });
    expect(r.length).toBe(20); // clamped to MAX_COUNT
  });

  it('skips links that fail Zod validation (no url)', async () => {
    mockFetchSequence([
      { status: 200, body: { tabId: 't-z' } },
      { status: 200, body: { ok: true } },
      { status: 200, body: [
        { ref: 'e1', url: 'https://valid.com', text: 'Valid' },
        { ref: 'e2', text: 'No URL — should be skipped' },
        null,
        'not-an-object',
        { ref: 'e3', url: 'https://valid2.com', text: 'Valid 2' },
      ] },
      { status: 200, body: { ok: true } },
    ]);
    const r = await camofoxSearch(baseOpts);
    expect(r).toEqual([
      { title: 'Valid', url: 'https://valid.com', snippet: '' },
      { title: 'Valid 2', url: 'https://valid2.com', snippet: '' },
    ]);
  });
});

describe('camofoxStatus', () => {
  it('returns reachable=true on a 200 /health', async () => {
    mockFetchSequence([
      { status: 200, body: { ok: true, engine: 'camoufox' } },
    ]);
    const s = await camofoxStatus({ timeoutMs: 1000 });
    expect(s.reachable).toBe(true);
    expect(s.healthy).toBe(true);
  });

  it('returns reachable=false on a network error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const s = await camofoxStatus({ timeoutMs: 100 });
    expect(s.reachable).toBe(false);
    expect(s.healthy).toBe(false);
  });

  it('returns reachable=true but healthy=false on a 200 with ok:false body', async () => {
    mockFetchSequence([
      { status: 200, body: { ok: false, recovering: true } },
    ]);
    const s = await camofoxStatus({ timeoutMs: 1000 });
    expect(s.reachable).toBe(true);
    expect(s.healthy).toBe(false);
  });
});

describe('withCamofoxHealth', () => {
  it('calls primary when camofox is reachable', async () => {
    mockFetchSequence([{ status: 200, body: { ok: true } }]);
    const primary = vi.fn(async () => 'primary-result');
    const fallback = vi.fn(async () => 'fallback-result');
    const r = await withCamofoxHealth(primary, fallback);
    expect(r).toBe('primary-result');
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('calls fallback when camofox is unreachable', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const primary = vi.fn(async () => 'primary-result');
    const fallback = vi.fn(async () => 'fallback-result');
    const r = await withCamofoxHealth(primary, fallback);
    expect(r).toBe('fallback-result');
    expect(primary).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('falls back when primary throws CamofoxUnavailableError mid-call', async () => {
    // /health 200 OK (so the probe passes), then /tabs 500 (which
    // after retries throws CamofoxUnavailableError).
    mockFetchSequence(
      [{ status: 200, body: { ok: true } } as { status: number; body: unknown }].concat(
        Array.from({ length: 8 }, () => ({ status: 500, body: { error: 'down' } })),
      ),
    );
    const fallback = vi.fn(async (): Promise<Awaited<ReturnType<typeof camofoxSearch>>> => []);
    const r = await withCamofoxHealth(
      () => camofoxSearch(baseOpts),
      fallback,
    );
    expect(r).toEqual([]);
  }, 10_000);

  it('re-throws non-camofox errors (does not fall back)', async () => {
    mockFetchSequence([{ status: 200, body: { ok: true } }]);
    const primary = vi.fn(async () => {
      throw new TypeError('totally unrelated');
    });
    const fallback = vi.fn(async () => 'fallback-result');
    await expect(withCamofoxHealth(primary, fallback)).rejects.toBeInstanceOf(TypeError);
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe('scrubPii', () => {
  it('strips case-insensitive @handle mentions', () => {
    const s = scrubPii('Hello @Maurice and @maurice and @MAURICE!', 'maurice');
    expect(s).toBe('Hello [user] and [user] and [user]!');
  });

  it('escapes regex metacharacters in the handle', () => {
    const s = scrubPii('Foo @user.name and @user.namex', 'user.name');
    expect(s).toBe('Foo [user] and @user.namex'); // word-boundary prevents the second match
  });

  it('returns snapshot unchanged when currentUserHandle is null', () => {
    const s = scrubPii('Hello @anyone', null);
    expect(s).toBe('Hello @anyone');
  });

  it('returns snapshot unchanged when currentUserHandle is empty string', () => {
    const s = scrubPii('Hello @anyone', '');
    expect(s).toBe('Hello @anyone');
  });
});

describe('macros', () => {
  it('exposes the 14-macro list', () => {
    expect(CAMOFOX_MACROS.length).toBe(14);
    expect(CAMOFOX_MACROS).toContain('@google_search');
    expect(CAMOFOX_MACROS).toContain('@reddit_search');
  });

  it('marks Reddit as JSON-returning', () => {
    expect(JSON_RETURNING_MACROS.has('@reddit_search')).toBe(true);
    expect(JSON_RETURNING_MACROS.has('@reddit_subreddit')).toBe(true);
    expect(JSON_RETURNING_MACROS.has('@google_search')).toBe(false);
  });
});
