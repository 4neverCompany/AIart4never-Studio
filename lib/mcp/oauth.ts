'use client';

/**
 * MCP OAuth 2.1 — BROWSER orchestration (no cross-origin fetches).
 *
 * ─── WHY (the CORS bug this fixes) ──────────────────────────────────────────
 * The earlier version ran the SDK transport's connect + DISCOVERY in the
 * BROWSER. That meant the browser fetched the MCP server (e.g.
 * https://mcp.higgsfield.ai/mcp) and its RFC 9728 / 8414 metadata cross-origin —
 * and MCP / auth servers send NO CORS headers for browser origins, so the
 * browser CORS-blocked it and "Authorize Higgsfield" died with
 * "failed to start OAuth flow: Failed to fetch". (Same class as the connect-probe
 * bug we already moved server-side.)
 *
 * The ONLY OAuth step that is a genuine browser navigation — and therefore
 * CORS-immune — is the `authorize` redirect. Discovery, Dynamic Client
 * Registration, and the token exchange are HTTP fetches that MUST run
 * server-side. So this module now does ZERO cross-origin work:
 *
 *   1. beginConnectorOAuth(config)
 *        → POST /api/mcp/oauth/start { connectorUrl }. The SERVER discovers,
 *          dynamically registers, generates PKCE, builds the authorize URL, and
 *          stashes the flow state (PKCE verifier, DCR client creds, CSRF state)
 *          in an httpOnly cookie. We get back { authorizeUrl } and navigate the
 *          browser there (`window.location.href = authorizeUrl`).
 *
 *   2. completeConnectorOAuth(code, state)   [run from /mcp/oauth/callback]
 *        → POST /api/mcp/oauth/finish { code, state }. The SERVER reads the flow
 *          cookie, validates the CSRF state, exchanges the code for tokens, and
 *          clears the cookie. We fold the returned tokens into the connector
 *          config (the `oauth` block + `Authorization: Bearer` header) and hand
 *          it back for the existing FR-22 propose→confirm→install pipeline.
 *
 * The connector config the callback installs authenticates through the SAME
 * server-side connect path (`connectMcp` / the probe route) with the Bearer
 * header — unchanged. The Composio static-header path is untouched.
 *
 * The browser makes NO fetch to the MCP / auth origin: only same-origin POSTs to
 * our own /api/mcp/oauth/* routes + the top-level authorize navigation.
 */

import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { getErrorMessage } from '@/lib/errors';
import type { McpServerConfig } from './types';

/** Path of the redirect_uri page (the callback target). */
export const OAUTH_CALLBACK_PATH = '/mcp/oauth/callback';

/** Our own server routes (same-origin — no CORS). */
const START_ENDPOINT = '/api/mcp/oauth/start';
const FINISH_ENDPOINT = '/api/mcp/oauth/finish';

/**
 * sessionStorage key holding the NON-SECRET connector descriptor (name + url +
 * any operator static headers) across the authorize redirect round-trip.
 *
 * The SECRET flow state (PKCE verifier, DCR client creds, CSRF state) lives in
 * the SERVER's httpOnly cookie — never in the browser. We only need the
 * operator-entered, non-secret form fields here so the callback can rebuild the
 * proposal and run the FR-22 install pipeline. (The bearer token is added by the
 * server `finish` response, not stored here.)
 */
const CONNECTOR_DESCRIPTOR_KEY = 'm4n_mcp_oauth_connector';

/** The non-secret fields we round-trip through sessionStorage. */
interface ConnectorDescriptor {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

function sessionStore(): Storage | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function stashConnectorDescriptor(config: McpServerConfig): void {
  const desc: ConnectorDescriptor = {
    name: config.name,
    url: config.url ?? '',
    ...(config.headers ? { headers: config.headers } : {}),
  };
  try {
    sessionStore()?.setItem(CONNECTOR_DESCRIPTOR_KEY, JSON.stringify(desc));
  } catch {
    /* best-effort: a missing descriptor just means the callback asks the server */
  }
}

/** Read back the stashed connector descriptor (cleared on read). */
export function readConnectorDescriptor(): ConnectorDescriptor | undefined {
  const s = sessionStore();
  const raw = s?.getItem(CONNECTOR_DESCRIPTOR_KEY);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<ConnectorDescriptor>;
    if (typeof parsed?.name === 'string') {
      return {
        name: parsed.name,
        url: typeof parsed.url === 'string' ? parsed.url : '',
        ...(parsed.headers ? { headers: parsed.headers } : {}),
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function clearConnectorDescriptor(): void {
  try {
    sessionStore()?.removeItem(CONNECTOR_DESCRIPTOR_KEY);
  } catch {
    /* ignore */
  }
}

/** Typed error for OAuth-flow problems surfaced by this module. */
export class OAuthFlowError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'OAuthFlowError';
    Object.setPrototypeOf(this, OAuthFlowError.prototype);
  }
}

/**
 * Compute the redirect_uri for THIS environment from the current page origin.
 * Correct for BOTH deploy targets without env wiring (web Vercel host / desktop
 * Tauri origin) — the SERVER also derives the same value from the request
 * origin, so the redirect_uri matches across start (DCR + authorize) and finish.
 * Kept for compatibility / display; the network steps now derive it server-side.
 */
export function computeRedirectUrl(origin?: string): string {
  const base =
    origin ??
    (typeof window !== 'undefined' && window.location ? window.location.origin : '');
  return `${base}${OAUTH_CALLBACK_PATH}`;
}

/**
 * True when a thrown value / error code smells like a 401. The connector add UI
 * uses this to decide whether to show the "Authorize" button on a failed probe.
 */
export function isUnauthorized(e: unknown): boolean {
  if (!e) return false;
  const name = (e as { name?: unknown }).name;
  if (name === 'UnauthorizedError') return true;
  const msg = getErrorMessage(e).toLowerCase();
  return (
    msg.includes('401') ||
    msg.includes('unauthorized') ||
    msg.includes('unauthorised')
  );
}

// ── flow entry points ────────────────────────────────────────────────────────

/** Injectable fetch so tests never hit a real route. Defaults to global fetch. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function defaultFetch(): FetchLike {
  return (input, init) => fetch(input, init);
}

/** Options for {@link beginConnectorOAuth} — injectable for tests. */
export interface BeginOAuthDeps {
  /** Override the network call to /api/mcp/oauth/start. */
  fetchImpl?: FetchLike;
  /** Override the browser navigation (tests assert the URL instead of navigating). */
  navigate?: (url: string) => void;
}

function defaultNavigate(url: string): void {
  if (typeof window !== 'undefined' && window.location) {
    window.location.href = url;
  }
}

/**
 * Step 1: start the OAuth authorize flow for `config`.
 *
 * POSTs the connector URL to the SERVER route, which runs discovery + DCR + PKCE
 * (server-side, no CORS) and returns an authorize URL; we then navigate the
 * browser to it. The server set an httpOnly flow cookie that the callback's
 * `finish` call reads back. NO direct fetch to the MCP / auth origin happens
 * here — only a same-origin POST + the authorize navigation.
 *
 * The returned `flowId` is retained for API compatibility with the previous
 * shape (and the AddConnectorForm contract); the real flow state now lives in
 * the server cookie, so the value is informational.
 *
 * @throws OAuthFlowError for a non-http connector or a failed `start` (so the UI
 *   shows the error instead of a silent dead-end).
 */
export async function beginConnectorOAuth(
  config: McpServerConfig,
  deps: BeginOAuthDeps = {},
): Promise<{ flowId: string }> {
  if (config.transport !== 'http' || !config.url) {
    throw new OAuthFlowError('OAuth is only supported for http connectors with a url');
  }

  const doFetch = deps.fetchImpl ?? defaultFetch();
  const navigate = deps.navigate ?? defaultNavigate;

  // Stash the NON-SECRET connector descriptor so the callback can rebuild the
  // proposal after the redirect (the secret flow state lives in the server
  // cookie). Done before the network call so it survives even an early nav.
  stashConnectorDescriptor(config);

  let res: Response;
  try {
    res = await doFetch(START_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectorUrl: config.url }),
    });
  } catch (e) {
    throw new OAuthFlowError(`failed to start OAuth flow: ${getErrorMessage(e)}`, e);
  }

  let data: { authorizeUrl?: string; error?: string };
  try {
    data = (await res.json()) as { authorizeUrl?: string; error?: string };
  } catch {
    throw new OAuthFlowError(
      `failed to start OAuth flow: server returned a non-JSON response (status ${res.status})`,
    );
  }

  if (!res.ok || !data.authorizeUrl) {
    throw new OAuthFlowError(
      `failed to start OAuth flow: ${data.error || `status ${res.status}`}`,
    );
  }

  navigate(data.authorizeUrl);
  // The server holds the canonical flow state in the httpOnly cookie; this id is
  // a stable, informational handle (the page is already navigating away).
  return { flowId: data.authorizeUrl };
}

/** Options for {@link completeConnectorOAuth} — injectable for tests. */
export interface CompleteOAuthDeps {
  /** Override the network call to /api/mcp/oauth/finish. */
  fetchImpl?: FetchLike;
}

/** The server `finish` route's success response shape. */
interface FinishResponse {
  tokens?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scope?: string;
  };
  connectorUrl?: string;
  clientInformation?: { clientId?: string; clientSecret?: string };
  error?: string;
}

/**
 * Step 2: finish the OAuth flow on the callback page.
 *
 * POSTs `{ code, state }` to the SERVER route, which reads the httpOnly flow
 * cookie, validates the CSRF state, exchanges the code for tokens (server-side,
 * no CORS), and clears the cookie. We rebuild the connector config from the
 * NON-SECRET descriptor stashed at begin time (falling back to the server's
 * echoed `connectorUrl`), fold the returned tokens into it (`oauth` block +
 * `Authorization: Bearer`), clear the descriptor, and return it ready for
 * `confirmAndInstall`.
 *
 * Signature kept as `(code, state)` so the callback page is unchanged. NO fetch
 * to the MCP / auth origin happens here — only a same-origin POST to our route.
 *
 * @throws OAuthFlowError when there is no pending flow (no descriptor + no echoed
 *   url), the state mismatched, the exchange failed, or no token was produced.
 */
export async function completeConnectorOAuth(
  code: string,
  state: string | undefined,
  deps: CompleteOAuthDeps = {},
): Promise<{ config: McpServerConfig; tokens: OAuthTokens }> {
  const doFetch = deps.fetchImpl ?? defaultFetch();

  let res: Response;
  try {
    res = await doFetch(FINISH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, ...(state !== undefined ? { state } : {}) }),
    });
  } catch (e) {
    throw new OAuthFlowError(`OAuth token exchange failed: ${getErrorMessage(e)}`, e);
  }

  let data: FinishResponse;
  try {
    data = (await res.json()) as FinishResponse;
  } catch {
    throw new OAuthFlowError(
      `OAuth token exchange failed: server returned a non-JSON response (status ${res.status})`,
    );
  }

  if (!res.ok || !data.tokens?.accessToken) {
    throw new OAuthFlowError(
      `OAuth token exchange failed: ${data.error || `status ${res.status}`}`,
    );
  }

  // Rebuild the connector config from the non-secret descriptor (the operator's
  // form fields) + the server-echoed connectorUrl. The descriptor is the source
  // of the name/static-headers; the server confirms the url.
  const descriptor = readConnectorDescriptor();
  const url = descriptor?.url || data.connectorUrl;
  if (!url) {
    throw new OAuthFlowError('OAuth flow state is missing — please start the authorization again');
  }
  const baseConfig: McpServerConfig = {
    id: '',
    name: descriptor?.name ?? url,
    transport: 'http',
    url,
    ...(descriptor?.headers ? { headers: descriptor.headers } : {}),
    enabled: false,
    trusted: false,
    addedAt: 0,
  };

  // Reconstruct an OAuthTokens shape from the route's redacted response so we can
  // reuse the shared `applyTokensToConfig` (and return the same `tokens` shape).
  const tokens: OAuthTokens = {
    access_token: data.tokens.accessToken,
    token_type: 'Bearer',
    ...(data.tokens.refreshToken !== undefined ? { refresh_token: data.tokens.refreshToken } : {}),
    ...(data.tokens.scope !== undefined ? { scope: data.tokens.scope } : {}),
  };

  const clientInformation =
    data.clientInformation?.clientId !== undefined
      ? {
          clientId: data.clientInformation.clientId,
          ...(data.clientInformation.clientSecret !== undefined
            ? { clientSecret: data.clientInformation.clientSecret }
            : {}),
        }
      : undefined;

  const config = applyTokensToConfig(baseConfig, tokens, data.tokens.expiresAt, clientInformation);
  clearConnectorDescriptor();
  return { config, tokens };
}

/**
 * Fold an `OAuthTokens` (+ optional `expiresAt` ms and DCR client info) into a
 * connector config: populate the `oauth` block AND mirror the bearer into
 * `headers.Authorization`, so the existing server-side connect path
 * authenticates with no changes. Returns a NEW config (no mutation).
 *
 * `expiresAt` is the absolute Unix-ms expiry (the server already converted the
 * token response's `expires_in`); when omitted we leave it unset.
 */
export function applyTokensToConfig(
  config: McpServerConfig,
  tokens: OAuthTokens,
  expiresAt?: number,
  clientInformation?: { clientId: string; clientSecret?: string },
): McpServerConfig {
  const headers: Record<string, string> = { ...(config.headers ?? {}) };
  // Drop any stale Authorization (case-insensitive) before setting the fresh one.
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'authorization') delete headers[k];
  }
  headers.Authorization = `Bearer ${tokens.access_token}`;

  return {
    ...config,
    headers,
    oauth: {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token !== undefined ? { refreshToken: tokens.refresh_token } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
      ...(clientInformation
        ? {
            clientInformation: {
              clientId: clientInformation.clientId,
              ...(clientInformation.clientSecret !== undefined
                ? { clientSecret: clientInformation.clientSecret }
                : {}),
            },
          }
        : {}),
    },
  };
}

/**
 * Token refresh seam. A mid-run expiry is an accepted v1 edge case; refreshing
 * the token is a cross-origin fetch and so MUST go through a server route (like
 * `start`/`finish`) rather than the browser — that route is a follow-up. Until
 * then this returns the config unchanged so callers stay simple and NO
 * cross-origin fetch is ever made from the browser.
 */
export async function refreshConnectorTokenIfNeeded(
  config: McpServerConfig,
): Promise<McpServerConfig> {
  return config;
}
