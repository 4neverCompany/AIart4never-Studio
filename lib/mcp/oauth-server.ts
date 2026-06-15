/**
 * MCP OAuth 2.1 — SERVER-SIDE network steps.
 *
 * ─── WHY THIS EXISTS (the CORS bug) ─────────────────────────────────────────
 * The OAuth handshake against an MCP server (e.g. Higgsfield —
 * https://mcp.higgsfield.ai/mcp) involves several cross-origin HTTP fetches:
 *   - RFC 9728 protected-resource metadata discovery,
 *   - RFC 8414 / OIDC authorization-server metadata discovery,
 *   - RFC 7591 Dynamic Client Registration (DCR),
 *   - the authorization-code → token exchange.
 * MCP / auth servers do NOT send CORS headers for browser origins, so running
 * ANY of these from the browser fails with "Failed to fetch" (the same class of
 * bug already fixed for the connect-probe by moving it server-side). The ONLY
 * step that is a genuine browser navigation (and therefore CORS-immune) is the
 * `authorize` redirect itself.
 *
 * So: this module runs every HTTP step SERVER-SIDE (Node runtime, no CORS) using
 * the SDK's LOWER-LEVEL auth functions, and the browser only performs the
 * authorize navigation + lands on the callback page. The two server entrypoints
 * are the route handlers in `app/api/mcp/oauth/{start,finish}`; this file holds
 * the framework-free logic they call (everything is injectable so tests never
 * touch the network).
 *
 * ─── THE FLOW STATE (cookie round-trip) ─────────────────────────────────────
 * `startConnectorOAuth` produces a {@link OAuthFlowState} that must survive the
 * provider redirect round-trip until `finishConnectorOAuth` runs on the
 * callback. The route layer serialises it into a short-lived, httpOnly,
 * SameSite=Lax cookie (see {@link encodeFlowState} / {@link decodeFlowState}).
 * SameSite=Lax is required so the cookie is still sent on the top-level GET
 * navigation back from the authorization server.
 *
 * SECURITY: the flow state carries the PKCE `codeVerifier` and any DCR
 * `clientSecret` — secret material. It lives ONLY in the httpOnly cookie (never
 * readable by JS, never returned to the browser body) and is cleared the moment
 * `finish` completes. The CSRF `state` is validated on finish.
 */

import {
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  registerClient,
  startAuthorization,
  exchangeAuthorization,
  selectResourceURL,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientMetadata,
  OAuthClientInformationFull,
  OAuthTokens,
  AuthorizationServerMetadata,
  OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';

/** App identity advertised to the authorization server during DCR. */
export const APP_NAME = 'master4never-agent';
export const APP_CLIENT_URI = 'https://github.com/Code4neverCompany';

/** Path of the redirect_uri page (the callback target). Mirrored in oauth.ts. */
export const OAUTH_CALLBACK_PATH = '/mcp/oauth/callback';

/** Name of the httpOnly cookie that carries the in-flight flow state. */
export const OAUTH_FLOW_COOKIE = 'm4n_mcp_oauth_flow';

/** How long the flow-state cookie lives (seconds). One authorize round-trip. */
export const OAUTH_FLOW_TTL_SECONDS = 600; // 10 minutes

/**
 * Everything the SERVER must remember between `start` (which hands the browser an
 * authorize URL and navigates away) and `finish` (a fresh request on the
 * callback). Stored ONLY in the httpOnly flow cookie — never the response body.
 */
export interface OAuthFlowState {
  /** CSRF `state` we generated; echoed back as `?state=` and re-validated. */
  state: string;
  /** PKCE verifier from `startAuthorization`; needed for the token exchange. SECRET. */
  codeVerifier: string;
  /** The MCP connector URL being authorized (the resource server). */
  connectorUrl: string;
  /** The authorization-server base URL discovery resolved to. */
  authorizationServerUrl: string;
  /** redirect_uri used at authorize time — MUST be reused verbatim on exchange. */
  redirectUri: string;
  /** DCR client_id (RFC 7591). */
  clientId: string;
  /** DCR client_secret, when the server issued one (confidential client). SECRET. */
  clientSecret?: string;
  /** RFC 8707 resource indicator, when discovery produced one. */
  resource?: string;
  /** Unix-ms the flow was started (defence-in-depth TTL check on finish). */
  startedAt: number;
}

/** Typed error for server-side OAuth-flow problems. */
export class OAuthServerFlowError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'OAuthServerFlowError';
    Object.setPrototypeOf(this, OAuthServerFlowError.prototype);
  }
}

/** Generate an opaque, url-safe id (CSRF state). Uses webcrypto. */
function randomId(): string {
  const g = globalThis as { crypto?: Crypto };
  if (g.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    g.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Should never happen in a Node 18+/edge runtime, but keep a fallback.
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

/** The DCR client metadata we register with — public client, PKCE, our callback. */
export function buildClientMetadata(redirectUri: string): OAuthClientMetadata {
  return {
    client_name: APP_NAME,
    client_uri: APP_CLIENT_URI,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

/**
 * The set of SDK functions {@link startConnectorOAuth} / {@link finishConnectorOAuth}
 * call. Injectable so tests can stub each network step without a real fetch /
 * authorization server. Defaults bind to the real SDK auth module.
 */
export interface OAuthServerDeps {
  discoverProtectedResource?: typeof discoverOAuthProtectedResourceMetadata;
  discoverAuthServer?: typeof discoverAuthorizationServerMetadata;
  register?: typeof registerClient;
  start?: typeof startAuthorization;
  exchange?: typeof exchangeAuthorization;
}

const defaultDeps: Required<OAuthServerDeps> = {
  discoverProtectedResource: discoverOAuthProtectedResourceMetadata,
  discoverAuthServer: discoverAuthorizationServerMetadata,
  register: registerClient,
  start: startAuthorization,
  exchange: exchangeAuthorization,
};

/**
 * Resolve the authorization server + (optional) RFC 9728 resource metadata for
 * an MCP server URL. RFC 9728 is OPTIONAL: when the server has no
 * protected-resource document we fall back to treating the connector URL itself
 * as the authorization server (matches the SDK's `auth()` orchestrator).
 */
async function discover(
  connectorUrl: string,
  deps: Required<OAuthServerDeps>,
): Promise<{
  authorizationServerUrl: string;
  authServerMetadata: AuthorizationServerMetadata | undefined;
  resourceMetadata: OAuthProtectedResourceMetadata | undefined;
}> {
  let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
  try {
    resourceMetadata = await deps.discoverProtectedResource(connectorUrl);
  } catch {
    // RFC 9728 PRM is optional / may 404 → fall back to the connector URL.
    resourceMetadata = undefined;
  }

  const authorizationServerUrl =
    resourceMetadata?.authorization_servers?.[0] ?? connectorUrl;

  const authServerMetadata = await deps.discoverAuthServer(authorizationServerUrl);

  return { authorizationServerUrl, authServerMetadata, resourceMetadata };
}

/**
 * SERVER step 1: discover → DCR → PKCE → build the authorize URL for `connectorUrl`.
 *
 * Runs every network step server-side (no CORS) and returns BOTH the authorize
 * URL (to hand the browser) and the {@link OAuthFlowState} the route persists in
 * the httpOnly cookie. The browser then navigates to `authorizeUrl`; on return
 * the callback posts the code+state to `finish`, which reads the cookie back.
 *
 * @throws OAuthServerFlowError on any discovery / registration / authorize-build failure.
 */
export async function startConnectorOAuth(
  connectorUrl: string,
  redirectUri: string,
  deps: OAuthServerDeps = {},
): Promise<{ authorizeUrl: string; flowState: OAuthFlowState }> {
  const d: Required<OAuthServerDeps> = { ...defaultDeps, ...deps };

  // Validate the connector URL up front so a bad value is a clean 400.
  try {
    // eslint-disable-next-line no-new
    new URL(connectorUrl);
  } catch (e) {
    throw new OAuthServerFlowError(`invalid connector url "${connectorUrl}"`, e);
  }

  let authorizationServerUrl: string;
  let authServerMetadata: AuthorizationServerMetadata | undefined;
  let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
  try {
    ({ authorizationServerUrl, authServerMetadata, resourceMetadata } = await discover(
      connectorUrl,
      d,
    ));
  } catch (e) {
    throw new OAuthServerFlowError(
      `OAuth discovery failed for ${connectorUrl}: ${msg(e)}`,
      e,
    );
  }

  // RFC 8707 resource indicator (selectResourceURL validates it matches).
  let resource: URL | undefined;
  try {
    resource = await selectResourceURL(connectorUrl, minimalResourceProvider(redirectUri), resourceMetadata);
  } catch {
    resource = undefined;
  }

  // RFC 7591 Dynamic Client Registration — no pre-registered client_id needed.
  let clientInformation: OAuthClientInformationFull;
  try {
    clientInformation = await d.register(authorizationServerUrl, {
      ...(authServerMetadata ? { metadata: authServerMetadata } : {}),
      clientMetadata: buildClientMetadata(redirectUri),
    });
  } catch (e) {
    throw new OAuthServerFlowError(
      `dynamic client registration failed at ${authorizationServerUrl}: ${msg(e)}`,
      e,
    );
  }

  const state = randomId();

  // PKCE + authorize URL.
  let authorizationUrl: URL;
  let codeVerifier: string;
  try {
    ({ authorizationUrl, codeVerifier } = await d.start(authorizationServerUrl, {
      ...(authServerMetadata ? { metadata: authServerMetadata } : {}),
      clientInformation,
      redirectUrl: redirectUri,
      state,
      ...(resource ? { resource } : {}),
    }));
  } catch (e) {
    throw new OAuthServerFlowError(
      `failed to build the authorization URL: ${msg(e)}`,
      e,
    );
  }

  const flowState: OAuthFlowState = {
    state,
    codeVerifier,
    connectorUrl,
    authorizationServerUrl,
    redirectUri,
    clientId: clientInformation.client_id,
    ...(clientInformation.client_secret !== undefined
      ? { clientSecret: clientInformation.client_secret }
      : {}),
    ...(resource ? { resource: resource.toString() } : {}),
    startedAt: Date.now(),
  };

  return { authorizeUrl: authorizationUrl.toString(), flowState };
}

/**
 * SERVER step 2: validate the CSRF `state`, then exchange the authorization
 * `code` for tokens at the token endpoint (PKCE verifier + DCR client creds from
 * the flow state). Pure over the persisted flow state — the route supplies it
 * after decoding the cookie.
 *
 * @throws OAuthServerFlowError on a state mismatch (CSRF), an expired flow, or a
 *   failed token exchange.
 */
export async function finishConnectorOAuth(
  flow: OAuthFlowState,
  code: string,
  returnedState: string | undefined,
  deps: OAuthServerDeps = {},
): Promise<{ tokens: OAuthTokens; clientInformation: { clientId: string; clientSecret?: string } }> {
  const d: Required<OAuthServerDeps> = { ...defaultDeps, ...deps };

  // CSRF: the returned state MUST match what we generated at start time.
  if (!returnedState || returnedState !== flow.state) {
    throw new OAuthServerFlowError('OAuth state mismatch — possible CSRF, flow aborted');
  }

  // Defence-in-depth TTL (the cookie also expires, but a clock-skew cushion is cheap).
  if (Date.now() - flow.startedAt > (OAUTH_FLOW_TTL_SECONDS + 60) * 1000) {
    throw new OAuthServerFlowError('OAuth flow expired — please start the authorization again');
  }

  // Re-fetch the auth-server metadata so the SDK uses the discovered token
  // endpoint + supported auth methods (DCR registered us as a public client).
  let authServerMetadata: AuthorizationServerMetadata | undefined;
  try {
    authServerMetadata = await d.discoverAuthServer(flow.authorizationServerUrl);
  } catch {
    authServerMetadata = undefined;
  }

  const clientInformation = {
    client_id: flow.clientId,
    ...(flow.clientSecret !== undefined ? { client_secret: flow.clientSecret } : {}),
    redirect_uris: [flow.redirectUri],
  } as OAuthClientInformationFull;

  let tokens: OAuthTokens;
  try {
    tokens = await d.exchange(flow.authorizationServerUrl, {
      ...(authServerMetadata ? { metadata: authServerMetadata } : {}),
      clientInformation,
      authorizationCode: code,
      codeVerifier: flow.codeVerifier,
      redirectUri: flow.redirectUri,
      ...(flow.resource ? { resource: new URL(flow.resource) } : {}),
    });
  } catch (e) {
    throw new OAuthServerFlowError(`OAuth token exchange failed: ${msg(e)}`, e);
  }

  if (!tokens?.access_token) {
    throw new OAuthServerFlowError('OAuth completed but no access token was returned');
  }

  return {
    tokens,
    clientInformation: {
      clientId: flow.clientId,
      ...(flow.clientSecret !== undefined ? { clientSecret: flow.clientSecret } : {}),
    },
  };
}

// ── cookie (de)serialisation ─────────────────────────────────────────────────

/**
 * Encode a {@link OAuthFlowState} into a cookie-safe string. Base64url of the
 * JSON — NOT encryption, but the cookie is httpOnly + Secure + SameSite=Lax, so
 * it is never readable by JS and only sent to our own origin. The contents are
 * single-use and cleared on finish.
 */
export function encodeFlowState(state: OAuthFlowState): string {
  const json = JSON.stringify(state);
  return Buffer.from(json, 'utf8').toString('base64url');
}

/** Decode a cookie value back into a {@link OAuthFlowState}, or undefined if junk. */
export function decodeFlowState(value: string | undefined): OAuthFlowState | undefined {
  if (!value) return undefined;
  try {
    const json = Buffer.from(value, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Partial<OAuthFlowState>;
    if (
      typeof parsed?.state === 'string' &&
      typeof parsed.codeVerifier === 'string' &&
      typeof parsed.connectorUrl === 'string' &&
      typeof parsed.authorizationServerUrl === 'string' &&
      typeof parsed.redirectUri === 'string' &&
      typeof parsed.clientId === 'string'
    ) {
      return parsed as OAuthFlowState;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Read a single cookie value out of a raw `Cookie:` header. */
export function readCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return part.slice(idx + 1).trim();
  }
  return undefined;
}

/**
 * Build the `Set-Cookie` value that PERSISTS the flow state. httpOnly so JS can
 * never read it; SameSite=Lax so it survives the top-level GET navigation back
 * from the authorization server; Secure on https origins; Path scoped to the
 * OAuth API so it is only ever sent to our own routes; Max-Age short-lived.
 */
export function buildSetFlowCookie(value: string, secure: boolean): string {
  const attrs = [
    `${OAUTH_FLOW_COOKIE}=${value}`,
    'Path=/api/mcp/oauth',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${OAUTH_FLOW_TTL_SECONDS}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/** Build the `Set-Cookie` value that CLEARS the flow cookie (Max-Age=0). */
export function buildClearFlowCookie(secure: boolean): string {
  const attrs = [
    `${OAUTH_FLOW_COOKIE}=`,
    'Path=/api/mcp/oauth',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/**
 * Derive the app origin from a request's headers so the redirect_uri matches the
 * deploy target (web Vercel vs desktop Tauri) WITHOUT env wiring. Prefers the
 * forwarded proto/host (set by Vercel's proxy), then the `Origin` / `Host`
 * headers. Returns `{ origin, secure }`.
 */
export function deriveOrigin(headers: Headers): { origin: string; secure: boolean } {
  const explicitOrigin = headers.get('origin');
  if (explicitOrigin) {
    try {
      const u = new URL(explicitOrigin);
      return { origin: u.origin, secure: u.protocol === 'https:' };
    } catch {
      /* fall through */
    }
  }
  const fwdProto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const fwdHost = headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = fwdHost ?? headers.get('host') ?? 'localhost';
  const proto = fwdProto ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return { origin: `${proto}://${host}`, secure: proto === 'https' };
}

/** The full redirect_uri for an origin. Must match between start and finish. */
export function redirectUriFor(origin: string): string {
  return `${origin}${OAUTH_CALLBACK_PATH}`;
}

// ── internals ────────────────────────────────────────────────────────────────

function msg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * A bare-bones provider object whose only purpose is to satisfy
 * `selectResourceURL`'s signature (it reads `validateResourceURL` if present —
 * we don't override it, so default RFC 8707 validation applies). The redirect
 * is unused by that call but keeps the shape honest.
 */
function minimalResourceProvider(redirectUri: string): Parameters<typeof selectResourceURL>[1] {
  return {
    get redirectUrl() {
      return redirectUri;
    },
    get clientMetadata() {
      return buildClientMetadata(redirectUri);
    },
    clientInformation() {
      return undefined;
    },
    tokens() {
      return undefined;
    },
    saveTokens() {
      /* no-op */
    },
    redirectToAuthorization() {
      /* no-op */
    },
    saveCodeVerifier() {
      /* no-op */
    },
    codeVerifier() {
      return '';
    },
  };
}
