/**
 * GET /api/higgsfield/oauth/callback
 *
 * Completes the OAuth 2.0 + PKCE flow:
 *   1. Verifies the `state` param matches the cookie set by /authorize.
 *   2. Exchanges the authorization `code` for tokens (using the PKCE
 *      verifier from the cookie).
 *   3. Decodes the ID token to extract email / name / org_id.
 *   4. Encrypts the tokens with AES-GCM and stores in IDB via
 *      lib/higgsfield/token-store.
 *   5. Redirects the user to /studio (or wherever they came from) with
 *      a one-time `?higgsfield=connected` query param so the UI can
 *      show a confirmation banner.
 *
 * Errors redirect to /studio?higgsfield=error&reason=... so the UI
 * can surface a non-blocking toast instead of a 500 page.
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { readDesktopConfigValue } from '@/lib/desktop-env';
import {
  decodeJwtPayload,
  exchangeCodeForTokens,
} from '@/lib/higgsfield/oauth';
import { saveTokens } from '@/lib/higgsfield/token-store';
import { getErrorMessage } from '@/lib/errors';

export const runtime = 'nodejs';

const STATE_COOKIE = 'higgsfield-oauth-state';
const PKCE_COOKIE = 'higgsfield-oauth-pkce';

function redirectUriFor(req: Request): string {
  // V1.2.10-OAUTH: when the deep-link listener re-issues the
  // callback in the WebView2 cookie context, it passes
  // `?via=desktop` so we know to send `mashupforge://oauth/callback`
  // in the token exchange (matching the redirect_uri used in
  // /authorize). Without this, the WebView's origin
  // (`tauri://localhost`) is sent instead, Higgsfield returns
  // `invalid_grant`, and the user sees the token_exchange error.
  const url = new URL(req.url);
  if (url.searchParams.get('via') === 'desktop') {
    return 'mashupforge://oauth/callback';
  }
  return `${url.origin}/api/higgsfield/oauth/callback`;
}

function studioRedirect(req: Request, params: Record<string, string>): Response {
  // Default landing is /studio (post-v1.0.1 route). The callback URL
  // might not know the original referrer; the UI can derive the
  // intent from the `higgsfield` query param.
  const url = new URL(req.url);
  url.pathname = '/studio';
  url.search = '';
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return NextResponse.redirect(url);
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');
  const errorDescription = url.searchParams.get('error_description');

  // Provider-side error: redirect with the reason in the query string.
  if (errorParam) {
    return studioRedirect(req, {
      higgsfield: 'error',
      reason: errorParam,
      detail: (errorDescription || '').slice(0, 200),
    });
  }
  if (!code || !state) {
    return studioRedirect(req, {
      higgsfield: 'error',
      reason: 'missing_params',
    });
  }

  const jar = await cookies();
  const cookieState = jar.get(STATE_COOKIE)?.value;
  const cookieVerifier = jar.get(PKCE_COOKIE)?.value;
  if (!cookieState || !cookieVerifier) {
    return studioRedirect(req, {
      higgsfield: 'error',
      reason: 'expired_flow',
    });
  }
  if (cookieState !== state) {
    return studioRedirect(req, {
      higgsfield: 'error',
      reason: 'state_mismatch',
    });
  }

  const clientId = readDesktopConfigValue('HIGGSFIELD_OAUTH_CLIENT_ID');
  if (!clientId) {
    return studioRedirect(req, {
      higgsfield: 'error',
      reason: 'no_client_id',
    });
  }

  try {
    const tokens = await exchangeCodeForTokens({
      clientId,
      code,
      codeVerifier: cookieVerifier,
      redirectUri: redirectUriFor(req),
    });

    // Decode ID token claims for display. Don't fail the flow if the
    // ID token is missing or unparseable — the access token alone is
    // enough to call the MCP server.
    let email: string | undefined;
    let name: string | undefined;
    let orgId: string | undefined;
    if (tokens.id_token) {
      const claims = decodeJwtPayload(tokens.id_token);
      email = claims?.email;
      name = claims?.name;
      orgId = claims?.org_id;
    }

    await saveTokens({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || '',
      accessTokenExpiresAt: tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000
        : 0,
      email,
      orgId,
      name,
    });

    // Clear the short-lived OAuth cookies — the tokens are now in
    // encrypted IDB and these are no longer needed.
    jar.delete(STATE_COOKIE);
    jar.delete(PKCE_COOKIE);

    return studioRedirect(req, { higgsfield: 'connected' });
  } catch (e) {
    return studioRedirect(req, {
      higgsfield: 'error',
      reason: 'token_exchange',
      detail: getErrorMessage(e).slice(0, 200),
    });
  }
}
