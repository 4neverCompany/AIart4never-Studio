/**
 * Tests for GET /api/higgsfield/oauth/callback.
 *
 * The callback route exchanges the OAuth2 authorization code for
 * tokens. The crucial V1.2.10 fix: when the deep-link listener
 * re-issues the callback in the WebView cookie context, it passes
 * `?via=desktop`, and the route must return `mashupforge://oauth/callback`
 * (matching the redirect_uri used by /authorize) instead of
 * `tauri://localhost/api/...` (the WebView's own origin). Without
 * this, Higgsfield returns `invalid_grant` and the user sees
 * `Higgsfield connect failed (token_exchange): HTTP 400 ...`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- Mocks ---------------------------------------------------------------

const exchangeMock = vi.fn();
const saveTokensMock = vi.fn();
const cookieStore = new Map<string, { value: string }>();

vi.mock('@/lib/higgsfield/oauth', () => ({
  exchangeCodeForTokens: exchangeMock,
  decodeJwtPayload: vi.fn(() => ({ email: 'test@example.com', name: 'Test', org_id: 'org-1' })),
}));

vi.mock('@/lib/higgsfield/token-store', () => ({
  saveTokens: saveTokensMock,
}));

let tempDir: string;
vi.mock('@/lib/desktop-env', () => ({
  readDesktopConfigValue: (key: string) => {
    if (key === 'HIGGSFIELD_OAUTH_CLIENT_ID') {
      try {
        const { readFileSync } = require('node:fs') as typeof import('node:fs');
        const { join: pathJoin } = require('node:path') as typeof import('node:path');
        const config = JSON.parse(readFileSync(pathJoin(tempDir, 'config.json'), 'utf8'));
        return config.HIGGSFIELD_OAUTH_CLIENT_ID;
      } catch {
        return undefined;
      }
    }
    return undefined;
  },
  writeDesktopConfigValue: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => cookieStore.get(name),
    set: (name: string, value: string) => {
      cookieStore.set(name, { value });
    },
    delete: (name: string) => {
      cookieStore.delete(name);
    },
  }),
}));

// --- Setup ---------------------------------------------------------------

const ROUTE_URL_BASE = 'https://mashupforge.invalid';

beforeEach(() => {
  cookieStore.clear();
  cookieStore.set('higgsfield-oauth-state', { value: 'state-abc' });
  cookieStore.set('higgsfield-oauth-pkce', { value: 'verifier-xyz' });
  exchangeMock.mockReset();
  saveTokensMock.mockReset();
  tempDir = mkdtempSync(join(tmpdir(), 'mashupforge-callback-'));
  writeFileSync(
    join(tempDir, 'config.json'),
    JSON.stringify({ HIGGSFIELD_OAUTH_CLIENT_ID: 'client-123' }, null, 2),
    'utf8',
  );
  exchangeMock.mockResolvedValue({
    access_token: 'at',
    refresh_token: 'rt',
    id_token: 'id',
    expires_in: 3600,
  });
  saveTokensMock.mockResolvedValue(undefined);
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// --- Tests ---------------------------------------------------------------

describe('GET /api/higgsfield/oauth/callback', () => {
  it('passes mashupforge://oauth/callback to exchangeCodeForTokens when ?via=desktop', async () => {
    const { GET } = await import('@/app/api/higgsfield/oauth/callback/route');
    const req = new Request(
      `${ROUTE_URL_BASE}/api/higgsfield/oauth/callback?via=desktop&code=AUTH_CODE&state=state-abc`,
    );
    const res = await GET(req);
    expect(res.status).toBe(307); // NextResponse.redirect default
    expect(exchangeMock).toHaveBeenCalledTimes(1);
    const callArg = exchangeMock.mock.calls[0][0];
    expect(callArg.redirectUri).toBe('mashupforge://oauth/callback');
    expect(callArg.clientId).toBe('client-123');
    expect(callArg.code).toBe('AUTH_CODE');
    expect(callArg.codeVerifier).toBe('verifier-xyz');
  });

  it('passes https://origin/api/.../callback to exchangeCodeForTokens when NOT via=desktop (web)', async () => {
    const { GET } = await import('@/app/api/higgsfield/oauth/callback/route');
    const req = new Request(
      `${ROUTE_URL_BASE}/api/higgsfield/oauth/callback?code=AUTH_CODE&state=state-abc`,
    );
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(exchangeMock).toHaveBeenCalledTimes(1);
    const callArg = exchangeMock.mock.calls[0][0];
    expect(callArg.redirectUri).toBe(`${ROUTE_URL_BASE}/api/higgsfield/oauth/callback`);
  });

  it('redirects to /studio?higgsfield=connected on success', async () => {
    const { GET } = await import('@/app/api/higgsfield/oauth/callback/route');
    const req = new Request(
      `${ROUTE_URL_BASE}/api/higgsfield/oauth/callback?via=desktop&code=AUTH_CODE&state=state-abc`,
    );
    const res = await GET(req);
    expect(res.status).toBe(307);
    const location = res.headers.get('location');
    expect(location).toBe(`${ROUTE_URL_BASE}/studio?higgsfield=connected`);
  });

  it('redirects to /studio?higgsfield=error&reason=token_exchange when exchange throws', async () => {
    exchangeMock.mockRejectedValueOnce(new Error('HTTP 400 invalid_grant'));
    const { GET } = await import('@/app/api/higgsfield/oauth/callback/route');
    const req = new Request(
      `${ROUTE_URL_BASE}/api/higgsfield/oauth/callback?via=desktop&code=AUTH_CODE&state=state-abc`,
    );
    const res = await GET(req);
    const location = res.headers.get('location');
    expect(location).toContain('higgsfield=error');
    expect(location).toContain('reason=token_exchange');
  });

  it('redirects to /studio?higgsfield=error&reason=state_mismatch when state does not match cookie', async () => {
    const { GET } = await import('@/app/api/higgsfield/oauth/callback/route');
    const req = new Request(
      `${ROUTE_URL_BASE}/api/higgsfield/oauth/callback?via=desktop&code=AUTH_CODE&state=WRONG_STATE`,
    );
    const res = await GET(req);
    const location = res.headers.get('location');
    expect(location).toContain('higgsfield=error');
    expect(location).toContain('reason=state_mismatch');
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it('redirects to /studio?higgsfield=error&reason=expired_flow when PKCE cookie is missing', async () => {
    cookieStore.delete('higgsfield-oauth-pkce');
    const { GET } = await import('@/app/api/higgsfield/oauth/callback/route');
    const req = new Request(
      `${ROUTE_URL_BASE}/api/higgsfield/oauth/callback?via=desktop&code=AUTH_CODE&state=state-abc`,
    );
    const res = await GET(req);
    const location = res.headers.get('location');
    expect(location).toContain('higgsfield=error');
    expect(location).toContain('reason=expired_flow');
  });
});
