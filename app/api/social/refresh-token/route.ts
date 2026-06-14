// IG-FB-TOKEN-REFRESH: Facebook Page Access Token refresh flow.
//
// Facebook long-lived Page Access Tokens (the EAA-prefixed kind that
// /api/social/post uses for the Instagram Graph API) expire ~60 days
// after issuance. Meta provides a single refresh endpoint that issues
// a fresh 60-day token — there is no separate refresh token, the new
// token just replaces the old one.
//
// Endpoint:
//   GET https://graph.facebook.com/v21.0/oauth/access_token
//     ?grant_type=fb_exchange_token
//     &client_id={app-id}
//     &client_secret={app-secret}
//     &fb_exchange_token={current-long-lived-token}
//
// Response (200):
//   { "access_token": "<new long-lived token>",
//     "token_type":   "bearer",
//     "expires_in":   5183940  (~60 days, seconds) }
//
// Differences from the existing /api/social/instagram-refresh route:
//   - instagram-refresh uses grant_type=ig_refresh_token against
//     graph.instagram.com for Instagram Basic Display user tokens
//     (IGQ/IGAA prefix). It cannot refresh a Page Access Token.
//   - This route uses grant_type=fb_exchange_token against
//     graph.facebook.com for the EAA-prefixed Page Access Token
//     consumed by /api/social/post. The post route explicitly
//     rejects IGQ/IGAA tokens so refresh must happen here.
//
// Storage:
//   This route is stateless — it returns the new token in the
//   response body and lets the caller persist it. The caller
//   (lib/instagram-token-refresh.ts) writes through lib/persistence
//   which lands in tauri-plugin-store on desktop and idb-keyval on
//   web. Persisting server-side would couple the API route to a
//   credential store and create a "stale env var" failure mode
//   identical to the one IG-STALE-FIX solved in /api/social/post.
//
// Auth:
//   The route is protected by the same CRON_SHARED_SECRET used by
//   instagram-refresh and cron-fire, so a stray browser hitting
//   /api/social/refresh-token gets 401. The desktop app passes the
//   secret in an Authorization: Bearer header at startup when it
//   runs the expiry-window check.

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { getErrorMessage } from '@/lib/errors';

export const runtime = 'nodejs';
// 60 days in seconds — refreshes aren't time-critical, so cache
// nothing on this route. (Next.js defaults are fine; this is a
// comment-as-policy marker.)
export const dynamic = 'force-dynamic';

const FB_GRAPH_API_VERSION = 'v21.0';

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

interface FbRefreshResponse {
  access_token: string;
  token_type: string;
  expires_in: number; // seconds — typically ~5183940 (~60 days)
}

interface FbRefreshError {
  error: {
    message: string;
    type: string;
    code: number;
    fbtrace_id?: string;
  };
}

export async function POST(req: Request): Promise<Response> {
  const auth = checkAuth(req);
  if (!auth.ok) return auth.res;

  let body: { accessToken?: string } = {};
  // Body is optional — when omitted, fall back to the server env var
  // so a server-side cron (future follow-up) can refresh without
  // shipping the token through the request body. Browser callers
  // should always pass the current token explicitly.
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

  // Reject non-Page-Access tokens up front. The post route accepts
  // EAA-prefixed tokens; IGQ/IGAA Basic Display tokens cannot be
  // refreshed via fb_exchange_token and would 400 from Facebook
  // with a confusing "Invalid OAuth access token" message. Failing
  // fast here gives the caller a clear actionable error.
  if (!token.startsWith('EAA') && !token.startsWith('EAAJ')) {
    return NextResponse.json(
      {
        error:
          'Token does not look like a Facebook Page Access Token (EAA* prefix required). ' +
          'Use /api/social/instagram-refresh for Instagram Basic Display tokens (IGQ/IGAA).',
      },
      { status: 400 },
    );
  }

  const appId = process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.FACEBOOK_APP_SECRET;
  if (!appId || !appSecret) {
    return NextResponse.json(
      { error: 'FACEBOOK_APP_ID and FACEBOOK_APP_SECRET must be set server-side to refresh Page Access Tokens' },
      { status: 503 },
    );
  }

  const url = new URL(`https://graph.facebook.com/${FB_GRAPH_API_VERSION}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('fb_exchange_token', token);

  let fbRes: Response;
  try {
    fbRes = await fetch(url.toString(), { method: 'GET' });
  } catch (e) {
    return NextResponse.json(
      { error: `Facebook refresh request failed: ${getErrorMessage(e)}` },
      { status: 502 },
    );
  }

  if (!fbRes.ok) {
    let detail = '';
    try {
      const data = (await fbRes.json()) as FbRefreshError;
      detail = data?.error?.message ?? '';
    } catch {
      detail = await fbRes.text().catch(() => '');
    }
    return NextResponse.json(
      { error: `Facebook returned ${fbRes.status}: ${detail || 'no detail'}` },
      { status: 502 },
    );
  }

  let payload: FbRefreshResponse;
  try {
    payload = (await fbRes.json()) as FbRefreshResponse;
  } catch (e) {
    return NextResponse.json(
      { error: `Facebook returned malformed JSON: ${getErrorMessage(e)}` },
      { status: 502 },
    );
  }

  if (!payload.access_token || typeof payload.expires_in !== 'number') {
    return NextResponse.json(
      { error: 'Facebook response missing access_token or expires_in' },
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

// GET is provided as a thin wrapper for the "check and refresh if
// within 7 days" startup probe. The actual expiry-window check lives
// client-side (the token is in tauri-plugin-store / idb-keyval and
// the server doesn't have it). A GET here just runs the same flow
// as POST but with a clearer "I'm a probe" semantic in logs.
export async function GET(req: Request): Promise<Response> {
  return POST(req);
}
