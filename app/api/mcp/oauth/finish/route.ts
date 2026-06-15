import { NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/errors';
import {
  finishConnectorOAuth,
  decodeFlowState,
  readCookie,
  buildClearFlowCookie,
  deriveOrigin,
  OAUTH_FLOW_COOKIE,
  OAuthServerFlowError,
} from '@/lib/mcp/oauth-server';

/**
 * SERVER-SIDE finish of the MCP OAuth flow — the token exchange.
 *
 * The callback page lands on `/mcp/oauth/callback` with `?code` / `?state`,
 * then POSTs `{ code, state }` here. This route reads the httpOnly flow cookie
 * set by `/api/mcp/oauth/start`, validates the CSRF `state`, and exchanges the
 * code for tokens at the token endpoint SERVER-SIDE (the token exchange is a
 * cross-origin fetch the browser cannot make — CORS). On success it CLEARS the
 * cookie and returns the tokens + the connector URL + the DCR client info so the
 * browser can fold them into the connector config and run the existing FR-22
 * install pipeline.
 *
 * Request shape:
 *   { code: string, state?: string }
 *
 * Response (success, 200):
 *   {
 *     tokens: { accessToken, refreshToken?, expiresAt?, scope? },
 *     connectorUrl: string,
 *     clientInformation: { clientId, clientSecret? },
 *   }
 *   + Set-Cookie: m4n_mcp_oauth_flow=; Max-Age=0   (clears the flow cookie)
 *
 * Response (failure):
 *   { error: string, code: string }
 *   - missing code / missing-or-corrupt flow cookie → 400 (`no-flow`)
 *   - state mismatch (CSRF) / expired flow → 400 (`state-mismatch`)
 *   - token exchange failure → 502
 *   - anything else → 500
 *
 * SECRETS: the access/refresh tokens are returned to the browser (that is the
 * point — they go into the connector config), but the PKCE verifier and DCR
 * client secret stay in the cookie and are cleared here; they never appear in
 * the body.
 */
export const runtime = 'nodejs';

interface FinishBody {
  code?: unknown;
  state?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  let body: FinishBody;
  try {
    body = (await req.json()) as FinishBody;
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body', code: 'bad-request' },
      { status: 400 },
    );
  }

  const { secure } = deriveOrigin(req.headers);

  const code = typeof body.code === 'string' ? body.code : '';
  const state = typeof body.state === 'string' ? body.state : undefined;
  if (!code) {
    return NextResponse.json(
      { error: 'code is required', code: 'bad-request' },
      { status: 400 },
    );
  }

  const flow = decodeFlowState(readCookie(req.headers.get('cookie'), OAUTH_FLOW_COOKIE));
  if (!flow) {
    // No (or corrupt) flow cookie → nothing to exchange against. Clear any junk.
    const res = NextResponse.json(
      { error: 'no pending OAuth flow (the authorization session expired)', code: 'no-flow' },
      { status: 400 },
    );
    res.headers.set('Set-Cookie', buildClearFlowCookie(secure));
    return res;
  }

  try {
    const { tokens, clientInformation } = await finishConnectorOAuth(flow, code, state);

    const expiresAt =
      typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : undefined;

    const res = NextResponse.json({
      tokens: {
        accessToken: tokens.access_token,
        ...(tokens.refresh_token !== undefined ? { refreshToken: tokens.refresh_token } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
      },
      connectorUrl: flow.connectorUrl,
      clientInformation,
    });
    // Always clear the flow cookie once the code is consumed (single-use).
    res.headers.set('Set-Cookie', buildClearFlowCookie(secure));
    return res;
  } catch (e) {
    const message = getErrorMessage(e) || 'failed to finish OAuth flow';
    const isStateError =
      e instanceof OAuthServerFlowError &&
      (/state mismatch/i.test(message) || /flow expired/i.test(message));
    const status = isStateError ? 400 : e instanceof OAuthServerFlowError ? 502 : 500;
    const code = isStateError
      ? 'state-mismatch'
      : status === 502
        ? 'oauth-finish-failed'
        : 'error';
    const res = NextResponse.json({ error: message, code }, { status });
    // A failed/abandoned flow's cookie is single-use too — clear it.
    res.headers.set('Set-Cookie', buildClearFlowCookie(secure));
    return res;
  }
}
