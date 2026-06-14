/**
 * V1.1.3-ORCH (2026-06-07): vitest for `lib/camofox-client.ts`.
 *
 * Pins the transport-selection contract:
 *   1. When `window.__TAURI_INTERNALS__` is set, the helper
 *      dynamic-imports `@tauri-apps/api/core` and calls
 *      `invoke('camofox_search', { macroName, query, count })`.
 *      The fetch path is NOT used.
 *   2. When `window.__TAURI_INTERNALS__` is NOT set, the helper
 *      falls through to the direct-fetch probe (4 ports). We mock
 *      fetch to simulate camofox answering on port 9379.
 *   3. On any failure path (Tauri throws, no port answers, etc.)
 *      the helper returns `[]` and never throws to the caller.
 *   4. Empty macro or empty query short-circuits to `[]`.
 *
 * Test isolation: we use `vi.resetModules()` between tests so
 * the dynamic-import cache doesn't leak.
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
  // happy-dom's environment provides a window; the test framework
  // is happy-dom. We install a clean window per-test by setting
  // it explicitly.
  (globalThis as unknown as { window: unknown }).window = {};
});

interface InvokeMockOpts {
  /** What `invoke` should resolve to. */
  resolve: unknown;
  /** If set, `invoke` should reject with this error. */
  reject?: Error;
}

function installInvokeMock(opts: InvokeMockOpts): ReturnType<typeof vi.fn> {
  const invokeMock = vi.fn(async (_cmd: string, _args: Record<string, unknown>) => {
    if (opts.reject) throw opts.reject;
    return opts.resolve;
  });
  // happy-dom in this project has @tauri-apps/api/core resolvable
  // as a virtual module (the package isn't installed, so the
  // dynamic import returns a stub via the dependency graph). We
  // use vi.doMock to inject our mock module under that path.
  vi.doMock('@tauri-apps/api/core', () => ({
    invoke: invokeMock,
  }));
  return invokeMock;
}

describe('clientSideCamofoxSearch — V1.1.3-ORCH transport selection', () => {
  it('returns [] for an empty macro', async () => {
    const { clientSideCamofoxSearch } = await import('@/lib/camofox-client');
    const out = await clientSideCamofoxSearch({ macro: '', query: 'hello' });
    expect(out).toEqual([]);
  });

  it('returns [] for an empty query', async () => {
    const { clientSideCamofoxSearch } = await import('@/lib/camofox-client');
    const out = await clientSideCamofoxSearch({ macro: '@google_search', query: '' });
    expect(out).toEqual([]);
  });

  it('uses the Tauri invoke path when __TAURI_INTERNALS__ is set', async () => {
    (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window = {
      __TAURI_INTERNALS__: { invoke: vi.fn() },
    };
    const invokeMock = installInvokeMock({
      resolve: [
        { title: 'Iron Man reveal', url: 'https://x/1', snippet: '' },
        { title: 'Star Wars news', url: 'https://x/2', snippet: '' },
      ],
    });
    const { clientSideCamofoxSearch } = await import('@/lib/camofox-client');
    const out = await clientSideCamofoxSearch({
      macro: '@google_search',
      query: 'Marvel news 2026',
      count: 5,
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      'camofox_search',
      expect.objectContaining({
        macroName: '@google_search',
        query: 'Marvel news 2026',
        count: 5,
      }),
    );
    expect(out).toHaveLength(2);
    expect(out[0].title).toBe('Iron Man reveal');
  });

  it('returns [] when Tauri invoke throws (and never throws to the caller)', async () => {
    (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window = {
      __TAURI_INTERNALS__: { invoke: vi.fn() },
    };
    installInvokeMock({ resolve: null, reject: new Error('tauri error') });
    const { clientSideCamofoxSearch } = await import('@/lib/camofox-client');
    const out = await clientSideCamofoxSearch({
      macro: '@google_search',
      query: 'test',
    });
    expect(out).toEqual([]);
  });

  it('returns [] when Tauri is set but the dynamic import fails (treated as no-Tauri)', async () => {
    (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window = {
      __TAURI_INTERNALS__: { invoke: vi.fn() },
    };
    // Force the dynamic import to throw by NOT mocking
    // @tauri-apps/api/core. The helper should swallow the import
    // error and fall through to the empty-result path.
    vi.doMock('@tauri-apps/api/core', () => {
      throw new Error('module not available');
    });
    const { clientSideCamofoxSearch } = await import('@/lib/camofox-client');
    const out = await clientSideCamofoxSearch({
      macro: '@google_search',
      query: 'test',
    });
    expect(out).toEqual([]);
  });

  it('falls back to the direct-fetch path when __TAURI_INTERNALS__ is not set', async () => {
    // No __TAURI_INTERNALS__ on window.
    (globalThis as unknown as { window: Record<string, unknown> }).window = {};
    // Mock the 4-port probe to find a service on 9379. We make
    // every fetch respond with an opaque/cors 200 + camofox body.
    let fetchCalls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      fetchCalls++;
      const url = typeof input === 'string' ? input : (input as URL).toString();
      // Standalone-discovery probe (no-cors then cors /health).
      if (url.includes('/health')) {
        return new Response('{"ok":true,"engine":"camoufox"}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Tab open.
      if (url.endsWith('/tabs')) {
        return new Response(JSON.stringify({ tabId: 'tab-xyz' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Navigate.
      if (url.includes('/navigate')) {
        return new Response('', { status: 200 });
      }
      // /links.
      if (url.includes('/links')) {
        return new Response(
          JSON.stringify([
            { ref: 'e1', url: 'https://example.com/a', text: 'Headline A' },
            { ref: 'e2', url: 'https://example.com/b', text: 'Headline B' },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // Tab close.
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const { clientSideCamofoxSearch } = await import('@/lib/camofox-client');
    const out = await clientSideCamofoxSearch({
      macro: '@google_search',
      query: 'Marvel news 2026',
      count: 3,
    });
    expect(out.length).toBeGreaterThan(0);
    expect(fetchCalls).toBeGreaterThan(0);
    expect(out[0].title).toBeTruthy();
    expect(out[0].url).toMatch(/^https:\/\/example\.com\//);
  });

  it('returns [] when no port answers and fetch never resolves the discovery', async () => {
    (globalThis as unknown as { window: Record<string, unknown> }).window = {};
    // All fetches fail.
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const { clientSideCamofoxSearch } = await import('@/lib/camofox-client');
    const out = await clientSideCamofoxSearch({
      macro: '@google_search',
      query: 'test',
    });
    expect(out).toEqual([]);
  });

  it('clamps count to the 1..=20 range', async () => {
    (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window = {
      __TAURI_INTERNALS__: { invoke: vi.fn() },
    };
    const invokeMock = installInvokeMock({ resolve: [] });
    const { clientSideCamofoxSearch } = await import('@/lib/camofox-client');
    // Count = 0 should clamp to 1.
    await clientSideCamofoxSearch({ macro: '@google_search', query: 'x', count: 0 });
    expect(invokeMock).toHaveBeenLastCalledWith(
      'camofox_search',
      expect.objectContaining({ count: 1 }),
    );
    // Count = 999 should clamp to 20.
    await clientSideCamofoxSearch({ macro: '@google_search', query: 'x', count: 999 });
    expect(invokeMock).toHaveBeenLastCalledWith(
      'camofox_search',
      expect.objectContaining({ count: 20 }),
    );
    // Count undefined should default to 8.
    await clientSideCamofoxSearch({ macro: '@google_search', query: 'x' });
    expect(invokeMock).toHaveBeenLastCalledWith(
      'camofox_search',
      expect.objectContaining({ count: 8 }),
    );
  });

  it('filters out non-object / missing-url items from the Tauri response', async () => {
    (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window = {
      __TAURI_INTERNALS__: { invoke: vi.fn() },
    };
    installInvokeMock({
      resolve: [
        { title: 'Valid', url: 'https://x/1', snippet: '' },
        { title: 'No url', snippet: '' },            // missing url field
        null,                                        // null entry
        'string-not-object',                         // non-object entry
        { url: 'https://x/3' },                      // missing title field
        { title: 'Another valid', url: 'https://x/4', snippet: 'detail' },
      ],
    });
    const { clientSideCamofoxSearch } = await import('@/lib/camofox-client');
    const out = await clientSideCamofoxSearch({
      macro: '@google_search',
      query: 'test',
    });
    // Only the 2 fully-valid entries survive.
    expect(out).toHaveLength(2);
    expect(out[0].title).toBe('Valid');
    expect(out[1].title).toBe('Another valid');
    expect(out[1].snippet).toBe('detail');
  });
});
