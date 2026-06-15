/**
 * MCP OAuth 2.1 — browser flow unit tests.
 *
 * The MCP SDK is mocked at its import specifiers so nothing hits the network or
 * a real authorization server: the `Client` + `StreamableHTTPClientTransport`
 * (used by `defaultConnect`) and the `auth.js`/`shared/auth.js` type-only
 * imports (no runtime). We exercise the pieces that ARE unit-testable:
 *
 *   - the provider's `redirectUrl` (per-env) + `clientMetadata` (DCR shape),
 *   - `state()` / `saveCodeVerifier()`+`codeVerifier()` / `saveClientInformation()`+
 *     `clientInformation()` / `saveTokens()`+`tokens()` persistence through
 *     sessionStorage keyed by flow id,
 *   - `redirectToAuthorization` setting the pending flow + navigating,
 *   - `applyTokensToConfig` folding tokens into the config's oauth block + Bearer,
 *   - `beginConnectorOAuth` swallowing UnauthorizedError (redirect kicked off)
 *     and surfacing a real error,
 *   - `completeConnectorOAuth` finishing via finishAuth → tokens on the config,
 *   - `isUnauthorized` sniffing.
 *
 * The full redirect→authorize→callback round-trip is only e2e-testable against
 * a live Higgsfield login; here we cover every seam around it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- SDK mocks --------------------------------------------------------------
const clientConnectSpy = vi.fn();
const clientCloseSpy = vi.fn();
const transportFinishAuthSpy = vi.fn();
const transportCloseSpy = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = clientConnectSpy;
    close = clientCloseSpy;
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    finishAuth = transportFinishAuthSpy;
    close = transportCloseSpy;
    constructor(
      public url: URL,
      public opts: unknown,
    ) {}
  },
}));

import {
  BrowserOAuthClientProvider,
  OAuthFlowError,
  beginConnectorOAuth,
  completeConnectorOAuth,
  applyTokensToConfig,
  computeRedirectUrl,
  getPendingFlowId,
  isUnauthorized,
  OAUTH_CALLBACK_PATH,
} from '@/lib/mcp/oauth';
import type { McpServerConfig } from '@/lib/mcp/types';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

const REDIRECT = 'https://example.app/mcp/oauth/callback';

function cfg(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'higgsfield',
    name: 'Higgsfield',
    transport: 'http',
    url: 'https://mcp.higgsfield.ai/mcp',
    enabled: false,
    trusted: false,
    addedAt: 0,
    ...over,
  };
}

class UnauthorizedError extends Error {
  constructor(msg?: string) {
    super(msg);
    this.name = 'UnauthorizedError';
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  try {
    window.sessionStorage.clear();
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// computeRedirectUrl
// ---------------------------------------------------------------------------

describe('computeRedirectUrl', () => {
  it('appends the callback path to an explicit origin (per-env redirect_uri)', () => {
    expect(computeRedirectUrl('https://my-host.vercel.app')).toBe(
      `https://my-host.vercel.app${OAUTH_CALLBACK_PATH}`,
    );
  });

  it('uses window.location.origin when no origin is passed', () => {
    const url = computeRedirectUrl();
    expect(url.endsWith(OAUTH_CALLBACK_PATH)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BrowserOAuthClientProvider — metadata + persistence
// ---------------------------------------------------------------------------

describe('BrowserOAuthClientProvider', () => {
  it('exposes the redirectUrl and a DCR-ready clientMetadata', () => {
    const p = new BrowserOAuthClientProvider('flow-1', cfg(), REDIRECT);
    expect(p.redirectUrl).toBe(REDIRECT);

    const meta = p.clientMetadata;
    expect(meta.redirect_uris).toEqual([REDIRECT]);
    expect(meta.grant_types).toContain('authorization_code');
    expect(meta.grant_types).toContain('refresh_token');
    expect(meta.response_types).toContain('code');
    expect(meta.token_endpoint_auth_method).toBe('none');
    expect(typeof meta.client_name).toBe('string');
  });

  it('persists + reloads the PKCE code verifier through sessionStorage', () => {
    const p = new BrowserOAuthClientProvider('flow-2', cfg(), REDIRECT);
    p.saveCodeVerifier('verifier-123');
    // A FRESH provider on the same flow id reads it back (survives a page load).
    const p2 = new BrowserOAuthClientProvider('flow-2', cfg(), REDIRECT);
    expect(p2.codeVerifier()).toBe('verifier-123');
  });

  it('throws when codeVerifier() is read before one is saved', () => {
    const p = new BrowserOAuthClientProvider('flow-empty', cfg(), REDIRECT);
    expect(() => p.codeVerifier()).toThrow(OAuthFlowError);
  });

  it('persists + reloads dynamically-registered client information', () => {
    const p = new BrowserOAuthClientProvider('flow-3', cfg(), REDIRECT);
    expect(p.clientInformation()).toBeUndefined();
    p.saveClientInformation({
      client_id: 'dcr-client-id',
      client_secret: 'dcr-secret',
      redirect_uris: [REDIRECT],
    });
    const p2 = new BrowserOAuthClientProvider('flow-3', cfg(), REDIRECT);
    expect(p2.clientInformation()?.client_id).toBe('dcr-client-id');
  });

  it('persists + reloads tokens', () => {
    const p = new BrowserOAuthClientProvider('flow-4', cfg(), REDIRECT);
    const tokens: OAuthTokens = {
      access_token: 'at-1',
      token_type: 'Bearer',
      refresh_token: 'rt-1',
    };
    p.saveTokens(tokens);
    const p2 = new BrowserOAuthClientProvider('flow-4', cfg(), REDIRECT);
    expect(p2.tokens()).toEqual(tokens);
  });

  it('state() generates once and is stable across reads', () => {
    const p = new BrowserOAuthClientProvider('flow-5', cfg(), REDIRECT);
    const s1 = p.state();
    const s2 = p.state();
    expect(s1).toBe(s2);
    expect(s1.length).toBeGreaterThan(0);
  });

  it('redirectToAuthorization marks the pending flow and navigates', () => {
    const p = new BrowserOAuthClientProvider('flow-6', cfg(), REDIRECT);
    const setHref = vi.fn();
    const original = window.location;
    // happy-dom location is read-only-ish; stub just the href setter.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        get href() {
          return '';
        },
        set href(v: string) {
          setHref(v);
        },
        origin: 'https://example.app',
      },
    });
    try {
      p.redirectToAuthorization(new URL('https://auth.higgsfield.ai/authorize?x=1'));
      expect(getPendingFlowId()).toBe('flow-6');
      expect(setHref).toHaveBeenCalledWith('https://auth.higgsfield.ai/authorize?x=1');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});

// ---------------------------------------------------------------------------
// applyTokensToConfig
// ---------------------------------------------------------------------------

describe('applyTokensToConfig', () => {
  it('writes the oauth block AND mirrors the bearer into Authorization', () => {
    const tokens: OAuthTokens = {
      access_token: 'access-xyz',
      token_type: 'Bearer',
      refresh_token: 'refresh-xyz',
      expires_in: 3600,
      scope: 'read write',
    };
    const out = applyTokensToConfig(cfg(), tokens, {
      client_id: 'cid',
      client_secret: 'csec',
      redirect_uris: [REDIRECT],
    });

    expect(out.oauth?.accessToken).toBe('access-xyz');
    expect(out.oauth?.refreshToken).toBe('refresh-xyz');
    expect(out.oauth?.scope).toBe('read write');
    expect(typeof out.oauth?.expiresAt).toBe('number');
    expect(out.oauth?.clientInformation?.clientId).toBe('cid');
    expect(out.headers?.Authorization).toBe('Bearer access-xyz');
  });

  it('replaces any stale Authorization header (case-insensitive)', () => {
    const out = applyTokensToConfig(
      cfg({ headers: { authorization: 'Bearer OLD', 'X-Other': 'keep' } }),
      { access_token: 'new-token', token_type: 'Bearer' },
    );
    // Old (lowercase) header dropped; fresh one set; unrelated header kept.
    const authValues = Object.entries(out.headers ?? {})
      .filter(([k]) => k.toLowerCase() === 'authorization')
      .map(([, v]) => v);
    expect(authValues).toEqual(['Bearer new-token']);
    expect(out.headers?.['X-Other']).toBe('keep');
  });
});

// ---------------------------------------------------------------------------
// beginConnectorOAuth
// ---------------------------------------------------------------------------

describe('beginConnectorOAuth', () => {
  it('swallows UnauthorizedError (redirect kicked off) and returns a flowId', async () => {
    const connect = vi.fn(async (_url: URL, _p) => {
      throw new UnauthorizedError('needs auth');
    });
    const { flowId } = await beginConnectorOAuth(cfg(), { connect, redirectUrl: REDIRECT });
    expect(typeof flowId).toBe('string');
    expect(flowId.length).toBeGreaterThan(0);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('drives the provider so a connect impl can persist + redirect', async () => {
    let capturedVerifier: string | undefined;
    const connect = vi.fn(async (_url: URL, p: OAuthClientProvider) => {
      // Simulate the SDK: stash a verifier + client info, then redirect.
      p.saveCodeVerifier('pkce-verifier');
      p.saveClientInformation?.({ client_id: 'reg-id', redirect_uris: [REDIRECT] });
      capturedVerifier = await p.codeVerifier();
      throw new UnauthorizedError();
    });
    const { flowId } = await beginConnectorOAuth(cfg(), { connect, redirectUrl: REDIRECT });
    expect(capturedVerifier).toBe('pkce-verifier');
    // State survived into the flow bucket for the callback.
    const reloaded = new BrowserOAuthClientProvider(flowId, cfg(), REDIRECT);
    expect(reloaded.clientInformation()?.client_id).toBe('reg-id');
  });

  it('surfaces a non-auth error as OAuthFlowError', async () => {
    const connect = vi.fn(async () => {
      throw new Error('discovery failed: 500');
    });
    await expect(
      beginConnectorOAuth(cfg(), { connect, redirectUrl: REDIRECT }),
    ).rejects.toBeInstanceOf(OAuthFlowError);
  });

  it('rejects a non-http connector', async () => {
    await expect(
      beginConnectorOAuth(cfg({ transport: 'stdio', url: undefined, command: 'x' })),
    ).rejects.toBeInstanceOf(OAuthFlowError);
  });
});

// ---------------------------------------------------------------------------
// completeConnectorOAuth
// ---------------------------------------------------------------------------

describe('completeConnectorOAuth', () => {
  it('finishes the exchange and folds tokens into the connector config', async () => {
    // Begin a flow so the pending flow + config are persisted.
    const begin = vi.fn(async (_url: URL, p: OAuthClientProvider) => {
      // Mark pending (begin's provider does this in redirectToAuthorization).
      window.sessionStorage.setItem('m4n_mcp_oauth_pending', (p as BrowserOAuthClientProvider).flowId);
      throw new UnauthorizedError();
    });
    const { flowId } = await beginConnectorOAuth(cfg(), { connect: begin, redirectUrl: REDIRECT });

    // finishAuth stub: the SDK would call provider.saveTokens; emulate by having
    // the makeTransport's finishAuth write tokens onto the provider it closes
    // over. We use the makeTransport dep to inject our own transport.
    const makeTransport = (_url: URL, provider: { saveTokens: (t: OAuthTokens) => void }) => ({
      finishAuth: vi.fn(async (_code: string) => {
        provider.saveTokens({
          access_token: 'final-access',
          token_type: 'Bearer',
          refresh_token: 'final-refresh',
          expires_in: 1800,
        });
      }),
      close: vi.fn(async () => {}),
    });

    const { config, tokens } = await completeConnectorOAuth('auth-code', undefined, {
      flowId,
      makeTransport: makeTransport as never,
      redirectUrl: REDIRECT,
    });

    expect(tokens.access_token).toBe('final-access');
    expect(config.oauth?.accessToken).toBe('final-access');
    expect(config.oauth?.refreshToken).toBe('final-refresh');
    expect(config.headers?.Authorization).toBe('Bearer final-access');
    expect(config.name).toBe('Higgsfield');
    // Flow bucket cleared on success.
    expect(getPendingFlowId()).toBeUndefined();
  });

  it('throws when there is no pending flow', async () => {
    await expect(completeConnectorOAuth('code', undefined)).rejects.toBeInstanceOf(OAuthFlowError);
  });

  it('throws on a state mismatch (CSRF guard)', async () => {
    const begin = vi.fn(async (_url: URL, p: OAuthClientProvider) => {
      window.sessionStorage.setItem('m4n_mcp_oauth_pending', (p as BrowserOAuthClientProvider).flowId);
      await p.state?.(); // persist a state
      throw new UnauthorizedError();
    });
    const { flowId } = await beginConnectorOAuth(cfg(), { connect: begin, redirectUrl: REDIRECT });
    await expect(
      completeConnectorOAuth('code', 'WRONG-STATE', { flowId, redirectUrl: REDIRECT }),
    ).rejects.toBeInstanceOf(OAuthFlowError);
  });

  it('throws when the exchange yields no token', async () => {
    const begin = vi.fn(async (_url: URL, p: OAuthClientProvider) => {
      window.sessionStorage.setItem('m4n_mcp_oauth_pending', (p as BrowserOAuthClientProvider).flowId);
      throw new UnauthorizedError();
    });
    const { flowId } = await beginConnectorOAuth(cfg(), { connect: begin, redirectUrl: REDIRECT });
    const makeTransport = () => ({
      finishAuth: vi.fn(async () => {
        /* never saves tokens */
      }),
      close: vi.fn(async () => {}),
    });
    await expect(
      completeConnectorOAuth('code', undefined, {
        flowId,
        makeTransport: makeTransport as never,
        redirectUrl: REDIRECT,
      }),
    ).rejects.toBeInstanceOf(OAuthFlowError);
  });
});

// ---------------------------------------------------------------------------
// isUnauthorized
// ---------------------------------------------------------------------------

describe('isUnauthorized', () => {
  it('detects the SDK UnauthorizedError by name', () => {
    expect(isUnauthorized(new UnauthorizedError())).toBe(true);
  });
  it('detects 401 / unauthorized in a message', () => {
    expect(isUnauthorized(new Error('HTTP 401'))).toBe(true);
    expect(isUnauthorized(new Error('Unauthorized'))).toBe(true);
  });
  it('is false for unrelated errors and nullish', () => {
    expect(isUnauthorized(new Error('connection refused'))).toBe(false);
    expect(isUnauthorized(undefined)).toBe(false);
  });
});
