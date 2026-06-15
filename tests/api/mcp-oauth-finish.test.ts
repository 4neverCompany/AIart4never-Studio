/**
 * POST /api/mcp/oauth/finish — SERVER-SIDE OAuth token exchange (CORS-fix) tests.
 *
 * The token exchange is a cross-origin fetch the browser cannot make, so this
 * route does it server-side. It reads the httpOnly flow cookie set by `/start`,
 * validates the CSRF state, exchanges the code, and clears the cookie. We mock
 * `@/lib/mcp/oauth-server`'s `finishConnectorOAuth` (the SDK exchange) but keep
 * the cookie helpers REAL, so we assert:
 *
 *   - happy path: validates state, exchanges, returns
 *     { tokens:{accessToken,refreshToken,expiresAt,scope}, connectorUrl,
 *       clientInformation }, and CLEARS the flow cookie (Max-Age=0);
 *   - missing/corrupt flow cookie → 400 (`no-flow`) and clears any junk cookie;
 *   - a state mismatch from the lib → 400 (`state-mismatch`) and clears the cookie;
 *   - an exchange failure → 502;
 *   - missing code → 400;
 *   - invalid JSON → 400.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const finishSpy = vi.fn();

vi.mock('@/lib/mcp/oauth-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mcp/oauth-server')>();
  return {
    ...actual,
    finishConnectorOAuth: (...args: unknown[]) => finishSpy(...args),
  };
});

import { POST } from '@/app/api/mcp/oauth/finish/route';
import {
  encodeFlowState,
  OAuthServerFlowError,
  type OAuthFlowState,
} from '@/lib/mcp/oauth-server';

const FLOW: OAuthFlowState = {
  state: 'csrf-state-123',
  codeVerifier: 'pkce-verifier-secret',
  connectorUrl: 'https://mcp.higgsfield.ai/mcp',
  authorizationServerUrl: 'https://auth.higgsfield.ai',
  redirectUri: 'https://app.example/mcp/oauth/callback',
  clientId: 'dcr-client-id',
  clientSecret: 'dcr-client-secret',
  startedAt: Date.now(),
};

const COOKIE = `m4n_mcp_oauth_flow=${encodeFlowState(FLOW)}`;

/**
 * Build a request-like object. happy-dom's `Request` constructor STRIPS
 * forbidden request headers (cookie/origin), so we build a `Headers` object via
 * `.set` (which retains them) and expose the `{ headers, json }` surface the
 * route uses — mirroring the real Next.js Node runtime where they ARE present.
 */
function postReq(body: unknown, cookie?: string): Request {
  const h = new Headers();
  h.set('content-type', 'application/json');
  h.set('origin', 'https://app.example');
  if (cookie !== undefined) h.set('cookie', cookie);
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    headers: h,
    json: async () => JSON.parse(text),
  } as unknown as Request;
}

function clearedCookie(setCookie: string | null): boolean {
  return !!setCookie && /m4n_mcp_oauth_flow=;/.test(setCookie) && /Max-Age=0/.test(setCookie);
}

beforeEach(() => {
  vi.clearAllMocks();
  finishSpy.mockResolvedValue({
    tokens: {
      access_token: 'final-access',
      token_type: 'Bearer',
      refresh_token: 'final-refresh',
      expires_in: 1800,
      scope: 'read',
    },
    clientInformation: { clientId: 'dcr-client-id', clientSecret: 'dcr-client-secret' },
  });
});

describe('POST /api/mcp/oauth/finish', () => {
  it('validates state, exchanges, returns tokens + clears the flow cookie', async () => {
    const res = await POST(postReq({ code: 'auth-code', state: 'csrf-state-123' }, COOKIE));
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      tokens: { accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string };
      connectorUrl: string;
      clientInformation: { clientId: string };
    };
    expect(json.tokens.accessToken).toBe('final-access');
    expect(json.tokens.refreshToken).toBe('final-refresh');
    expect(typeof json.tokens.expiresAt).toBe('number');
    expect(json.tokens.scope).toBe('read');
    expect(json.connectorUrl).toBe(FLOW.connectorUrl);
    expect(json.clientInformation.clientId).toBe('dcr-client-id');

    // Cookie cleared (single-use).
    expect(clearedCookie(res.headers.get('set-cookie'))).toBe(true);

    // The lib got the decoded flow, code, and returned state.
    expect(finishSpy).toHaveBeenCalledTimes(1);
    const [flowArg, codeArg, stateArg] = finishSpy.mock.calls[0];
    expect((flowArg as OAuthFlowState).codeVerifier).toBe('pkce-verifier-secret');
    expect(codeArg).toBe('auth-code');
    expect(stateArg).toBe('csrf-state-123');
  });

  it('400s (no-flow) when the flow cookie is missing, and still clears any cookie', async () => {
    const res = await POST(postReq({ code: 'auth-code', state: 'csrf-state-123' }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('no-flow');
    expect(clearedCookie(res.headers.get('set-cookie'))).toBe(true);
    expect(finishSpy).not.toHaveBeenCalled();
  });

  it('400s (no-flow) when the flow cookie is corrupt', async () => {
    const res = await POST(
      postReq({ code: 'auth-code', state: 'x' }, 'm4n_mcp_oauth_flow=not-base64-json!!!'),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('no-flow');
    expect(finishSpy).not.toHaveBeenCalled();
  });

  it('400s (state-mismatch) when the lib reports a CSRF mismatch, and clears the cookie', async () => {
    finishSpy.mockRejectedValue(
      new OAuthServerFlowError('OAuth state mismatch — possible CSRF, flow aborted'),
    );
    const res = await POST(postReq({ code: 'auth-code', state: 'WRONG' }, COOKIE));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('state-mismatch');
    expect(clearedCookie(res.headers.get('set-cookie'))).toBe(true);
  });

  it('502s on a token-exchange failure', async () => {
    finishSpy.mockRejectedValue(new OAuthServerFlowError('OAuth token exchange failed: 400'));
    const res = await POST(postReq({ code: 'auth-code', state: 'csrf-state-123' }, COOKIE));
    expect(res.status).toBe(502);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('oauth-finish-failed');
  });

  it('400s on a missing code, never exchanges', async () => {
    const res = await POST(postReq({ state: 'csrf-state-123' }, COOKIE));
    expect(res.status).toBe(400);
    expect(finishSpy).not.toHaveBeenCalled();
  });

  it('400s on invalid JSON', async () => {
    const res = await POST(postReq('{not json', COOKIE));
    expect(res.status).toBe(400);
    expect(finishSpy).not.toHaveBeenCalled();
  });
});
