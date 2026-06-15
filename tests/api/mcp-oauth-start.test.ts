/**
 * POST /api/mcp/oauth/start — SERVER-SIDE OAuth begin (CORS-fix) tests.
 *
 * This route runs discovery + DCR + PKCE server-side so the browser never makes
 * a cross-origin fetch. We mock `@/lib/mcp/oauth-server`'s `startConnectorOAuth`
 * (the SDK network steps) but keep its cookie helpers REAL, so we assert:
 *
 *   - happy path: returns { authorizeUrl } AND sets the httpOnly flow cookie
 *     (HttpOnly + SameSite=Lax + Path=/api/mcp/oauth + Max-Age), carrying the
 *     encoded flow state; secrets (codeVerifier/clientSecret) are NOT in the body;
 *   - redirect_uri is derived from the request origin (web vs desktop);
 *   - missing/blank connectorUrl → 400, never calls the SDK;
 *   - invalid JSON → 400;
 *   - a lib OAuthServerFlowError (discovery/DCR) → 502.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const startSpy = vi.fn();

vi.mock('@/lib/mcp/oauth-server', async (importOriginal) => {
  // Keep the real cookie helpers / encode / deriveOrigin / error class; only
  // stub the network step.
  const actual = await importOriginal<typeof import('@/lib/mcp/oauth-server')>();
  return {
    ...actual,
    startConnectorOAuth: (...args: unknown[]) => startSpy(...args),
  };
});

import { POST } from '@/app/api/mcp/oauth/start/route';
import {
  decodeFlowState,
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

/**
 * Build a request-like object the route can consume. NOTE: happy-dom's `Request`
 * constructor STRIPS forbidden request headers (origin/host/cookie), so we build
 * a `Headers` object directly (via `.set`, which retains them) and expose the
 * minimal `{ headers, json }` surface the route uses. This mirrors the real
 * Next.js Node runtime, where those headers ARE present.
 */
function postReq(body: unknown, headers: Record<string, string> = {}): Request {
  const h = new Headers();
  h.set('content-type', 'application/json');
  h.set('origin', 'https://app.example');
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    headers: h,
    json: async () => JSON.parse(text),
  } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  startSpy.mockResolvedValue({
    authorizeUrl: 'https://auth.higgsfield.ai/authorize?state=csrf-state-123',
    flowState: FLOW,
  });
});

describe('POST /api/mcp/oauth/start', () => {
  it('returns authorizeUrl + sets the httpOnly flow cookie; secrets stay out of the body', async () => {
    const res = await POST(postReq({ connectorUrl: FLOW.connectorUrl }));
    expect(res.status).toBe(200);

    const json = (await res.json()) as { authorizeUrl: string };
    expect(json.authorizeUrl).toMatch(/^https:\/\/auth\.higgsfield\.ai\/authorize/);

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('m4n_mcp_oauth_flow=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/api/mcp/oauth');
    expect(setCookie).toContain('Max-Age=600');
    // https origin → Secure flag set.
    expect(setCookie).toContain('Secure');

    // The cookie carries the encoded flow state; the body does NOT leak secrets.
    const cookieValue = setCookie.split(';')[0].split('=').slice(1).join('=');
    const decoded = decodeFlowState(cookieValue);
    expect(decoded?.codeVerifier).toBe('pkce-verifier-secret');
    expect(decoded?.clientId).toBe('dcr-client-id');

    const bodyText = JSON.stringify(json);
    expect(bodyText).not.toContain('pkce-verifier-secret');
    expect(bodyText).not.toContain('dcr-client-secret');
  });

  it('derives the redirect_uri from the request origin (passed to the lib)', async () => {
    await POST(postReq({ connectorUrl: FLOW.connectorUrl }, { origin: 'https://web.vercel.app' }));
    expect(startSpy).toHaveBeenCalledTimes(1);
    const [, redirectUri] = startSpy.mock.calls[0];
    expect(redirectUri).toBe('https://web.vercel.app/mcp/oauth/callback');
  });

  it('derives the origin from x-forwarded-* when no Origin header (proxy/desktop)', async () => {
    // The bare `host` fallback is unit-tested directly in oauth-server.test.ts
    // via `Headers`; here we exercise the forwarded-header path Vercel sets.
    const h = new Headers();
    h.set('content-type', 'application/json');
    h.set('x-forwarded-proto', 'https');
    h.set('x-forwarded-host', 'studio.vercel.app');
    const req = {
      headers: h,
      json: async () => ({ connectorUrl: FLOW.connectorUrl }),
    } as unknown as Request;

    const res = await POST(req);
    expect(res.status).toBe(200);
    const [, redirectUri] = startSpy.mock.calls[0];
    expect(redirectUri).toBe('https://studio.vercel.app/mcp/oauth/callback');
    // https → Secure cookie.
    expect(res.headers.get('set-cookie')).toContain('Secure');
  });

  it('400s on a missing connectorUrl, never calls the SDK', async () => {
    const res = await POST(postReq({}));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; code: string };
    expect(json.code).toBe('bad-request');
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('400s on a blank connectorUrl', async () => {
    const res = await POST(postReq({ connectorUrl: '   ' }));
    expect(res.status).toBe(400);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('400s on invalid JSON', async () => {
    const res = await POST(postReq('{not json'));
    expect(res.status).toBe(400);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('maps a discovery/DCR OAuthServerFlowError to 502', async () => {
    startSpy.mockRejectedValue(
      new OAuthServerFlowError('OAuth discovery failed for https://mcp.higgsfield.ai/mcp: 500'),
    );
    const res = await POST(postReq({ connectorUrl: FLOW.connectorUrl }));
    expect(res.status).toBe(502);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('oauth-start-failed');
  });

  it('maps an invalid-url OAuthServerFlowError to 400', async () => {
    startSpy.mockRejectedValue(new OAuthServerFlowError('invalid connector url "bogus"'));
    const res = await POST(postReq({ connectorUrl: 'bogus' }));
    expect(res.status).toBe(400);
  });
});
