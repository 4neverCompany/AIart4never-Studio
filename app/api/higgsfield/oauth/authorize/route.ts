/**
 * GET /api/higgsfield/oauth/authorize
 *
 * Starts the OAuth 2.0 + PKCE flow against the Higgsfield MCP server.
 * Generates a PKCE pair, optionally registers a fresh OAuth client
 * (if HIGGSFIELD_OAUTH_CLIENT_ID is not set in config.json), persists
 * the verifier in an HttpOnly cookie, and redirects the user to the
 * Higgsfield authorize endpoint.
 *
 * The state cookie is the standard CSRF-defense pattern: the
 * authorize request sets `state=...`, the callback verifies the
 * same state is echoed back. We tie the state to the PKCE verifier
 * so a state leak without the verifier is useless.
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { randomBytes } from 'node:crypto';
import { readDesktopConfigValue } from '@/lib/desktop-env';
import { DESKTOP_CONFIG_KEYS } from '@/lib/desktop-config-keys';
import {
  buildAuthorizeUrl,
  generatePkcePair,
  registerOAuthClient,
} from '@/lib/higgsfield/oauth';
import { getErrorMessage } from '@/lib/errors';

export const runtime = 'nodejs';

const STATE_COOKIE = 'higgsfield-oauth-state';
const PKCE_COOKIE = 'higgsfield-oauth-pkce';

function redirectUriFor(req: Request): string {
  // V107.1-OAUTH: when the request comes from the Tauri desktop app
  // (detected via ?via=desktop query param from HiggsfieldConnection),
  // return a `mashupforge://` custom-scheme URI. The OS routes that
  // back into the Tauri webview where the state/PKCE cookies were
  // set in step 3 below, instead of into the system browser (which
  // has a different cookie jar and would surface `expired_flow`).
  const url = new URL(req.url);
  if (url.searchParams.get('via') === 'desktop') {
    return 'mashupforge://oauth/callback';
  }
  // For web, use the request's own origin so dev / preview / prod
  // each get the right callback.
  return `${url.origin}/api/higgsfield/oauth/callback`;
}

async function getOrCreateClientId(): Promise<string> {
  const existing = readDesktopConfigValue('HIGGSFIELD_OAUTH_CLIENT_ID');
  if (existing && existing.trim().length > 0) return existing.trim();

  // Register a fresh public client with BOTH redirect URIs so the same
  // client_id can be reused for web and desktop flows. Registering
  // again would return a new client_id and orphan existing refresh
  // tokens, so we keep a static allowlist of known-good URIs.
  const reg = await registerOAuthClient({
    redirectUris: [
      'mashupforge://oauth/callback',
      // Web origins. We can't know every preview URL at runtime, so
      // we register a couple of well-known production hosts. The
      // /authorize route can still send any origin in the
      // redirect_uri param as long as the registered allowlist
      // contains it; some OAuth providers require exact match.
      'https://mashupforge.vercel.app/api/higgsfield/oauth/callback',
      'https://mashup-studio.vercel.app/api/higgsfield/oauth/callback',
    ],
    clientName: 'MashupForge',
  });
  // The desktop-config PATCH endpoint is the canonical way to write
  // a key; on SSR we can call into the same module. We import lazily
  // to keep the route file's blast radius small.
  const { writeDesktopConfigValue } = await import('@/lib/desktop-env');
  writeDesktopConfigValue('HIGGSFIELD_OAUTH_CLIENT_ID', reg.client_id);
  return reg.client_id;
}

export async function GET(req: Request): Promise<Response> {
  const redirectUri = redirectUriFor(req);

  let clientId: string;
  try {
    clientId = await getOrCreateClientId();
  } catch (e) {
    return NextResponse.json(
      { error: `OAuth client registration failed: ${getErrorMessage(e)}` },
      { status: 502 },
    );
  }

  const { verifier, challenge } = generatePkcePair();
  const state = randomBytes(24).toString('base64url');

  const jar = await cookies();
  // State cookie: HttpOnly so JS can't read it; SameSite=Lax so it
  // survives the cross-origin redirect; Max-Age=600 (10 minutes —
  // OAuth round-trips should be near-instant, anything longer is a
  // stuck flow we want to clear).
  jar.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 600,
  });
  jar.set(PKCE_COOKIE, verifier, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 600,
  });

  // Touch DESKTOP_CONFIG_KEYS so the import isn't dead-code-eliminated
  // in production builds (it documents the new HIGGSFIELD_OAUTH_CLIENT_ID
  // field, and we want a TS error if the field ever drifts).
  void DESKTOP_CONFIG_KEYS;

  const url = buildAuthorizeUrl({
    clientId,
    redirectUri,
    state,
    codeChallenge: challenge,
  });

  // V1.2.8: when the caller asks for JSON, return the final
  // authorize URL as a JSON body instead of a 302 redirect. The
  // Tauri desktop app needs this so the frontend can hand the
  // URL to `tauri-plugin-opener`'s `openUrl()` and open the
  // OAuth consent page in the user's system browser. The
  // 302 default is kept for the web build, where the in-app
  // navigation is the right behaviour.
  const wantsJson = new URL(req.url).searchParams.get('format') === 'json';
  if (wantsJson) {
    return NextResponse.json({ url, state }, { status: 200 });
  }
  return NextResponse.redirect(url);
}
