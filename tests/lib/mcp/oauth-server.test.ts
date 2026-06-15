/**
 * lib/mcp/oauth-server.ts — the SERVER-SIDE OAuth network steps (CORS-fix).
 *
 * Every SDK auth function is injected so nothing hits the network. We assert the
 * orchestration that the route handlers depend on:
 *
 *   - startConnectorOAuth: discover (with RFC 9728 → auth-server fallback) → DCR →
 *     startAuthorization, returning the authorizeUrl + a flow state carrying the
 *     PKCE verifier, DCR client creds, CSRF state, and the resolved auth server;
 *   - discovery fallback: when protected-resource metadata 404s, the connector
 *     URL itself is used as the authorization server;
 *   - finishConnectorOAuth: CSRF state validation, TTL guard, and the code→token
 *     exchange returning tokens + client info;
 *   - cookie helpers: encode/decode round-trip + readCookie parsing + the
 *     Set-Cookie attribute builders (httpOnly / SameSite=Lax / Secure / Max-Age);
 *   - deriveOrigin: origin header, x-forwarded-*, and host fallbacks.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  startConnectorOAuth,
  finishConnectorOAuth,
  encodeFlowState,
  decodeFlowState,
  readCookie,
  buildSetFlowCookie,
  buildClearFlowCookie,
  deriveOrigin,
  redirectUriFor,
  OAuthServerFlowError,
  type OAuthFlowState,
  type OAuthServerDeps,
} from '@/lib/mcp/oauth-server';

const CONNECTOR = 'https://mcp.higgsfield.ai/mcp';
const REDIRECT = 'https://app.example/mcp/oauth/callback';

function deps(over: Partial<OAuthServerDeps> = {}): OAuthServerDeps {
  return {
    discoverProtectedResource: vi.fn(async () => ({
      resource: CONNECTOR,
      authorization_servers: ['https://auth.higgsfield.ai'],
    })),
    discoverAuthServer: vi.fn(async () => ({
      issuer: 'https://auth.higgsfield.ai',
      authorization_endpoint: 'https://auth.higgsfield.ai/authorize',
      token_endpoint: 'https://auth.higgsfield.ai/token',
      response_types_supported: ['code'],
    })),
    register: vi.fn(async () => ({
      client_id: 'dcr-id',
      client_secret: 'dcr-secret',
      redirect_uris: [REDIRECT],
    })),
    start: vi.fn(async () => ({
      authorizationUrl: new URL('https://auth.higgsfield.ai/authorize?state=S'),
      codeVerifier: 'pkce-verifier',
    })),
    exchange: vi.fn(async () => ({
      access_token: 'access-1',
      token_type: 'Bearer',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      scope: 'read',
    })),
    ...over,
  } as unknown as OAuthServerDeps;
}

describe('startConnectorOAuth', () => {
  it('discovers → registers → builds the authorize URL + flow state', async () => {
    const d = deps();
    const { authorizeUrl, flowState } = await startConnectorOAuth(CONNECTOR, REDIRECT, d);

    expect(authorizeUrl).toBe('https://auth.higgsfield.ai/authorize?state=S');
    expect(flowState.connectorUrl).toBe(CONNECTOR);
    expect(flowState.authorizationServerUrl).toBe('https://auth.higgsfield.ai');
    expect(flowState.redirectUri).toBe(REDIRECT);
    expect(flowState.codeVerifier).toBe('pkce-verifier');
    expect(flowState.clientId).toBe('dcr-id');
    expect(flowState.clientSecret).toBe('dcr-secret');
    expect(typeof flowState.state).toBe('string');
    expect(flowState.state.length).toBeGreaterThan(0);

    // DCR + startAuthorization saw the discovered auth server + our redirect.
    expect(d.register).toHaveBeenCalledTimes(1);
    const startArg = (d.start as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(startArg[0]).toBe('https://auth.higgsfield.ai');
    expect(startArg[1].redirectUrl).toBe(REDIRECT);
    expect(startArg[1].state).toBe(flowState.state);
  });

  it('falls back to the connector URL as auth server when RFC 9728 PRM 404s', async () => {
    const d = deps({
      discoverProtectedResource: vi.fn(async () => {
        throw new Error('404');
      }),
    });
    const { flowState } = await startConnectorOAuth(CONNECTOR, REDIRECT, d);
    expect(flowState.authorizationServerUrl).toBe(CONNECTOR);
    expect(d.register).toHaveBeenCalled();
  });

  it('throws OAuthServerFlowError on an invalid connector url (no network)', async () => {
    const d = deps();
    await expect(startConnectorOAuth('not-a-url', REDIRECT, d)).rejects.toBeInstanceOf(
      OAuthServerFlowError,
    );
    expect(d.discoverProtectedResource).not.toHaveBeenCalled();
  });

  it('wraps a DCR failure in OAuthServerFlowError', async () => {
    const d = deps({
      register: vi.fn(async () => {
        throw new Error('registration_not_supported');
      }),
    });
    await expect(startConnectorOAuth(CONNECTOR, REDIRECT, d)).rejects.toBeInstanceOf(
      OAuthServerFlowError,
    );
  });
});

describe('finishConnectorOAuth', () => {
  const flow: OAuthFlowState = {
    state: 'S',
    codeVerifier: 'pkce-verifier',
    connectorUrl: CONNECTOR,
    authorizationServerUrl: 'https://auth.higgsfield.ai',
    redirectUri: REDIRECT,
    clientId: 'dcr-id',
    clientSecret: 'dcr-secret',
    startedAt: Date.now(),
  };

  it('validates state then exchanges the code for tokens', async () => {
    const d = deps();
    const { tokens, clientInformation } = await finishConnectorOAuth(flow, 'the-code', 'S', d);
    expect(tokens.access_token).toBe('access-1');
    expect(clientInformation.clientId).toBe('dcr-id');

    const exchangeArg = (d.exchange as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(exchangeArg[0]).toBe('https://auth.higgsfield.ai');
    expect(exchangeArg[1].authorizationCode).toBe('the-code');
    expect(exchangeArg[1].codeVerifier).toBe('pkce-verifier');
    expect(exchangeArg[1].redirectUri).toBe(REDIRECT);
  });

  it('rejects a CSRF state mismatch before exchanging', async () => {
    const d = deps();
    await expect(finishConnectorOAuth(flow, 'code', 'WRONG', d)).rejects.toBeInstanceOf(
      OAuthServerFlowError,
    );
    expect(d.exchange).not.toHaveBeenCalled();
  });

  it('rejects a missing returned state', async () => {
    const d = deps();
    await expect(finishConnectorOAuth(flow, 'code', undefined, d)).rejects.toBeInstanceOf(
      OAuthServerFlowError,
    );
  });

  it('rejects an expired flow', async () => {
    const d = deps();
    const stale = { ...flow, startedAt: Date.now() - 60 * 60 * 1000 };
    await expect(finishConnectorOAuth(stale, 'code', 'S', d)).rejects.toThrow(/expired/i);
    expect(d.exchange).not.toHaveBeenCalled();
  });

  it('throws when the exchange yields no access token', async () => {
    const d = deps({
      // Intentionally malformed (no access_token) to exercise the guard.
      exchange: vi.fn(async () => ({ token_type: 'Bearer' }) as never),
    });
    await expect(finishConnectorOAuth(flow, 'code', 'S', d)).rejects.toBeInstanceOf(
      OAuthServerFlowError,
    );
  });
});

describe('flow-state cookie helpers', () => {
  const flow: OAuthFlowState = {
    state: 'S',
    codeVerifier: 'v',
    connectorUrl: CONNECTOR,
    authorizationServerUrl: 'https://auth.higgsfield.ai',
    redirectUri: REDIRECT,
    clientId: 'cid',
    startedAt: 1,
  };

  it('encode → decode round-trips', () => {
    expect(decodeFlowState(encodeFlowState(flow))).toEqual(flow);
  });

  it('decode returns undefined for junk / missing', () => {
    expect(decodeFlowState(undefined)).toBeUndefined();
    expect(decodeFlowState('!!!not base64 json')).toBeUndefined();
    expect(decodeFlowState(Buffer.from('{}', 'utf8').toString('base64url'))).toBeUndefined();
  });

  it('readCookie extracts a named value from a Cookie header', () => {
    expect(readCookie('a=1; m4n_mcp_oauth_flow=XYZ; b=2', 'm4n_mcp_oauth_flow')).toBe('XYZ');
    expect(readCookie('a=1', 'missing')).toBeUndefined();
    expect(readCookie(null, 'x')).toBeUndefined();
  });

  it('buildSetFlowCookie sets httpOnly + SameSite=Lax + Path + Max-Age (+Secure on https)', () => {
    const secure = buildSetFlowCookie('VAL', true);
    expect(secure).toContain('m4n_mcp_oauth_flow=VAL');
    expect(secure).toContain('HttpOnly');
    expect(secure).toContain('SameSite=Lax');
    expect(secure).toContain('Path=/api/mcp/oauth');
    expect(secure).toContain('Max-Age=600');
    expect(secure).toContain('Secure');

    const insecure = buildSetFlowCookie('VAL', false);
    expect(insecure).not.toContain('Secure');
  });

  it('buildClearFlowCookie expires the cookie (Max-Age=0)', () => {
    const cleared = buildClearFlowCookie(true);
    expect(cleared).toContain('m4n_mcp_oauth_flow=;');
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('HttpOnly');
  });
});

describe('deriveOrigin / redirectUriFor', () => {
  it('prefers the Origin header', () => {
    const h = new Headers({ origin: 'https://web.vercel.app', host: 'ignored' });
    expect(deriveOrigin(h)).toEqual({ origin: 'https://web.vercel.app', secure: true });
  });

  it('uses x-forwarded-proto/host when no Origin', () => {
    const h = new Headers({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'fwd.example' });
    expect(deriveOrigin(h)).toEqual({ origin: 'https://fwd.example', secure: true });
  });

  it('falls back to the host header (http for localhost)', () => {
    const h = new Headers({ host: 'localhost:3000' });
    expect(deriveOrigin(h)).toEqual({ origin: 'http://localhost:3000', secure: false });
  });

  it('redirectUriFor appends the callback path', () => {
    expect(redirectUriFor('https://app.example')).toBe('https://app.example/mcp/oauth/callback');
  });
});
