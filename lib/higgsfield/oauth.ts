/**
 * Higgsfield MCP — OAuth 2.0 + PKCE token flow.
 *
 * The Higgsfield MCP server at https://mcp.higgsfield.ai/mcp is the
 * ONLY public surface for multi-tenant usage. Auth is OAuth 2.0 with
 * PKCE (S256) and dynamic client registration:
 *
 *   - Issuer:        https://mcp.higgsfield.ai
 *   - Authorize:     https://mcp.higgsfield.ai/oauth2/authorize
 *   - Token:         https://mcp.higgsfield.ai/oauth2/token
 *   - Register:      https://mcp.higgsfield.ai/oauth2/register
 *
 * We register a public client (token auth method `none`) so the user
 * doesn't need a backend-held client_secret — PKCE alone proves the
 * caller. The registered `client_id` is persisted in `config.json`
 * (not in IDB) because it never expires, while access/refresh tokens
 * are stored in IDB (origin-bound) since they need to survive
 * webview restarts but ARE sensitive.
 *
 * Scope: 'openid email offline_access' (only scope Higgsfield
 * currently advertises). The 'offline_access' scope is what gets us
 * a refresh_token; without it we'd have to re-prompt the user on
 * every access token expiry.
 */

import { createHash, randomBytes } from 'node:crypto';

export const HIGGSFIELD_MCP_ISSUER = 'https://mcp.higgsfield.ai';
export const HIGGSFIELD_MCP_SERVER_URL = 'https://mcp.higgsfield.ai/mcp';
export const HIGGSFIELD_OAUTH_AUTHORIZE = `${HIGGSFIELD_MCP_ISSUER}/oauth2/authorize`;
export const HIGGSFIELD_OAUTH_TOKEN = `${HIGGSFIELD_MCP_ISSUER}/oauth2/token`;
export const HIGGSFIELD_OAUTH_REGISTER = `${HIGGSFIELD_MCP_ISSUER}/oauth2/register`;

export const HIGGSFIELD_OAUTH_SCOPE = 'openid email offline_access';

export interface DynamicClientRegistrationResponse {
  client_id: string;
  client_id_issued_at?: number;
  // Server may return these for confidential clients; we don't use them
  // (we register as public / token auth method 'none') but we accept
  // them to be forward-compatible.
  client_secret?: string;
  client_secret_expires_at?: number;
}

/**
 * Register a public OAuth client (no client_secret) via dynamic
 * client registration. The redirect URIs we send are the desktop
 * loopback and the public web callback; both must match exactly
 * what we send in /oauth2/authorize.
 *
 * The client_id is stable — register it ONCE per deployment, persist
 * it in config.json (`HIGGSFIELD_OAUTH_CLIENT_ID`), and reuse forever.
 * Re-registering is safe (Higgsfield returns a new client_id) but
 * means existing refresh tokens are orphaned.
 */
export async function registerOAuthClient(args: {
  redirectUris: string[];
  clientName?: string;
}): Promise<DynamicClientRegistrationResponse> {
  const res = await fetch(HIGGSFIELD_OAUTH_REGISTER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: args.clientName || 'MashupForge',
      redirect_uris: args.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: HIGGSFIELD_OAUTH_SCOPE,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Higgsfield OAuth register failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as DynamicClientRegistrationResponse;
  if (!data.client_id) {
    throw new Error('Higgsfield OAuth register returned no client_id');
  }
  return data;
}

/**
 * PKCE pair generation. Returns the verifier (kept secret until
 * /token call) and the S256 challenge (sent in /authorize).
 *
 * The verifier is 43-128 chars of base64url-encoded randomness (we
 * use 64 random bytes → 86 base64url chars, well within the range).
 * The challenge is SHA-256(verifier) → base64url, per RFC 7636.
 */
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Build the /oauth2/authorize URL the user should be sent to.
 * `state` should be a per-request opaque string (echoed back on the
 * callback to defeat CSRF); we tie it to the PKCE verifier in a
 * signed state cookie.
 */
export function buildAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    scope: HIGGSFIELD_OAUTH_SCOPE,
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${HIGGSFIELD_OAUTH_AUTHORIZE}?${params.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer' | string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  /** OIDC ID token, when scope=openid. */
  id_token?: string;
}

/**
 * Exchange an authorization code (or refresh token) for tokens.
 * Used by the callback route and by the token-refresh helper below.
 */
export async function exchangeCodeForTokens(args: {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const res = await fetch(HIGGSFIELD_OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: args.clientId,
      code: args.code,
      code_verifier: args.codeVerifier,
      redirect_uri: args.redirectUri,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Higgsfield token exchange failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as TokenResponse;
}

export async function refreshAccessToken(args: {
  clientId: string;
  refreshToken: string;
}): Promise<TokenResponse> {
  const res = await fetch(HIGGSFIELD_OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: args.clientId,
      refresh_token: args.refreshToken,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Higgsfield token refresh failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as TokenResponse;
}

/**
 * Decode the JWT payload (middle segment, base64url). We don't
 * verify the signature — the token is delivered over HTTPS from
 * Higgsfield's auth server, and we'll know it's valid the next
 * time the MCP server rejects a 401. Returns `null` on parse error
 * (e.g. opaque token, future server change).
 */
export function decodeJwtPayload(jwt: string): {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  email?: string;
  name?: string;
  org_id?: string;
} | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}
