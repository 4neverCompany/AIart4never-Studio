import { NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/errors';
import {
  startConnectorOAuth,
  encodeFlowState,
  buildSetFlowCookie,
  deriveOrigin,
  redirectUriFor,
  OAuthServerFlowError,
} from '@/lib/mcp/oauth-server';

/**
 * SERVER-SIDE start of the MCP OAuth flow — fixes the live CORS bug.
 *
 * WHY THIS EXISTS: the OAuth handshake against an MCP server (Higgsfield etc.)
 * needs several cross-origin HTTP fetches (RFC 9728 / 8414 discovery, RFC 7591
 * dynamic client registration, the token exchange). MCP / auth servers send no
 * CORS headers for browser origins, so running ANY of them in the browser fails
 * with "Failed to fetch" — the exact bug that broke "Authorize Higgsfield".
 * Only the `authorize` redirect is a real browser navigation (CORS-immune). So
 * this route runs discovery + DCR + PKCE SERVER-SIDE (Node runtime, no CORS) and
 * hands the browser back ONLY an `authorizeUrl` to navigate to.
 *
 * Request shape:
 *   { connectorUrl: string }   // the MCP server URL to authorize
 *
 * Response (success, 200):
 *   { authorizeUrl: string }
 *   + Set-Cookie: m4n_mcp_oauth_flow=<base64url>   (httpOnly, SameSite=Lax,
 *     Secure on https, Path=/api/mcp/oauth, Max-Age=600) — carries the PKCE
 *     verifier + DCR client creds + CSRF state across the redirect round-trip.
 *
 * Response (failure):
 *   { error: string, code: string }
 *   - missing/invalid connectorUrl → 400
 *   - discovery / DCR / authorize-build failure → 502 (upstream auth-server fault)
 *   - anything else → 500
 *
 * The redirect_uri is derived from THIS request's origin/host (web vs desktop)
 * so it matches the value the callback reproduces and the value DCR registered.
 * SECRETS (codeVerifier / clientSecret) live ONLY in the httpOnly cookie — they
 * are never placed in the response body.
 */
export const runtime = 'nodejs';

interface StartBody {
  connectorUrl?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  let body: StartBody;
  try {
    body = (await req.json()) as StartBody;
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body', code: 'bad-request' },
      { status: 400 },
    );
  }

  const connectorUrl = body.connectorUrl;
  if (typeof connectorUrl !== 'string' || connectorUrl.trim() === '') {
    return NextResponse.json(
      { error: 'connectorUrl is required', code: 'bad-request' },
      { status: 400 },
    );
  }

  const { origin, secure } = deriveOrigin(req.headers);
  const redirectUri = redirectUriFor(origin);

  try {
    const { authorizeUrl, flowState } = await startConnectorOAuth(
      connectorUrl.trim(),
      redirectUri,
    );

    const res = NextResponse.json({ authorizeUrl });
    res.headers.set('Set-Cookie', buildSetFlowCookie(encodeFlowState(flowState), secure));
    return res;
  } catch (e) {
    const message = getErrorMessage(e) || 'failed to start OAuth flow';
    // A bad URL surfaced by the lib is the operator's fault → 400; discovery /
    // DCR / authorize-build problems are upstream → 502; anything else → 500.
    const status =
      e instanceof OAuthServerFlowError && /invalid connector url/i.test(message)
        ? 400
        : e instanceof OAuthServerFlowError
          ? 502
          : 500;
    const code =
      status === 400 ? 'bad-request' : status === 502 ? 'oauth-start-failed' : 'error';
    return NextResponse.json({ error: message, code }, { status });
  }
}
