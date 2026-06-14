// IG-UPSTASH-FIX: Instagram long-lived token refresh.
//
// Instagram Graph API long-lived tokens expire 60 days after issue.
// Calling GET https://graph.instagram.com/refresh_access_token
//   ?grant_type=ig_refresh_token&access_token={current_long_lived_token}
// returns a NEW long-lived token with a fresh 60-day clock.
//
// Constraints:
//  - The current token must be at least 24 hours old (Instagram rejects
//    refresh on tokens younger than that).
//  - The new token replaces the old one; there's no separate refresh
//    token. Persist the response client-side / in config.json /
//    Vercel env var.
//
// Usage (manual refresh, e.g. via curl):
//   curl -X POST https://your-app.vercel.app/api/social/instagram-refresh \
//        -H "Authorization: Bearer $CRON_SHARED_SECRET" \
//        -H "Content-Type: application/json" \
//        -d '{"accessToken":"EAA..."}'
//
// Body is optional: if omitted, the route uses INSTAGRAM_ACCESS_TOKEN
// from the server env. The response JSON is:
//   { accessToken: "<new long-lived token>",
//     expiresAt:  <Unix ms at which it will expire>,
//     expiresIn:  <seconds, mirrored from IG>,
//     tokenType:  "bearer" }
//
// After refresh, set INSTAGRAM_TOKEN_EXPIRES_AT (Unix ms) on Vercel so
// /api/social/cron-fire can surface a warning when the next 60-day
// window nears expiry. Schedule this route between days 50 and 55 of
// the current token's life.
//
// This route does NOT persist the new token anywhere. The caller is
// responsible for updating their storage (desktop config.json, Vercel
// env var, or browser UserSettings). This keeps the route stateless
// and avoids coupling the server queue to credential storage.

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { getErrorMessage } from '@/lib/errors';

export const runtime = 'nodejs';

function safeEqual(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function checkAuth(req: Request): { ok: true } | { ok: false; res: Response } {
  const expected = process.env.CRON_SHARED_SECRET;
  if (!expected) {
    return {
      ok: false,
      res: NextResponse.json(
        { error: 'CRON_SHARED_SECRET not configured on server' },
        { status: 503 },
      ),
    };
  }
  const header = req.headers.get('authorization') || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!presented || !safeEqual(presented, expected)) {
    return {
      ok: false,
      res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }
  return { ok: true };
}

interface IgRefreshResponse {
  access_token: string;
  token_type: string;
  expires_in: number; // seconds until expiry, ~5184000 (60 days) on success
}

export async function POST(req: Request): Promise<Response> {
  const auth = checkAuth(req);
  if (!auth.ok) return auth.res;

  let body: { accessToken?: string } = {};
  // Body is optional; tolerate empty / non-JSON for the env-only path.
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text) as { accessToken?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const token = body.accessToken ?? process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: 'accessToken not provided in body and INSTAGRAM_ACCESS_TOKEN env unset' },
      { status: 400 },
    );
  }

  const url = new URL('https://graph.instagram.com/refresh_access_token');
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', token);

  let igRes: Response;
  try {
    igRes = await fetch(url.toString(), { method: 'GET' });
  } catch (e) {
    return NextResponse.json(
      { error: `Instagram refresh request failed: ${getErrorMessage(e)}` },
      { status: 502 },
    );
  }

  if (!igRes.ok) {
    let detail = '';
    try {
      const data = (await igRes.json()) as { error?: { message?: string } } | undefined;
      detail = data?.error?.message ?? '';
    } catch {
      detail = await igRes.text().catch(() => '');
    }
    return NextResponse.json(
      { error: `Instagram returned ${igRes.status}: ${detail || 'no detail'}` },
      { status: 502 },
    );
  }

  let payload: IgRefreshResponse;
  try {
    payload = (await igRes.json()) as IgRefreshResponse;
  } catch (e) {
    return NextResponse.json(
      { error: `Instagram returned malformed JSON: ${getErrorMessage(e)}` },
      { status: 502 },
    );
  }

  if (!payload.access_token || typeof payload.expires_in !== 'number') {
    return NextResponse.json(
      { error: 'Instagram response missing access_token or expires_in' },
      { status: 502 },
    );
  }

  const expiresAt = Date.now() + payload.expires_in * 1000;
  return NextResponse.json({
    accessToken: payload.access_token,
    tokenType: payload.token_type,
    expiresIn: payload.expires_in,
    expiresAt,
  });
}
