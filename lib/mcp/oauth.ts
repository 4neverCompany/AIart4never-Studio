'use client';

/**
 * MCP OAuth 2.1 — browser-side authorize flow for OAuth-only MCP servers.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * Our connector path only sent static headers, so an OAuth-only server such as
 * Higgsfield (https://mcp.higgsfield.ai/mcp — OAuth 2.1 ONLY, no API key, but
 * RFC 7591 Dynamic Client Registration so NO pre-registered client_id is
 * needed) answered every probe with 401. This module runs the FULL OAuth
 * handshake in the BROWSER using the SDK's built-in state machine, then stores
 * the resulting tokens IN the connector config so the existing
 * "client passes config → server connects with the Bearer header" path
 * (`connectMcp` / `POST /api/mcp/probe`) keeps working untouched.
 *
 * ─── HOW (the SDK does the heavy lifting) ───────────────────────────────────
 * `StreamableHTTPClientTransport` accepts an `authProvider: OAuthClientProvider`
 * and ships the whole OAuth 2.1 state machine: RFC 9728 protected-resource +
 * RFC 8414 authorization-server discovery, PKCE, RFC 7591 Dynamic Client
 * Registration, the authorization-code exchange and refresh. We only implement
 * the provider's storage + redirect hooks. The two-call shape:
 *
 *   1. beginConnectorOAuth(config)
 *        → build a transport with our provider and `client.connect(transport)`.
 *          With no stored token the SDK runs discovery + DCR, generates PKCE
 *          (→ saveCodeVerifier), registers the client (→ saveClientInformation),
 *          builds the authorize URL and calls redirectToAuthorization(url),
 *          which navigates the browser. connect() then throws UnauthorizedError
 *          (expected — the page is already navigating away).
 *
 *   2. completeConnectorOAuth(code)      [run from the redirect_uri callback]
 *        → rehydrate the provider for the pending flow, build a fresh transport,
 *          and call transport.finishAuth(code). The SDK exchanges the code for
 *          tokens (→ saveTokens) using the saved code verifier + client info.
 *          We read the saved tokens, fold them into the connector config's
 *          `oauth` block + `Authorization: Bearer` header, and return it.
 *
 * Refresh is a CLIENT concern: the SDK refreshes via the same provider (using
 * the stored refresh token + DCR client info) on a future connect; the helper
 * `refreshConnectorTokenIfNeeded` exposes that for the registry to call before
 * use. A mid-run expiry is an accepted v1 edge case.
 *
 * SECURITY: tokens/verifier/client-info live in `sessionStorage` keyed by an
 * opaque flow id and are cleared once the flow finishes. The persisted tokens
 * land in the connector config, which is always redacted before logging
 * (`redactConfig` masks the whole `oauth` block).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { getErrorMessage } from '@/lib/errors';
import type { McpServerConfig } from './types';

/** App identity advertised to the authorization server during DCR. */
const APP_NAME = 'master4never-agent';
const APP_CLIENT_URI = 'https://github.com/Code4neverCompany';

/** Path of the redirect_uri page (the callback target). */
export const OAUTH_CALLBACK_PATH = '/mcp/oauth/callback';

/** sessionStorage key prefix; one bucket per flow id. */
const FLOW_KEY_PREFIX = 'm4n_mcp_oauth_flow:';
/** sessionStorage key naming the flow id of the IN-PROGRESS authorize round-trip. */
const PENDING_FLOW_KEY = 'm4n_mcp_oauth_pending';

/**
 * Everything we must persist between `beginConnectorOAuth` (which navigates the
 * browser away) and `completeConnectorOAuth` (which runs on the callback page,
 * a fresh page load). Keyed by `flowId` in sessionStorage.
 */
interface FlowState {
  flowId: string;
  /** The connector being authorized (server url, name, any static headers). */
  config: McpServerConfig;
  /** OAuth2 `state` we generated, echoed back as `?state=` for CSRF defence. */
  state?: string;
  codeVerifier?: string;
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
}

// ── storage helpers (sessionStorage; safe no-ops when unavailable) ───────────

function storage(): Storage | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function readFlow(flowId: string): FlowState | undefined {
  const raw = storage()?.getItem(FLOW_KEY_PREFIX + flowId);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as FlowState;
  } catch {
    return undefined;
  }
}

function writeFlow(state: FlowState): void {
  storage()?.setItem(FLOW_KEY_PREFIX + state.flowId, JSON.stringify(state));
}

function clearFlow(flowId: string): void {
  const s = storage();
  s?.removeItem(FLOW_KEY_PREFIX + flowId);
  if (s?.getItem(PENDING_FLOW_KEY) === flowId) s.removeItem(PENDING_FLOW_KEY);
}

/** The flow id of the in-progress authorize round-trip, if any. */
export function getPendingFlowId(): string | undefined {
  return storage()?.getItem(PENDING_FLOW_KEY) ?? undefined;
}

/** Generate an opaque, url-safe id. Uses crypto when available. */
function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    /* fall through */
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

/**
 * Compute the redirect_uri for THIS environment.
 *
 * We derive it from the current page origin at runtime, which is correct for
 * BOTH deploy targets without any env wiring:
 *   - hosted web (Vercel): `https://<vercel-host>/mcp/oauth/callback`
 *   - desktop (Tauri):     the app origin (`http://tauri.localhost/...` on
 *     Windows / `tauri://localhost/...` etc.) + the same path.
 *
 * `origin` lets the SAME computation serve the callback page, which must
 * reproduce the exact redirect_uri it used at authorize time (OAuth requires an
 * exact match). Falls back to a relative path when there is no `window`
 * (SSR/build) — never used at runtime, only to keep the type a string.
 */
export function computeRedirectUrl(origin?: string): string {
  const base =
    origin ??
    (typeof window !== 'undefined' && window.location ? window.location.origin : '');
  return `${base}${OAUTH_CALLBACK_PATH}`;
}

// ── the browser OAuthClientProvider ─────────────────────────────────────────

/**
 * Browser implementation of the SDK's {@link OAuthClientProvider}. One instance
 * is bound to one flow id; ALL persisted state (code verifier, DCR client info,
 * tokens, OAuth state) lives in the flow's sessionStorage bucket so the same
 * logical session survives the full-page redirect to the callback.
 *
 * Implemented members:
 *   - `redirectUrl`           — our `/mcp/oauth/callback` (per-env, see above).
 *   - `clientMetadata`        — DCR registration metadata (redirect_uris +
 *                               grant_types/response_types + client_name/uri).
 *   - `state()`               — a generated, persisted CSRF state.
 *   - `clientInformation()` / `saveClientInformation()` — DCR client persistence.
 *   - `tokens()` / `saveTokens()` — token persistence into the flow bucket.
 *   - `saveCodeVerifier()` / `codeVerifier()` — PKCE verifier persistence.
 *   - `redirectToAuthorization(url)` — navigates the browser to `url`.
 */
export class BrowserOAuthClientProvider implements OAuthClientProvider {
  readonly flowId: string;
  private readonly _redirectUrl: string;

  constructor(flowId: string, config: McpServerConfig, redirectUrl?: string) {
    this.flowId = flowId;
    this._redirectUrl = redirectUrl ?? computeRedirectUrl();
    // Ensure the flow bucket exists with the config; preserve any prior state.
    const existing = readFlow(flowId);
    writeFlow({ ...(existing ?? { flowId }), flowId, config });
  }

  private flow(): FlowState {
    return readFlow(this.flowId) ?? { flowId: this.flowId, config: { } as McpServerConfig };
  }

  private patch(p: Partial<FlowState>): void {
    writeFlow({ ...this.flow(), ...p, flowId: this.flowId });
  }

  get redirectUrl(): string {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: APP_NAME,
      client_uri: APP_CLIENT_URI,
      redirect_uris: [this._redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state(): string {
    const current = this.flow().state;
    if (current) return current;
    const s = randomId();
    this.patch({ state: s });
    return s;
  }

  clientInformation(): OAuthClientInformationFull | undefined {
    return this.flow().clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationFull | OAuthClientInformation): void {
    // DCR returns the "full" shape; widen-store it. A pre-registered "mixed"
    // info (client_id only) is stored verbatim too.
    this.patch({ clientInformation: info as OAuthClientInformationFull });
  }

  tokens(): OAuthTokens | undefined {
    return this.flow().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.patch({ tokens });
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.patch({ codeVerifier });
  }

  codeVerifier(): string {
    const v = this.flow().codeVerifier;
    if (!v) {
      throw new OAuthFlowError('no PKCE code verifier saved for this OAuth flow');
    }
    return v;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // Mark this flow as the pending one so the callback page can find it, then
    // navigate the browser to the authorization server.
    storage()?.setItem(PENDING_FLOW_KEY, this.flowId);
    if (typeof window !== 'undefined' && window.location) {
      window.location.href = authorizationUrl.toString();
    }
  }
}

/** Typed error for OAuth-flow problems surfaced by this module. */
export class OAuthFlowError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'OAuthFlowError';
    Object.setPrototypeOf(this, OAuthFlowError.prototype);
  }
}

// ── flow entry points ────────────────────────────────────────────────────────

/**
 * True when a thrown value is the SDK's `UnauthorizedError` (or smells like a
 * 401 / "unauthorized"). `beginConnectorOAuth` expects this after it kicks off
 * the redirect; the connector add UI uses it to decide whether to show the
 * "Authorize" button on a failed probe.
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

/** Client identity advertised during the initialize handshake. */
const CLIENT_INFO = { name: APP_NAME, version: '0.1.0' } as const;

/**
 * Build a transport + minimal client and run `client.connect(transport)`. This
 * is what actually triggers the SDK auth flow: connect() calls the transport's
 * `start()` then sends the `initialize` request, the server answers 401, and
 * the transport's `_authThenStart` runs discovery + DCR + PKCE and calls our
 * provider's `redirectToAuthorization` (navigating the browser away). connect()
 * then rejects with `UnauthorizedError` — expected. Injectable for tests.
 */
async function defaultConnect(url: URL, provider: OAuthClientProvider): Promise<void> {
  const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  try {
    await client.connect(transport);
  } finally {
    try {
      await client.close();
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Options for {@link beginConnectorOAuth} — injectable so tests don't touch the
 * real SDK transport, the network, or `window`.
 */
export interface BeginOAuthDeps {
  /**
   * The connect-that-triggers-redirect step. Defaults to building an SDK
   * `Client` + `StreamableHTTPClientTransport` and calling `client.connect`.
   * In tests, supply a stub that calls the provider's `redirectToAuthorization`
   * (to exercise our storage/redirect hooks) and/or throws `UnauthorizedError`.
   */
  connect?: (url: URL, provider: OAuthClientProvider) => Promise<void>;
  /** Override the redirect_uri (tests / explicit env). */
  redirectUrl?: string;
}

/**
 * Step 1: start the OAuth authorize flow for `config`.
 *
 * Persists a fresh flow bucket, builds a {@link BrowserOAuthClientProvider},
 * and runs a `client.connect()` against the server. With no stored token the
 * SDK discovers, dynamically registers (RFC 7591), generates PKCE, and calls
 * our `redirectToAuthorization`, which navigates the browser. The returned
 * `flowId` is the handle the callback uses.
 *
 * The caller does not await a token here — control leaves the page via the
 * redirect, and connect() rejects with `UnauthorizedError` (swallowed as
 * expected). We DO surface a NON-auth error (e.g. discovery failed) so the UI
 * can show it instead of a silent dead-end.
 */
export async function beginConnectorOAuth(
  config: McpServerConfig,
  deps: BeginOAuthDeps = {},
): Promise<{ flowId: string }> {
  if (config.transport !== 'http' || !config.url) {
    throw new OAuthFlowError('OAuth is only supported for http connectors with a url');
  }

  const flowId = randomId();
  const provider = new BrowserOAuthClientProvider(flowId, config, deps.redirectUrl);

  let url: URL;
  try {
    url = new URL(config.url);
  } catch (e) {
    clearFlow(flowId);
    throw new OAuthFlowError(`invalid connector url "${config.url}"`, e);
  }

  const connect = deps.connect ?? defaultConnect;

  try {
    await connect(url, provider);
  } catch (e) {
    if (isUnauthorized(e)) {
      // Expected: the redirect kicked off and the page is navigating away.
      return { flowId };
    }
    clearFlow(flowId);
    throw new OAuthFlowError(`failed to start OAuth flow: ${getErrorMessage(e)}`, e);
  }

  // connect() resolved without a redirect → either already authorized (a token
  // was already valid) or the SDK chose not to redirect. Treat as begun; the
  // callback or a follow-up connect resolves it.
  return { flowId };
}

/**
 * Options for {@link completeConnectorOAuth}.
 */
export interface CompleteOAuthDeps {
  makeTransport?: (url: URL, provider: OAuthClientProvider) => Pick<StreamableHTTPClientTransport, 'finishAuth' | 'close'>;
  /** Override the redirect_uri (must match begin's). */
  redirectUrl?: string;
  /** Explicit flow id (defaults to the pending one in sessionStorage). */
  flowId?: string;
}

/**
 * Step 2: finish the OAuth flow on the callback page.
 *
 * Rehydrates the pending flow's provider, builds a fresh transport, and calls
 * `transport.finishAuth(code)`. The SDK exchanges the code for tokens (using
 * the saved PKCE verifier + DCR client info) and calls our `saveTokens`. We
 * then fold those tokens into the connector config (the `oauth` block + an
 * `Authorization: Bearer` header) and return it, ready for `confirmAndInstall`.
 *
 * @throws OAuthFlowError when there is no pending flow, the `state` mismatches,
 *   no tokens were produced, or the exchange itself fails.
 */
export async function completeConnectorOAuth(
  code: string,
  state: string | undefined,
  deps: CompleteOAuthDeps = {},
): Promise<{ config: McpServerConfig; tokens: OAuthTokens }> {
  const flowId = deps.flowId ?? getPendingFlowId();
  if (!flowId) {
    throw new OAuthFlowError('no pending OAuth flow to complete');
  }

  const flow = readFlow(flowId);
  if (!flow || !flow.config?.url) {
    throw new OAuthFlowError('OAuth flow state is missing or corrupted');
  }

  // CSRF: the returned `state` must match what we generated at begin time. We
  // only enforce when both sides have a state (some servers omit it on echo).
  if (flow.state && state && flow.state !== state) {
    clearFlow(flowId);
    throw new OAuthFlowError('OAuth state mismatch — possible CSRF, flow aborted');
  }

  const provider = new BrowserOAuthClientProvider(flowId, flow.config, deps.redirectUrl);

  let url: URL;
  try {
    url = new URL(flow.config.url);
  } catch (e) {
    clearFlow(flowId);
    throw new OAuthFlowError(`invalid connector url "${flow.config.url}"`, e);
  }

  const transport =
    deps.makeTransport?.(url, provider) ??
    new StreamableHTTPClientTransport(url, { authProvider: provider });

  try {
    await transport.finishAuth(code);
  } catch (e) {
    throw new OAuthFlowError(`OAuth token exchange failed: ${getErrorMessage(e)}`, e);
  } finally {
    try {
      await transport.close();
    } catch {
      /* best-effort */
    }
  }

  const tokens = provider.tokens();
  if (!tokens?.access_token) {
    throw new OAuthFlowError('OAuth completed but no access token was returned');
  }

  const config = applyTokensToConfig(flow.config, tokens, provider.clientInformation());
  clearFlow(flowId);
  return { config, tokens };
}

/**
 * Fold an `OAuthTokens` (+ optional DCR client info) into a connector config:
 * populate the `oauth` block AND mirror the bearer into
 * `headers.Authorization`, so the existing server-side connect path
 * authenticates with no changes. Returns a NEW config (no mutation).
 */
export function applyTokensToConfig(
  config: McpServerConfig,
  tokens: OAuthTokens,
  clientInformation?: OAuthClientInformationFull,
): McpServerConfig {
  const expiresAt =
    typeof tokens.expires_in === 'number'
      ? Date.now() + tokens.expires_in * 1000
      : undefined;

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
              clientId: clientInformation.client_id,
              ...(clientInformation.client_secret !== undefined
                ? { clientSecret: clientInformation.client_secret }
                : {}),
            },
          }
        : {}),
    },
  };
}

/**
 * Client-side token refresh: if the connector's access token is expired (or
 * within `skewMs` of expiry) and a refresh token + DCR client info are present,
 * run the SDK's refresh and return a config with fresh tokens. Otherwise return
 * the config unchanged.
 *
 * This is the seam the registry calls BEFORE handing a config to the server
 * connect path; a mid-run expiry remains an accepted v1 edge case.
 */
export async function refreshConnectorTokenIfNeeded(
  config: McpServerConfig,
  deps: { connect?: (url: URL, provider: OAuthClientProvider) => Promise<void>; skewMs?: number } = {},
): Promise<McpServerConfig> {
  const oauth = config.oauth;
  const skew = deps.skewMs ?? 60_000;
  const fresh = !oauth?.expiresAt || oauth.expiresAt - Date.now() > skew;
  if (fresh || !oauth?.refreshToken || !config.url) return config;

  const flowId = `refresh:${config.id}`;
  const provider = new BrowserOAuthClientProvider(flowId, config, undefined);
  // Seed the provider with the stored credentials so the SDK's auth() refreshes
  // (it reads tokens() → expired-but-has-refresh-token → refreshAuthorization).
  provider.saveTokens({
    access_token: oauth.accessToken,
    token_type: 'Bearer',
    refresh_token: oauth.refreshToken,
    ...(oauth.scope !== undefined ? { scope: oauth.scope } : {}),
  });
  if (oauth.clientInformation) {
    provider.saveClientInformation({
      client_id: oauth.clientInformation.clientId,
      ...(oauth.clientInformation.clientSecret !== undefined
        ? { client_secret: oauth.clientInformation.clientSecret }
        : {}),
      redirect_uris: [provider.redirectUrl],
    } as OAuthClientInformationFull);
  }

  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    clearFlow(flowId);
    return config;
  }

  const connect = deps.connect ?? defaultConnect;
  try {
    // A connect with an expired token + refresh token makes the SDK refresh
    // silently (no redirect). Any throw is non-fatal — we read whatever tokens
    // the provider stored.
    await connect(url, provider);
  } catch {
    /* refresh attempted; tokens() below reflects the result */
  }

  const refreshed = provider.tokens();
  clearFlow(flowId);
  if (refreshed?.access_token && refreshed.access_token !== oauth.accessToken) {
    return applyTokensToConfig(config, refreshed, undefined);
  }
  return config;
}
