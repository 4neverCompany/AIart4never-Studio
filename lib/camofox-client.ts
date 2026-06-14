/**
 * V1.1.3-ORCH (2026-06-07): Browser-side escape hatch for the
 * hybrid trending path.
 *
 * `clientSideCamofoxSearch` lets the WebView call camofox directly,
 * bypassing the Next.js Server-Side /api/trending route when that
 * route has determined it cannot reach camofox itself (e.g. port
 * CORS mismatch on the Vercel-Web build).
 *
 * Two transport paths, picked at runtime:
 *
 *   1. **Tauri build.** When `window.__TAURI_INTERNALS__` is set
 *      (Tauri 2's runtime marker), we use the `camofox_search` Rust
 *      command registered in `src-tauri/src/lib.rs`. The command
 *      does the full open-tab / navigate / /links / close-tab dance
 *      and returns `WebSearchResult[]`.
 *
 *   2. **Web build (Vercel or dev).** No Tauri runtime available, so
 *      we fall back to a direct fetch probe of `127.0.0.1:9377`,
 *      `9378`, `9379`, `9380` (the same 4-port list the Rust boot
 *      probe uses, kept in sync via the test in
 *      `tests/lib/camofox/standalone-discovery.test.ts`). The first
 *      port that answers `/health` wins.
 *
 * Failure philosophy: the caller is `lib/trending-client.ts`, which
 * is on the user-facing pipeline. We NEVER throw — every error
 * path (Tauri command missing, all 4 ports unreachable, response
 * parse failure) collapses to `[]`. An empty result is far less
 * disruptive than a 500 to the studio.
 */
import type { WebSearchResult } from '@/lib/web-search';
import {
  CAMOFOX_STANDALONE_PORTS,
  discoverCamofoxStandalone,
} from '@/lib/camofox/standalone-discovery';

/** Options for `clientSideCamofoxSearch`. Mirrors the macro+query+count
 *  surface of the Rust Tauri command, so the same call site works
 *  against both transports. */
export interface ClientSideCamofoxSearchOpts {
  /** The camofox macro to use (e.g. `'@google_search'`). */
  macro: string;
  /** The search query string. */
  query: string;
  /** Result count. Clamped to 1..=20 to match the Rust side. */
  count?: number;
  /** Optional per-port probe timeout, ms. Default 2000. */
  timeoutMs?: number;
  /** Optional AbortSignal so the caller can cancel a slow probe. */
  signal?: AbortSignal;
}

const DEFAULT_COUNT = 8;
const DEFAULT_TIMEOUT_MS = 2_000;
const COUNT_MIN = 1;
const COUNT_MAX = 20;

/** Shape of the Tauri `__TAURI_INTERNALS__` global. */
interface TauriInternals {
  __TAURI_INTERNALS__?: unknown;
}

function isTauriWebView(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as TauriInternals;
  return Boolean(w.__TAURI_INTERNALS__);
}

function clampCount(count: number | undefined): number {
  if (typeof count !== 'number' || !Number.isFinite(count)) return DEFAULT_COUNT;
  const n = Math.floor(count);
  if (n < COUNT_MIN) return COUNT_MIN;
  if (n > COUNT_MAX) return COUNT_MAX;
  return n;
}

function clampTimeout(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(ms, 8_000);
}

/**
 * Search camofox from the browser, with automatic transport
 * selection (Tauri command vs. direct fetch probe). NEVER throws —
 * always resolves to `WebSearchResult[]`. On any failure path the
 * function returns `[]` and logs a one-line warning to the
 * console for diagnostics.
 */
export async function clientSideCamofoxSearch(
  opts: ClientSideCamofoxSearchOpts,
): Promise<WebSearchResult[]> {
  const count = clampCount(opts.count);
  const timeoutMs = clampTimeout(opts.timeoutMs);
  const macro = String(opts.macro ?? '').trim();
  const query = String(opts.query ?? '').trim();
  if (!macro || !query) return [];

  try {
    if (isTauriWebView()) {
      return await searchViaTauri(macro, query, count, opts.signal);
    }
    return await searchViaDirectFetch(macro, query, count, timeoutMs, opts.signal);
  } catch (err) {
    // Belt-and-braces: every internal branch already swallows its
    // own errors, but a top-level catch makes the contract
    // bulletproof for the caller.
    if (typeof console !== 'undefined') {
      console.warn(
        `[camofox-client] search failed (macro=${macro}, query=${query.slice(0, 40)}):`,
        (err as Error)?.message ?? err,
      );
    }
    return [];
  }
}

/** Tauri transport: dynamic-import `@tauri-apps/api/core` so this
 *  module is safe to import in the web build (where the package
 *  resolves to a stub or doesn't exist). */
async function searchViaTauri(
  macro: string,
  query: string,
  count: number,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  // We don't await the dynamic import at module scope to keep the
  // helper cheap in the common case (web build, no Tauri).
  let invokeFn: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
  try {
    const mod = (await import('@tauri-apps/api/core')) as {
      invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
    };
    invokeFn = mod.invoke;
  } catch {
    // @tauri-apps/api/core missing — treat as no-Tauri.
    return [];
  }

  if (signal?.aborted) return [];
  try {
    const raw = (await invokeFn('camofox_search', {
      macroName: macro,
      query,
      count,
    })) as unknown;
    if (!Array.isArray(raw)) return [];
    const out: WebSearchResult[] = [];
    for (const item of raw) {
      if (
        item &&
        typeof item === 'object' &&
        typeof (item as { title?: unknown }).title === 'string' &&
        typeof (item as { url?: unknown }).url === 'string'
      ) {
        out.push({
          title: (item as { title: string }).title,
          url: (item as { url: string }).url,
          snippet: typeof (item as { snippet?: unknown }).snippet === 'string'
            ? (item as { snippet: string }).snippet
            : '',
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Direct-fetch transport: probe 4 ports, hit the first reachable
 *  one with a small ad-hoc navigate/links flow.
 *
 *  We don't reuse the full TS `camofoxSearch()` helper here because
 *  that requires `userId` + `sessionKey` (camofox-server enforces
 *  per-session tab isolation) and a multi-step tab lifecycle. The
 *  Server-Side route is what gives us the right userId/sessionKey;
 *  for the client-side fallback we use a per-process anonymous
 *  pair, which is fine for the "give me some signal" use case the
 *  hybrid path is built around. */
async function searchViaDirectFetch(
  macro: string,
  query: string,
  count: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  if (signal?.aborted) return [];
  const discovery = await discoverCamofoxStandalone({
    timeoutMs,
    signal,
  }).catch(() => ({ port: null, respondingPorts: [], elapsedMs: 0 }));
  const port = discovery.port;
  if (port === null) {
    // Probe the remaining ports (in case the standalone-discovery
    // helper's camofox-identity check is too strict and we have a
    // camofox instance behind a non-standard body). Direct /tabs is
    // the cheapest call we can make.
    for (const candidatePort of CAMOFOX_STANDALONE_PORTS) {
      if (signal?.aborted) return [];
      const baseUrl = `http://127.0.0.1:${candidatePort}`;
      const tabId = await tryOpenTab(baseUrl, timeoutMs, signal);
      if (tabId) {
        const results = await trySearch(
          baseUrl,
          tabId,
          macro,
          query,
          count,
          timeoutMs,
          signal,
        );
        if (results.length > 0) return results;
      }
    }
    return [];
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  const tabId = await tryOpenTab(baseUrl, timeoutMs, signal);
  if (!tabId) return [];
  return await trySearch(baseUrl, tabId, macro, query, count, timeoutMs, signal);
}

async function tryOpenTab(
  baseUrl: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        return null;
      }
      signal.addEventListener('abort', () => ac.abort(signal.reason), { once: true });
    }
    const userId = 'web-camofox-client';
    const sessionKey = `s-${Date.now()}`;
    const res = await fetch(`${baseUrl}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, sessionKey }),
      signal: ac.signal,
      cache: 'no-store',
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as
      | { tabId?: string; id?: string }
      | null;
    return body?.tabId ?? body?.id ?? null;
  } catch {
    return null;
  }
}

async function trySearch(
  baseUrl: string,
  tabId: string,
  macro: string,
  query: string,
  count: number,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  userId = 'web-camofox-client',
): Promise<WebSearchResult[]> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        return [];
      }
      signal.addEventListener('abort', () => ac.abort(signal.reason), { once: true });
    }
    // Navigate.
    const navRes = await fetch(
      `${baseUrl}/tabs/${encodeURIComponent(tabId)}/navigate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, macro, query }),
        signal: ac.signal,
        cache: 'no-store',
      },
    );
    if (!navRes.ok) {
      clearTimeout(t);
      // Best-effort close.
      void closeTab(baseUrl, tabId, userId);
      return [];
    }
    // /links.
    const linksRes = await fetch(
      `${baseUrl}/tabs/${encodeURIComponent(tabId)}/links?userId=${encodeURIComponent(userId)}`,
      { method: 'GET', signal: ac.signal, cache: 'no-store' },
    );
    clearTimeout(t);
    if (!linksRes.ok) {
      void closeTab(baseUrl, tabId, userId);
      return [];
    }
    const links = (await linksRes.json().catch(() => [])) as Array<{
      url?: string;
      text?: string;
    }>;
    // Best-effort close.
    void closeTab(baseUrl, tabId, userId);
    if (!Array.isArray(links)) return [];
    const out: WebSearchResult[] = [];
    for (const l of links) {
      if (typeof l?.url === 'string' && l.url) {
        out.push({
          title: typeof l.text === 'string' ? l.text : '',
          url: l.url,
          snippet: '',
        });
        if (out.length >= count) break;
      }
    }
    return out;
  } catch {
    void closeTab(baseUrl, tabId, userId);
    return [];
  }
}

function closeTab(baseUrl: string, tabId: string, userId: string): Promise<void> {
  return fetch(
    `${baseUrl}/tabs/${encodeURIComponent(tabId)}?userId=${encodeURIComponent(userId)}`,
    { method: 'DELETE', cache: 'no-store' },
  ).then(() => undefined).catch(() => undefined);
}
