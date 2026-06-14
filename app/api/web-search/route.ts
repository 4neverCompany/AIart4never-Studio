import { NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/errors';
import {
  validateQuery,
  clampCount,
  webSearchBrave,
  webSearchDdg,
  type WebSearchProvider,
  type WebSearchResult,
} from '@/lib/web-search';
// CAMOFOX-CAMOUFOX-1.1.0 (2026-06-06): camofox sidecar for the
// /api/web-search endpoint. We try camofox first, fall back to
// Brave (if configured) then DDG. Serverless-guard and rate-limit
// token bucket stay in place. The Brave/DDG path remains the
// ultimate fallback for environments where camofox isn't bundled
// (e.g. Vercel preview).
import { withCamofoxHealth } from '@/lib/camofox';

export const runtime = 'nodejs';

/**
 * Free web search via DuckDuckGo HTML scrape. Desktop-only — the sidecar
 * binds to 127.0.0.1 inside the Tauri shell, so there's no public attack
 * surface in practice, but we still guard explicitly against serverless
 * deployments so a misconfigured Vercel preview can't turn this into an
 * open DDG proxy.
 *
 * Rate limit: 2 req/s (token bucket, process-wide). DDG will serve a
 * CAPTCHA page if we hammer it, and the single-user desktop app has no
 * legitimate reason to exceed this.
 *
 * Inputs: { query: string (≤200 chars), count?: number (1–20, default 5) }.
 * Output: { results: [{ title, url, snippet }, ...] }.
 * On upstream failure, returns 200 with an empty results array — this
 * endpoint feeds optional AI enrichment, not a user-visible search UI.
 */

function isServerless(): boolean {
  return Boolean(
    process.env.VERCEL ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.NETLIFY ||
      process.env.CF_PAGES,
  );
}

// Token bucket: capacity 2, refill 2/sec → steady-state 2 req/s with a
// 2-request burst tolerance. State lives in module scope, which in Next's
// nodejs runtime means per-process — fine for the single-user desktop shell.
const BUCKET_CAPACITY = 2;
const REFILL_PER_SEC = 2;
let tokens = BUCKET_CAPACITY;
let lastRefill = Date.now();

function takeToken(): boolean {
  const now = Date.now();
  const elapsed = (now - lastRefill) / 1000;
  if (elapsed > 0) {
    tokens = Math.min(BUCKET_CAPACITY, tokens + elapsed * REFILL_PER_SEC);
    lastRefill = now;
  }
  if (tokens >= 1) {
    tokens -= 1;
    return true;
  }
  return false;
}

export async function POST(req: Request) {
  if (isServerless()) {
    return NextResponse.json(
      { error: 'Web search is desktop-only.' },
      { status: 503 },
    );
  }

  if (!takeToken()) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again in a moment.' },
      { status: 429 },
    );
  }

  let body: { query?: unknown; count?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const query = validateQuery(body.query);
  if (!query) {
    return NextResponse.json(
      { error: 'query must be a non-empty string ≤200 chars.' },
      { status: 400 },
    );
  }

  const count = clampCount(typeof body.count === 'number' ? body.count : undefined);

  // CAMOFOX-CAMOUFOX-1.1.0 (2026-06-06): try the camofox sidecar
  // first, fall back to Brave (if configured) then DDG. The
  // `provider` field reports which path actually served the
  // response so the caller / UI can reason about result quality.
  // Brave stays as the secondary fallback (per master plan §4,
  // call-site #5) — it gives the user a backup when camofox is
  // down and the sidecar isn't reachable.
  const braveKey = (process.env.BRAVE_API_KEY ?? '').trim();
  try {
    let provider: WebSearchProvider = 'ddg';
    const results = await withCamofoxHealth<WebSearchResult[]>(
      () =>
        import('@/lib/camofox').then((m) =>
          m.camofoxSearch({
            userId: 'web-search-route',
            sessionKey: `ws-${Date.now()}`,
            macro: '@google_search',
            query,
            count,
          }),
        ),
      async () => {
        // Brave → DDG fallback chain (preserves the original
        // v1.0.x behavior for environments without camofox).
        if (braveKey) {
          const brave = await webSearchBrave(query, count, braveKey);
          if (brave.length > 0) {
            provider = 'brave';
            return brave;
          }
        }
        provider = 'ddg';
        return await webSearchDdg(query, count);
      },
    );
    return NextResponse.json({ results, provider });
  } catch (e: unknown) {
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
