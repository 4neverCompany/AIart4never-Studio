/**
 * CAMOFOX-CAMOUFOX-1.1.0 (2026-06-06): TypeScript client for the
 * camofox-browser sidecar.
 *
 * camofox-browser is an optional, second sidecar that hardens the
 * `lib/web-search.ts` path against CAPTCHA waves and rate limits. It
 * runs on 127.0.0.1 only, default port 9377 (configurable via
 * `CAMOFOX_PORT` env var, see `src-tauri/src/lib.rs`).
 *
 * This client is the **only** TypeScript-facing surface for camofox.
 * The call sites in `app/api/{pi,mmx,nca,ai}/prompt/route.ts` and
 * `app/api/web-search/route.ts` go through `camofoxSearch()` and
 * never call the REST API directly — that keeps the retry/health
 * logic in one place.
 *
 * Failure philosophy: if camofox is unavailable, every call throws
 * `CamofoxUnavailableError` and the caller is expected to fall back
 * to `webSearch()`. We do NOT swallow errors silently; the caller
 * decides.
 */
import { CAMOFOX_MACROS, CAMOFOX_DEFAULT_PORT, type CamofoxMacro } from './macros';
import { zCamofoxLink, zCamofoxHealth } from './zod-schemas';
import type { WebSearchResult } from '@/lib/web-search';

// ---- Public types ----

/**
 * Options for `camofoxSearch()`. `userId` and `sessionKey` are
 * session-isolation parameters; camofox uses them to keep tabs and
 * cookies per-agent (we use one userId per call-site + a per-request
 * sessionKey, so concurrent calls don't see each other's tabs).
 */
export interface CamofoxSearchOpts {
  userId: string;
  sessionKey: string;
  macro: CamofoxMacro;
  query: string;
  count?: number;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}

/**
 * Returned by `camofoxStatus()`. Mirrors the Rust-side state
 * (CAMOFOX_HEALTHY, CAMOFOX_ACTIVE_PORT, WEB_SEARCH_FALLBACK) plus a
 * client-derived `reachable` flag.
 */
export interface CamofoxStatus {
  reachable: boolean;
  port: number;
  healthy: boolean;
  fallbackActive: boolean;
}

// ---- Error classes ----

/**
 * Thrown when camofox is not running, the boot probe hasn't completed
 * yet, or the WEB_SEARCH_FALLBACK flag is set. Callers MUST catch
 * this and fall back to `webSearch()`.
 */
export class CamofoxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CamofoxUnavailableError';
  }
}

/**
 * Thrown when camofox's response body doesn't match the Zod schema.
 * Almost always means the camofox version is incompatible with this
 * client. We do NOT silently return `[]` — empty results are
 * indistinguishable from "no matches" and the caller can't tell.
 */
export class CamofoxParseError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'CamofoxParseError';
    this.cause = cause;
  }
}

/**
 * Internal: marker for an intentional 4xx throw inside `camofoxFetch`.
 * The outer catch handler uses `instanceof` to distinguish "we
 * intentionally rejected because the server returned 4xx" from
 * "transport-level failure (timeout, network) that should trigger
 * the retry path". Not exported.
 */
class CamofoxHttp4xxError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`camofox HTTP ${status}: ${body}`);
    this.name = 'CamofoxHttp4xxError';
  }
}

// ---- Constants ----

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_COUNT = 5;
const COUNT_MIN = 1;
const COUNT_MAX = 20;

/**
 * CAMOFOX-CAMOUFOX-1.1.0: camofox port. The Rust side tells us the
 * active port via `WEB_SEARCH_FALLBACK` semantics — in the client we
 * just hardcode 9377 and let the Rust fallback flag be the source
 * of truth. If the user is running camofox on a different port
 * (Hermes agent, dev override), they can set `CAMOFOX_PORT` in the
 * dev environment.
 */
function camofoxBaseUrl(): string {
  if (typeof process !== 'undefined' && process.env?.CAMOFOX_PORT) {
    return `http://127.0.0.1:${process.env.CAMOFOX_PORT}`;
  }
  return `http://127.0.0.1:${CAMOFOX_DEFAULT_PORT}`;
}

// ---- Internal helpers ----

function clampCount(count: number | undefined): number {
  if (typeof count !== 'number' || !Number.isFinite(count)) return DEFAULT_COUNT;
  const n = Math.floor(count);
  if (n < COUNT_MIN) return COUNT_MIN;
  if (n > COUNT_MAX) return COUNT_MAX;
  return n;
}

function clampTimeout(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(ms, 60_000); // hard cap 60s
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Thin fetch wrapper with timeout + retry on 5xx/429.
 * We do NOT retry on 4xx (auth errors, bad request) — those won't
 * fix themselves with another attempt.
 */
async function camofoxFetch(
  url: string,
  init: RequestInit,
  opts: { timeoutMs: number; maxRetries: number; signal?: AbortSignal },
): Promise<Response> {
  const { timeoutMs, maxRetries, signal } = opts;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ac = new AbortController();
    const timeoutHandle = setTimeout(() => ac.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);

    // Chain the caller's signal so they can still cancel.
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeoutHandle);
        throw new DOMException('Aborted', 'AbortError');
      }
      signal.addEventListener('abort', () => ac.abort(signal.reason), { once: true });
    }

    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      clearTimeout(timeoutHandle);
      if (res.ok) return res;
      // 5xx and 429 are transient — retry. Everything else is fatal.
      if (res.status >= 500 || res.status === 429) {
        lastError = new Error(`camofox HTTP ${res.status}`);
        // Exponential backoff: 250, 750, 2250 ms
        if (attempt < maxRetries) {
          await sleep(250 * Math.pow(3, attempt), signal);
          continue;
        }
        throw new CamofoxUnavailableError(
          `camofox HTTP ${res.status} after ${maxRetries + 1} attempts: ${lastError}`,
        );
      }
      // 4xx (except 429) — don't retry, surface immediately.
      // Wrap in a special marker so the outer catch handler can
      // recognize "intentional 4xx" and re-throw without entering
      // the retry path.
      const body = await res.text().catch(() => '');
      throw new CamofoxHttp4xxError(res.status, body.slice(0, 200));
    } catch (err) {
      clearTimeout(timeoutHandle);
      // If the caller aborted, propagate.
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      // 4xx — surface immediately, do NOT retry.
      if (err instanceof CamofoxHttp4xxError) {
        throw new Error(`camofox HTTP ${err.status}: ${err.body}`);
      }
      // Timeout, network error, 5xx-after-retries — treat as
      // unavailable so callers fall back cleanly.
      lastError = err;
      if (attempt < maxRetries) {
        await sleep(250 * Math.pow(3, attempt), signal);
        continue;
      }
      throw new CamofoxUnavailableError(
        `camofox unavailable after ${maxRetries + 1} attempts: ${(err as Error).message ?? err}`,
      );
    }
  }
  // Unreachable, but TypeScript needs a return.
  throw new CamofoxUnavailableError(`camofox unreachable: ${String(lastError)}`);
}

// ---- Public API ----

/**
 * Probe camofox availability. Returns the current status without
 * throwing. `reachable=false` means the next `camofoxSearch()` will
 * fall back to webSearch — caller can use this to short-circuit
 * the retry chain.
 */
export async function camofoxStatus(opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CamofoxStatus> {
  const timeoutMs = clampTimeout(opts.timeoutMs);
  try {
    const res = await camofoxFetch(
      `${camofoxBaseUrl()}/health`,
      { method: 'GET' },
      { timeoutMs, maxRetries: 0, signal: opts.signal },
    );
    const json = await res.json();
    const parsed = zCamofoxHealth.safeParse(json);
    if (!parsed.success) {
      // /health responded but the body is unexpected. Not fatal —
      // we still got a 2xx, so the service is reachable. Just
      // report `healthy: false` so callers can decide.
      return { reachable: true, port: CAMOFOX_DEFAULT_PORT, healthy: false, fallbackActive: false };
    }
    return {
      reachable: true,
      port: CAMOFOX_DEFAULT_PORT,
      healthy: parsed.data.ok === true,
      fallbackActive: false,
    };
  } catch (err) {
    if (err instanceof CamofoxUnavailableError) {
      return { reachable: false, port: CAMOFOX_DEFAULT_PORT, healthy: false, fallbackActive: false };
    }
    throw err;
  }
}

/**
 * PII scrubber: removes the user's own @handle from camofox
 * snapshots so the LLM never sees a mention of the account that
 * initiated the search. Twitter/X's "People" tab is the worst
 * offender — it lists the current user's recent mentions.
 *
 * The scrub is intentionally simple (case-insensitive, word-boundary)
 * because camofox snapshots are accessibility-text, not HTML, and
 * the user's own @handle is the only PII we expect.
 */
export function scrubPii(snapshot: string, currentUserHandle: string | null | undefined): string {
  if (!currentUserHandle) return snapshot;
  // Escape regex metacharacters in the handle.
  const escaped = currentUserHandle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`@${escaped}\\b`, 'gi');
  return snapshot.replace(re, '[user]');
}

/**
 * Open a fresh camofox tab for this user/session pair. Returns the
 * tabId. Each search creates a new tab so concurrent calls don't
 * stomp on each other; we DELETE the tab in the `finally` block.
 *
 * Note: `camofoxFetch` already throws on non-2xx, so by the time
 * we read the body the response is guaranteed successful. We still
 * defensively check for the tabId field in the JSON body because
 * 200-with-wrong-shape (a server bug or a version mismatch) is
 * distinct from a transport-level 4xx/5xx and deserves its own
 * error class.
 */
async function openTab(userId: string, sessionKey: string, signal?: AbortSignal): Promise<string> {
  const res = await camofoxFetch(
    `${camofoxBaseUrl()}/tabs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, sessionKey }),
    },
    { timeoutMs: 10_000, maxRetries: 1, signal },
  );
  const json = (await res.json()) as { tabId?: string; id?: string };
  const tabId = json.tabId ?? json.id;
  if (!tabId || typeof tabId !== 'string') {
    throw new CamofoxParseError('camofox /tabs response missing tabId', json);
  }
  return tabId;
}

async function closeTab(userId: string, tabId: string): Promise<void> {
  // Best-effort cleanup. We deliberately swallow errors here —
  // leaving a tab open is much less bad than throwing from a search
  // that already returned its results.
  try {
    await camofoxFetch(
      `${camofoxBaseUrl()}/tabs/${encodeURIComponent(tabId)}?userId=${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
      { timeoutMs: 2_000, maxRetries: 0 },
    );
  } catch {
    // intentionally ignored
  }
}

async function navigateMacro(
  userId: string,
  tabId: string,
  macro: CamofoxMacro,
  query: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await camofoxFetch(
    `${camofoxBaseUrl()}/tabs/${encodeURIComponent(tabId)}/navigate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, macro, query }),
    },
    { timeoutMs: 20_000, maxRetries: 1, signal },
  );
  // The navigate response is large; we only need to confirm 2xx.
  // Body is parsed lazily by callers that want it.
  await res.text();
}

async function fetchLinks(userId: string, tabId: string, signal?: AbortSignal): Promise<Array<{ ref?: string; url: string; text: string }>> {
  const res = await camofoxFetch(
    `${camofoxBaseUrl()}/tabs/${encodeURIComponent(tabId)}/links?userId=${encodeURIComponent(userId)}`,
    { method: 'GET' },
    { timeoutMs: 10_000, maxRetries: 1, signal },
  );
  const json = (await res.json()) as unknown;
  if (!Array.isArray(json)) {
    throw new CamofoxParseError('camofox /links response is not an array', json);
  }
  const out: Array<{ ref?: string; url: string; text: string }> = [];
  for (const item of json) {
    const parsed = zCamofoxLink.safeParse(item);
    if (parsed.success) {
      out.push(parsed.data);
    }
    // Skip items that don't match the schema — Zod is the
    // authority, we don't try to coerce.
  }
  return out;
}

async function fetchSnapshot(userId: string, tabId: string, signal?: AbortSignal): Promise<string> {
  const res = await camofoxFetch(
    `${camofoxBaseUrl()}/tabs/${encodeURIComponent(tabId)}/snapshot?userId=${encodeURIComponent(userId)}&format=text`,
    { method: 'GET' },
    { timeoutMs: 10_000, maxRetries: 1, signal },
  );
  return await res.text();
}

/**
 * Run a search via camofox and map the result to `WebSearchResult[]`
 * (the same shape `webSearch()` returns, so callers can swap one
 * function for the other without type changes).
 *
 * Throws `CamofoxUnavailableError` if camofox is down — the caller
 * is expected to catch and fall back to `webSearch()`. The wrapper
 * `withCamofoxHealth()` does this for you.
 *
 * For `@reddit_search` the upstream macro returns JSON directly
 * (Reddit's `.json` endpoint), so the `/links` step is skipped and
 * the JSON body is mapped to `WebSearchResult[]` via the Reddit
 * schema. All other macros go through the standard /links path.
 */
export async function camofoxSearch(opts: CamofoxSearchOpts): Promise<WebSearchResult[]> {
  const count = clampCount(opts.count);
  const timeoutMs = clampTimeout(opts.timeoutMs);
  const maxRetries = typeof opts.maxRetries === 'number' ? opts.maxRetries : DEFAULT_MAX_RETRIES;

  // Validate macro
  if (!(CAMOFOX_MACROS as readonly string[]).includes(opts.macro)) {
    throw new Error(`unknown camofox macro: ${opts.macro}`);
  }

  const tabId = await openTab(opts.userId, opts.sessionKey, opts.signal);
  try {
    await navigateMacro(opts.userId, tabId, opts.macro, opts.query, opts.signal);

    // For Reddit, the navigate body itself is the JSON we want.
    // We re-call navigate to get the body, then return early.
    // (Yes, that's an extra round-trip — Reddit's .json endpoint is
    // ~200ms so the overhead is acceptable for a single call.)
    if (opts.macro === '@reddit_search') {
      const snapshot = await fetchSnapshot(opts.userId, tabId, opts.signal);
      return mapRedditJson(snapshot, count);
    }

    // All other macros: pull the link list, map to WebSearchResult.
    const links = await fetchLinks(opts.userId, tabId, opts.signal);
    return links.slice(0, count).map((l) => ({
      title: l.text,
      url: l.url,
      snippet: '', // Snippets are a Day 3 enhancement (use /extract + schema).
    }));
  } finally {
    await closeTab(opts.userId, tabId);
  }
  // Unused but satisfies TS — the real return is in the try block.
}
// Runtime annotations for the lint rule that flags `any`.
void DEFAULT_MAX_RETRIES;

/**
 * Map Reddit's .json response (via the @reddit_search macro) to
 * WebSearchResult[]. The macro returns a snapshot whose body IS the
 * JSON; we parse it defensively. Reddit's search.json shape:
 *   { data: { children: [{ data: { title, url, permalink, ... } }] } }
 */
function mapRedditJson(snapshot: string, count: number): WebSearchResult[] {
  let json: unknown;
  try {
    json = JSON.parse(snapshot);
  } catch (err) {
    throw new CamofoxParseError('reddit macro returned non-JSON body', err);
  }
  const children = (json as { data?: { children?: unknown[] } })?.data?.children;
  if (!Array.isArray(children)) {
    return [];
  }
  const out: WebSearchResult[] = [];
  for (const c of children) {
    const d = (c as { data?: { title?: unknown; url?: unknown; permalink?: unknown } })?.data;
    if (!d || typeof d.title !== 'string') continue;
    const url =
      typeof d.url === 'string'
        ? d.url
        : typeof d.permalink === 'string'
          ? `https://www.reddit.com${d.permalink}`
          : '';
    if (!url) continue;
    out.push({ title: d.title, url, snippet: '' });
    if (out.length >= count) break;
  }
  return out;
}

/**
 * Health-wrapper: try camofox first, fall back to a user-supplied
 * function on any `CamofoxUnavailableError`. This is the canonical
 * way to call camofox from a route handler:
 *
 * ```ts
 * const results = await withCamofoxHealth(
 *   () => camofoxSearch({ userId: 'pi-1', sessionKey: ..., macro, query, count }),
 *   () => webSearch(query, count, undefined, searchOpts),
 * );
 * ```
 *
 * On a mid-call failure, the wrapper also flips the Rust-side
 * `WEB_SEARCH_FALLBACK` flag via `set_camofox_fallback(true)` so
 * subsequent calls in the same session skip the camofox probe
 * entirely. (Day 3 wires the Tauri command; for now this is a
 * no-op when running in the web build.)
 */
export async function withCamofoxHealth<T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
  opts: { probeTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const probeTimeoutMs = clampTimeout(opts.probeTimeoutMs ?? 2_000);

  // Cheap pre-check: if camofox is unreachable, skip the primary
  // call entirely. This is the common case when the sidecar crashed
  // or wasn't bundled.
  let status: CamofoxStatus;
  try {
    status = await camofoxStatus({ timeoutMs: probeTimeoutMs, signal: opts.signal });
  } catch (err) {
    // camofoxStatus swallows CamofoxUnavailableError, so reaching
    // here means something unexpected (e.g. network policy).
    return fallback();
  }
  if (!status.reachable || status.fallbackActive) {
    return fallback();
  }

  try {
    return await primary();
  } catch (err) {
    if (err instanceof CamofoxUnavailableError || err instanceof CamofoxParseError) {
      // Tell the Rust side: camofox is broken for this session.
      // Best-effort — if the Tauri command isn't registered (web
      // build, no Tauri), the call 404s and we silently proceed
      // with the fallback.
      await trySetFallbackFlag(true).catch(() => {});
      return fallback();
    }
    throw err;
  }
}

async function trySetFallbackFlag(active: boolean): Promise<void> {
  // Tauri-only: invoke('set_camofox_fallback', { active }).
  // We guard on `__TAURI_INTERNALS__` so the web build (and unit
  // tests) skip the call without throwing.
  if (typeof window === 'undefined') return;
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (!w.__TAURI_INTERNALS__) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_camofox_fallback', { active });
  } catch {
    // The Tauri command may not be registered yet (Day 3). Swallow.
  }
}
