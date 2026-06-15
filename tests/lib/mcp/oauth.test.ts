/**
 * MCP OAuth 2.1 — BROWSER orchestration unit tests (post-CORS-fix).
 *
 * The browser module no longer touches the MCP SDK transport or any cross-origin
 * origin: `beginConnectorOAuth` POSTs our own `/api/mcp/oauth/start` then
 * navigates to the returned authorize URL; `completeConnectorOAuth` POSTs our own
 * `/api/mcp/oauth/finish` and folds the returned tokens into the connector
 * config. We inject `fetchImpl` / `navigate` so nothing hits a real route, and
 * assert:
 *
 *   - computeRedirectUrl (per-env redirect_uri),
 *   - applyTokensToConfig folds tokens into the oauth block + Bearer header,
 *   - beginConnectorOAuth POSTs /start with { connectorUrl } and navigates to the
 *     authorizeUrl — and makes NO fetch to the MCP/auth origin,
 *   - beginConnectorOAuth surfaces a /start failure as OAuthFlowError,
 *   - completeConnectorOAuth POSTs /finish and returns a config with tokens,
 *   - completeConnectorOAuth surfaces a /finish error (e.g. state mismatch),
 *   - isUnauthorized sniffing.
 *
 * The full redirect→authorize→callback round-trip is only e2e-testable against a
 * live provider login; here we cover every browser-side seam around it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  OAuthFlowError,
  beginConnectorOAuth,
  completeConnectorOAuth,
  applyTokensToConfig,
  computeRedirectUrl,
  readConnectorDescriptor,
  isUnauthorized,
  OAUTH_CALLBACK_PATH,
} from '@/lib/mcp/oauth';
import type { McpServerConfig } from '@/lib/mcp/types';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

const CONNECTOR_URL = 'https://mcp.higgsfield.ai/mcp';
const AUTHORIZE_URL = 'https://auth.higgsfield.ai/authorize?client_id=x&state=abc';

/** The injected-fetch signature so `.mock.calls[0]` is typed `[string, RequestInit?]`. */
type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

function cfg(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'higgsfield',
    name: 'Higgsfield',
    transport: 'http',
    url: CONNECTOR_URL,
    enabled: false,
    trusted: false,
    addedAt: 0,
    ...over,
  };
}

/** Build a Response-like stub for the injected fetch. */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
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
// applyTokensToConfig
// ---------------------------------------------------------------------------

describe('applyTokensToConfig', () => {
  it('writes the oauth block AND mirrors the bearer into Authorization', () => {
    const tokens: OAuthTokens = {
      access_token: 'access-xyz',
      token_type: 'Bearer',
      refresh_token: 'refresh-xyz',
      scope: 'read write',
    };
    const out = applyTokensToConfig(cfg(), tokens, Date.now() + 3_600_000, {
      clientId: 'cid',
      clientSecret: 'csec',
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
  it('POSTs /api/mcp/oauth/start with { connectorUrl } then navigates to authorizeUrl', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ authorizeUrl: AUTHORIZE_URL }));
    const navigate = vi.fn();

    const { flowId } = await beginConnectorOAuth(cfg(), { fetchImpl, navigate });

    // Exactly one call, to OUR route, with the connector url — and NOTHING to
    // the MCP / auth origin (the browser never fetches mcp.higgsfield.ai).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchImpl.mock.calls[0];
    expect(endpoint).toBe('/api/mcp/oauth/start');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ connectorUrl: CONNECTOR_URL });
    for (const [url] of fetchImpl.mock.calls) {
      expect(String(url).startsWith('/api/mcp/oauth/')).toBe(true);
    }

    // Then it navigates the browser to the provider's authorize URL.
    expect(navigate).toHaveBeenCalledWith(AUTHORIZE_URL);
    expect(typeof flowId).toBe('string');
  });

  it('stashes the non-secret connector descriptor for the callback', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ authorizeUrl: AUTHORIZE_URL }));
    await beginConnectorOAuth(cfg({ headers: { 'X-Extra': 'h' } }), {
      fetchImpl,
      navigate: vi.fn(),
    });
    const desc = readConnectorDescriptor();
    expect(desc?.name).toBe('Higgsfield');
    expect(desc?.url).toBe(CONNECTOR_URL);
    expect(desc?.headers?.['X-Extra']).toBe('h');
  });

  it('surfaces a /start failure as OAuthFlowError (no navigation)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'discovery failed: 500', code: 'oauth-start-failed' }, false, 502),
    );
    const navigate = vi.fn();
    await expect(
      beginConnectorOAuth(cfg(), { fetchImpl, navigate }),
    ).rejects.toBeInstanceOf(OAuthFlowError);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('surfaces a network failure reaching /start as OAuthFlowError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(
      beginConnectorOAuth(cfg(), { fetchImpl, navigate: vi.fn() }),
    ).rejects.toBeInstanceOf(OAuthFlowError);
  });

  it('rejects a non-http connector before any fetch', async () => {
    const fetchImpl = vi.fn();
    await expect(
      beginConnectorOAuth(cfg({ transport: 'stdio', url: undefined, command: 'x' }), {
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(OAuthFlowError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// completeConnectorOAuth
// ---------------------------------------------------------------------------

describe('completeConnectorOAuth', () => {
  it('POSTs /api/mcp/oauth/finish and folds tokens into the rebuilt config', async () => {
    // begin first so the connector descriptor is stashed (name/url/headers).
    await beginConnectorOAuth(cfg(), {
      fetchImpl: async () => jsonResponse({ authorizeUrl: AUTHORIZE_URL }),
      navigate: vi.fn(),
    });

    const finishFetch = vi.fn<FetchImpl>(async () =>
      jsonResponse({
        tokens: {
          accessToken: 'final-access',
          refreshToken: 'final-refresh',
          expiresAt: Date.now() + 1_800_000,
          scope: 'read',
        },
        connectorUrl: CONNECTOR_URL,
        clientInformation: { clientId: 'dcr-id' },
      }),
    );

    const { config, tokens } = await completeConnectorOAuth('auth-code', 'abc', {
      fetchImpl: finishFetch,
    });

    expect(finishFetch).toHaveBeenCalledTimes(1);
    const [endpoint, init] = finishFetch.mock.calls[0];
    expect(endpoint).toBe('/api/mcp/oauth/finish');
    expect(JSON.parse(String(init?.body))).toEqual({ code: 'auth-code', state: 'abc' });

    expect(tokens.access_token).toBe('final-access');
    expect(config.name).toBe('Higgsfield');
    expect(config.url).toBe(CONNECTOR_URL);
    expect(config.oauth?.accessToken).toBe('final-access');
    expect(config.oauth?.refreshToken).toBe('final-refresh');
    expect(config.oauth?.clientInformation?.clientId).toBe('dcr-id');
    expect(config.headers?.Authorization).toBe('Bearer final-access');
    // Only same-origin POSTs — never the MCP/auth origin.
    expect(String(finishFetch.mock.calls[0][0]).startsWith('/api/mcp/oauth/')).toBe(true);
    // Descriptor cleared on success.
    expect(readConnectorDescriptor()).toBeUndefined();
  });

  it('falls back to the server-echoed connectorUrl when no descriptor is stashed', async () => {
    const finishFetch = vi.fn(async () =>
      jsonResponse({
        tokens: { accessToken: 'a' },
        connectorUrl: CONNECTOR_URL,
        clientInformation: { clientId: 'id' },
      }),
    );
    const { config } = await completeConnectorOAuth('code', 'st', { fetchImpl: finishFetch });
    expect(config.url).toBe(CONNECTOR_URL);
    expect(config.oauth?.accessToken).toBe('a');
  });

  it('surfaces a /finish error (state mismatch) as OAuthFlowError', async () => {
    const finishFetch = vi.fn(async () =>
      jsonResponse(
        { error: 'OAuth state mismatch — possible CSRF, flow aborted', code: 'state-mismatch' },
        false,
        400,
      ),
    );
    await expect(
      completeConnectorOAuth('code', 'WRONG', { fetchImpl: finishFetch }),
    ).rejects.toBeInstanceOf(OAuthFlowError);
  });

  it('throws when the exchange yields no token', async () => {
    const finishFetch = vi.fn(async () => jsonResponse({ tokens: {} }, true, 200));
    await expect(
      completeConnectorOAuth('code', 'st', { fetchImpl: finishFetch }),
    ).rejects.toBeInstanceOf(OAuthFlowError);
  });

  it('surfaces a network failure reaching /finish as OAuthFlowError', async () => {
    const finishFetch = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(
      completeConnectorOAuth('code', 'st', { fetchImpl: finishFetch }),
    ).rejects.toBeInstanceOf(OAuthFlowError);
  });
});

// ---------------------------------------------------------------------------
// isUnauthorized
// ---------------------------------------------------------------------------

describe('isUnauthorized', () => {
  it('detects the SDK UnauthorizedError by name', () => {
    const e = new Error('needs auth');
    e.name = 'UnauthorizedError';
    expect(isUnauthorized(e)).toBe(true);
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
