/**
 * Tests for lib/higgsfield/oauth.ts — OAuth 2.0 + PKCE helpers.
 *
 * Pure-function tests (no network). The PKCE pair + state-cookie +
 * URL builder are the only pure functions in the module; the rest
 * are HTTP wrappers that the route-handler tests cover.
 */

import { describe, it, expect } from 'vitest';
import {
  buildAuthorizeUrl,
  decodeJwtPayload,
  generatePkcePair,
  HIGGSFIELD_OAUTH_AUTHORIZE,
  HIGGSFIELD_OAUTH_SCOPE,
  HIGGSFIELD_OAUTH_TOKEN,
  HIGGSFIELD_MCP_ISSUER,
  HIGGSFIELD_MCP_SERVER_URL,
} from '@/lib/higgsfield/oauth';

describe('generatePkcePair', () => {
  it('produces a verifier and challenge of the right shape', () => {
    const { verifier, challenge } = generatePkcePair();
    // 64 random bytes → 86 base64url chars (no padding). RFC 7636
    // requires 43-128; we exceed the minimum.
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    // base64url alphabet only — no `+`, `/`, or `=`.
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('each call produces a fresh pair (no static values)', () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe('buildAuthorizeUrl', () => {
  it('produces a URL at the canonical /oauth2/authorize endpoint with all required params', () => {
    const url = buildAuthorizeUrl({
      clientId: 'mashupforge-123',
      redirectUri: 'https://mashupforge.app/api/higgsfield/oauth/callback',
      state: 'opaque-csrf-token',
      codeChallenge: 'challenge-abc',
    });
    expect(url.startsWith(HIGGSFIELD_OAUTH_AUTHORIZE + '?')).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('client_id')).toBe('mashupforge-123');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://mashupforge.app/api/higgsfield/oauth/callback');
    expect(parsed.searchParams.get('state')).toBe('opaque-csrf-token');
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    // Scope must include offline_access (refresh tokens require it).
    expect(parsed.searchParams.get('scope')).toBe(HIGGSFIELD_OAUTH_SCOPE);
    expect(parsed.searchParams.get('scope')).toContain('offline_access');
  });
});

describe('decodeJwtPayload', () => {
  it('decodes the middle segment of a standard JWT', () => {
    // Header: {"alg":"none","typ":"JWT"} → base64url
    // Payload: {"sub":"user-1","email":"a@b.c","org_id":"org-7","exp":9999999999}
    // Signature: anything (we don't verify)
    const header = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url');
    const payload = Buffer.from(
      '{"sub":"user-1","email":"a@b.c","org_id":"org-7","exp":9999999999}',
    ).toString('base64url');
    const token = `${header}.${payload}.sig`;
    const claims = decodeJwtPayload(token);
    expect(claims?.sub).toBe('user-1');
    expect(claims?.email).toBe('a@b.c');
    expect(claims?.org_id).toBe('org-7');
    expect(claims?.exp).toBe(9999999999);
  });
  it('returns null for non-JWT strings', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeNull();
    expect(decodeJwtPayload('a.b')).toBeNull();
    expect(decodeJwtPayload('a.b.c.d')).toBeNull();
    expect(decodeJwtPayload('')).toBeNull();
  });
  it('returns null for malformed payload JSON', () => {
    const header = Buffer.from('{}').toString('base64url');
    const payload = Buffer.from('not-json').toString('base64url');
    expect(decodeJwtPayload(`${header}.${payload}.sig`)).toBeNull();
  });
});

describe('module-level constants', () => {
  it('the MCP server URL is exactly what the docs say', () => {
    expect(HIGGSFIELD_MCP_SERVER_URL).toBe('https://mcp.higgsfield.ai/mcp');
  });
  it('issuer + endpoints form a consistent URL set', () => {
    expect(HIGGSFIELD_MCP_ISSUER).toBe('https://mcp.higgsfield.ai');
    expect(HIGGSFIELD_OAUTH_TOKEN.startsWith(HIGGSFIELD_MCP_ISSUER)).toBe(true);
    expect(HIGGSFIELD_OAUTH_AUTHORIZE.startsWith(HIGGSFIELD_MCP_ISSUER)).toBe(true);
  });
});
