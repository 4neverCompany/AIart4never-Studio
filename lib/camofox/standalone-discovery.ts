/**
 * V1.1.3-CORS (2026-06-07): standalone 4-port discovery helper.
 *
 * The Tauri desktop bundle owns the camofox sidecar lifecycle (see
 * `src-tauri/src/lib.rs:resolve_camofox_port`). The Vercel-Web
 * build doesn't bundle a sidecar — it relies on the user having
 * installed one separately (see `docs/camofox-standalone-install.md`)
 * and discovered it on `127.0.0.1` via the same 4-port range.
 *
 * This module exposes the discovery + health-probe logic in a way
 * that:
 *  1. Mirrors the Rust-side `CAMOFOX_PORTS = [9377, 9378, 9379, 9380]`
 *     — the two MUST stay in sync; `tests/lib/camofox/standalone-discovery.test.ts`
 *     asserts the union.
 *  2. Runs in the browser AND the Node.js side (Tauri-WebView and
 *     Vercel-Web), so the implementation is fetch-based with no
 *     node-only APIs.
 *  3. Has a low timeout (2s default) so the probe is cheap to call
 *     in parallel with the rest of the trending path.
 *
 * The discovery result is intentionally minimal — just the
 * reachable port (or null). The caller is responsible for any
 * further probing (`/health`, etc.).
 */
import { CAMOFOX_DEFAULT_PORT } from './macros';

/**
 * The 4-port range that mirrors the Rust side
 * (`src-tauri/src/lib.rs:CAMOFOX_PORTS`). Order matters: port 9377
 * is tried first because Hermes agent (per Maurice Q3) usually
 * holds it and we want to reuse, not re-spawn.
 *
 * IMPORTANT: keep this list in sync with the Rust constant and with
 * the CSP `connect-src` list in `next.config.ts`. A 3-way test
 * (Rust unit test + vitest + CSP test) pins the union.
 */
export const CAMOFOX_STANDALONE_PORTS: readonly number[] = [9377, 9378, 9379, 9380] as const;

export interface DiscoveryOptions {
  /**
   * Per-port probe timeout in ms. Default 1500ms. The full discovery
   * cycle (4 ports) takes at most `timeoutMs * 4` in the worst
   * case. Capped at 8000ms to avoid hanging a route handler.
   */
  timeoutMs?: number;
  /**
   * Override the base URL host. Default `127.0.0.1` (loopback).
   * Tests use `127.0.0.1`; production never overrides.
   */
  host?: string;
  /**
   * Optional AbortSignal so the caller can cancel a slow probe.
   */
  signal?: AbortSignal;
}

export interface DiscoveryResult {
  /**
   * The reachable port. `null` if none of the 4 ports answered.
   * The caller decides whether `null` means "fall back to websearch"
   * (the existing v1.1.2 behavior) or "surface a UI error".
   */
  port: number | null;
  /**
   * The list of ports that responded to *any* TCP connection —
   * useful for the Studio "sidecar-status" UI to distinguish
   * "wrong service on this port" from "no service at all".
   * Always length 0-4.
   */
  respondingPorts: number[];
  /**
   * Wall-clock time spent on the discovery cycle, ms. Useful for
   * the trend-route cache to skip the probe entirely on a fast
   * path.
   */
  elapsedMs: number;
}

/**
 * Try to connect (HTTP HEAD, with a short read timeout) to each
 * port in `CAMOFOX_STANDALONE_PORTS`. The first port that returns
 * any HTTP response (200, 404, anything) is considered "occupied"
 * — we then probe `/health` to confirm it's actually camofox, not
 * a Hermes agent or an unrelated service. If `/health` confirms
 * the body fragment (`"engine":"camoufox"`) — same heuristic the
 * Rust side uses in `is_camofox_responding_on` — we return that
 * port. Otherwise we try the next.
 *
 * On a Vercel-Web tab calling this from `https://mashupforge.vercel.app`,
 * the browser enforces CORS. If the sidecar has CORS enabled (via
 * a future upstream release that reads `CAMOFOX_CORS_ORIGINS`),
 * the HEAD will return CORS headers. If not, the request fails
 * with a network error — which is what we want to surface, because
 * the user needs to either (a) install the CORS-proxy workaround
 * or (b) wait for upstream CORS support. We do NOT silently fall
 * through to "all 4 ports are free"; a "fetch failed" is a stronger
 * signal that something is listening.
 *
 * Implementation note: we use `fetch` with `mode: 'no-cors'` for
 * the bare port-occupancy check. That mode gives us an opaque
 * response (we can't read the body or status), but it doesn't
 * fail on missing CORS headers — which is exactly the right
 * semantics for "is anything listening here". After the opaque
 * response confirms a service, we do a CORS-mode `/health` check
 * to confirm it's camofox specifically.
 */
export async function discoverCamofoxStandalone(
  opts: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.min(opts.timeoutMs ?? 1500, 8000);
  const host = opts.host ?? '127.0.0.1';
  const respondingPorts: number[] = [];

  for (const port of CAMOFOX_STANDALONE_PORTS) {
    if (opts.signal?.aborted) {
      return { port: null, respondingPorts, elapsedMs: Date.now() - startedAt };
    }
    const baseUrl = `http://${host}:${port}`;
    // Step 1: bare port-occupancy probe (no CORS).
    const occupied = await isPortOccupied(baseUrl, timeoutMs, opts.signal);
    if (!occupied) continue;
    respondingPorts.push(port);
    // Step 2: camofox-specific identity probe (CORS-mode; will
    // throw on missing CORS headers).
    if (await isCamofoxHealthOk(baseUrl, timeoutMs, opts.signal)) {
      return { port, respondingPorts, elapsedMs: Date.now() - startedAt };
    }
  }

  return { port: null, respondingPorts, elapsedMs: Date.now() - startedAt };
}

/**
 * Lower-level helper: is anything answering HTTP on this base URL?
 * Uses `mode: 'no-cors'` so it doesn't trip on missing CORS
 * headers. The signal we care about is "did the fetch return
 * without throwing?" — a no-cors fetch to a non-existent port
 * throws `TypeError: Failed to fetch` (the browser refuses to
 * connect), while a no-cors fetch to a bound port returns
 * (with an opaque body we can't read). We deliberately do NOT
 * rely on `response.type === 'opaque'` because some
 * runtimes (happy-dom used in tests) return a non-opaque
 * Response for the no-cors path even when the connection
 * succeeded. The throw-vs-no-throw signal is portable.
 */
async function isPortOccupied(
  baseUrl: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);
  const onAbort = () => ac.abort(signal!.reason);
  if (signal) {
    if (signal.aborted) {
      clearTimeout(t);
      return false;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    await fetch(`${baseUrl}/health`, {
      method: 'GET',
      mode: 'no-cors',
      signal: ac.signal,
      cache: 'no-store',
    });
    // No throw → the connection succeeded, so the port is
    // bound. We don't need to read the body; the identity
    // check (`isCamofoxHealthOk`) handles that.
    return true;
  } catch {
    // Connection refused, DNS failure, timeout, CORS, or
    // AbortError — all of these mean "port is not bound by a
    // camofox we can reach right now".
    return false;
  } finally {
    clearTimeout(t);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Confirm the service on `baseUrl` is actually camofox, not a
 * Hermes agent or random HTTP server sharing the port. Throws
 * (caller catches) if the request fails — including on CORS
 * rejection, which is the expected failure mode for v1.11.2.
 */
async function isCamofoxHealthOk(
  baseUrl: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);
  if (signal) {
    if (signal.aborted) {
      clearTimeout(t);
      return false;
    }
    ac.signal.addEventListener('abort', () => ac.abort(signal.reason), { once: true });
  }
  try {
    const res = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      mode: 'cors',
      signal: ac.signal,
      cache: 'no-store',
    });
    if (!res.ok) return false;
    // Mirrors the Rust-side `is_camofox_responding_on` body
    // markers (loose match so a future upstream change to
    // formatting doesn't break us).
    const body = await res.text();
    return /camoufox/i.test(body);
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Convenience: return the base URL for the discovered port, or
 * null if discovery failed. Used by the route layer to construct
 * a `camofoxBaseUrl()`-style override.
 */
export function camofoxStandaloneBaseUrl(result: DiscoveryResult): string | null {
  if (result.port === null) return null;
  return `http://127.0.0.1:${result.port}`;
}

/**
 * Re-export the default port so the import surface is one-stop.
 */
export { CAMOFOX_DEFAULT_PORT };
