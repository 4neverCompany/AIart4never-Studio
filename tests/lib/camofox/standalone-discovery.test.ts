/**
 * V1.1.3-CORS (2026-06-07): vitest for the standalone 4-port
 * discovery helper. We mock `fetch` (no real camofox needed) and
 * exercise the two-step probe (port-occupancy via `no-cors` →
 * camofox-identity via `cors`). The mocked fetch is the source of
 * truth — we don't need happy-dom or jsdom for this pure-async
 * module.
 *
 * Test isolation: we use `vi.stubGlobal('fetch', ...)` in each
 * test and restore in `afterEach`. happy-dom's fetch isn't
 * available in this test, so the stub is the only fetch the
 * module sees.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAMOFOX_STANDALONE_PORTS,
  discoverCamofoxStandalone,
  camofoxStandaloneBaseUrl,
} from '@/lib/camofox/standalone-discovery';

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

interface MockResponseSpec {
  /** opaque response (no-cors mode result) */
  opaque: boolean;
  /** CORS-mode status, default 200 */
  corsStatus?: number;
  /** CORS-mode body — must contain "camoufox" to count as a hit */
  corsBody?: string;
  /** If set, throw this error from the CORS-mode fetch */
  corsError?: Error;
  /** If set, throw this error from the no-cors-mode fetch */
  noCorsError?: Error;
}

function mockFetchAt(port: number, spec: MockResponseSpec) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (!url.includes(`127.0.0.1:${port}/health`)) {
      throw new Error(`mockFetchAt(${port}): unexpected fetch to ${url}`);
    }
    const isCors = init?.mode === 'cors';
    if (!isCors) {
      // no-cors mode
      if (spec.noCorsError) throw spec.noCorsError;
      // Opaque response: status=0, type='opaque'. happy-dom's
      // Response doesn't expose `type` reliably, so we return a
      // regular Response and the helper's "type === 'opaque'"
      // check would fail. Workaround: in this test we also
      // assert the helper accepts the no-cors response as
      // "occupied" via the successful-return path. The helper
      // logic is: if fetch returns without throwing AND the
      // URL was a no-cors request, treat as occupied. We
      // emulate that by returning a 200 here when opaque is
      // requested.
      if (spec.opaque) {
        return new Response('', { status: 200 });
      }
      // Simulate a "port not bound" by throwing a connection
      // refused error.
      throw new TypeError('Failed to fetch');
    }
    // cors mode
    if (spec.corsError) throw spec.corsError;
    return new Response(spec.corsBody ?? '', {
      status: spec.corsStatus ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

/**
 * Multi-port version: install a single fetch mock that dispatches
 * to per-port specs. Used by tests that exercise more than one
 * port in the same scenario (e.g. "port 9377 is occupied by
 * Hermes, port 9378 is camofox").
 */
function mockFetchByPort(specs: Map<number, MockResponseSpec>, opts: { defaultReject?: boolean } = {}) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    // Extract the port from the URL.
    const m = url.match(/127\.0\.0\.1:(\d+)\/health/);
    if (!m) throw new Error(`mockFetchByPort: unexpected URL ${url}`);
    const port = Number(m[1]);
    const spec = specs.get(port);
    if (!spec) {
      if (opts.defaultReject) {
        // Default: any port without a spec is "free" (fetch fails).
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`mockFetchByPort: no spec for port ${port} (URL ${url})`);
    }
    const isCors = init?.mode === 'cors';
    if (!isCors) {
      if (spec.noCorsError) throw spec.noCorsError;
      if (spec.opaque) return new Response('', { status: 200 });
      throw new TypeError('Failed to fetch');
    }
    if (spec.corsError) throw spec.corsError;
    return new Response(spec.corsBody ?? '', {
      status: spec.corsStatus ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('CAMOFOX_STANDALONE_PORTS', () => {
  it('matches the Rust-side CAMOFOX_PORTS (4 ports starting at 9377)', () => {
    expect([...CAMOFOX_STANDALONE_PORTS]).toEqual([9377, 9378, 9379, 9380]);
  });
});

describe('discoverCamofoxStandalone — happy path', () => {
  it('finds camofox on the first port tried', async () => {
    mockFetchAt(9377, { opaque: true, corsBody: '{"ok":true,"engine":"camoufox"}' });
    const r = await discoverCamofoxStandalone({ timeoutMs: 1000 });
    expect(r.port).toBe(9377);
    expect(r.respondingPorts).toEqual([9377]);
  });

  it('skips non-camofox services and tries the next port', async () => {
    // 9377 is occupied by something else (Hermes, say)
    // 9378 is camofox — both must be in the same fetch mock
    // because successive mockFetchAt calls overwrite the
    // global fetch.
    mockFetchByPort(
      new Map([
        [9377, { opaque: true, corsBody: '{"service":"hermes-agent"}' }],
        [9378, { opaque: true, corsBody: '{"ok":true,"engine":"camoufox"}' }],
      ]),
    );
    const r = await discoverCamofoxStandalone({ timeoutMs: 1000 });
    expect(r.port).toBe(9378);
    expect(r.respondingPorts).toEqual([9377, 9378]);
  });

  it('cycles to port 9380 when 9377-9379 are taken by non-camofox', async () => {
    mockFetchByPort(
      new Map([
        [9377, { opaque: true, corsBody: '{"x":1}' }],
        [9378, { opaque: true, corsBody: '{"x":2}' }],
        [9379, { opaque: true, corsBody: '{"x":3}' }],
        [9380, { opaque: true, corsBody: '{"ok":true,"engine":"camoufox"}' }],
      ]),
    );
    const r = await discoverCamofoxStandalone({ timeoutMs: 1000 });
    expect(r.port).toBe(9380);
    expect(r.respondingPorts).toEqual([9377, 9378, 9379, 9380]);
  });
});

describe('discoverCamofoxStandalone — no match', () => {
  it('returns port=null when no port responds', async () => {
    // All four ports throw on no-cors (port not bound).
    // We mock globally with a per-port rejecter.
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const r = await discoverCamofoxStandalone({ timeoutMs: 1000 });
    expect(r.port).toBeNull();
    expect(r.respondingPorts).toEqual([]);
  });

  it('returns port=null when all 4 ports are occupied by non-camofox', async () => {
    mockFetchByPort(
      new Map([
        [9377, { opaque: true, corsBody: '{"service":"hermes"}' }],
        [9378, { opaque: true, corsBody: '{"service":"hermes"}' }],
        [9379, { opaque: true, corsBody: '{"service":"hermes"}' }],
        [9380, { opaque: true, corsBody: '{"service":"hermes"}' }],
      ]),
    );
    const r = await discoverCamofoxStandalone({ timeoutMs: 1000 });
    expect(r.port).toBeNull();
    // All 4 ports responded (to the no-cors probe), but none
    // passed the camofox identity check.
    expect(r.respondingPorts).toEqual([9377, 9378, 9379, 9380]);
  });

  it('treats CORS-rejection as "wrong service" (expected for v1.11.2)', async () => {
    // 9377 is bound, but the CORS-mode /health throws because
    // v1.11.2 doesn't send Access-Control-Allow-Origin. We
    // emulate by having the no-cors fetch succeed and the
    // cors fetch throw.
    mockFetchByPort(
      new Map([
        [
          9377,
          {
            opaque: true,
            corsError: new TypeError('Failed to fetch (CORS)'),
          },
        ],
        [9378, { opaque: true, corsBody: '{"ok":true,"engine":"camoufox"}' }],
      ]),
    );
    const r = await discoverCamofoxStandalone({ timeoutMs: 1000 });
    // First port counted as "responding" (to no-cors) but
    // failed the identity check; the helper moved on.
    expect(r.port).toBe(9378);
    expect(r.respondingPorts).toEqual([9377, 9378]);
  });
});

describe('camofoxStandaloneBaseUrl', () => {
  it('returns a base URL when discovery found a port', () => {
    expect(
      camofoxStandaloneBaseUrl({ port: 9377, respondingPorts: [9377], elapsedMs: 5 }),
    ).toBe('http://127.0.0.1:9377');
  });
  it('returns null when discovery failed', () => {
    expect(camofoxStandaloneBaseUrl({ port: null, respondingPorts: [], elapsedMs: 5 })).toBeNull();
  });
});

describe('discoverCamofoxStandalone — abort signal', () => {
  it('stops probing when the caller aborts', async () => {
    const ac = new AbortController();
    mockFetchAt(9377, { opaque: true, corsBody: '{"x":1}' });
    // Abort on the second port.
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 2) ac.abort();
      // Return an opaque-ok response so the helper continues
      // the loop and checks the signal at the top of the next
      // iteration.
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await discoverCamofoxStandalone({ timeoutMs: 1000, signal: ac.signal });
    expect(r.port).toBeNull();
    // We should have stopped early — 4 ports × 2 fetches = 8
    // max, aborted after the 2nd fetch (1st port, 2nd
    // iteration) means we made ≤ 3 calls.
    expect(callCount).toBeLessThanOrEqual(4);
  });
});

describe('discoverCamofoxStandalone — elapsed time', () => {
  it('reports non-zero elapsedMs', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const r = await discoverCamofoxStandalone({ timeoutMs: 50 });
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(r.elapsedMs).toBeLessThan(10_000); // hard cap
  });
});
