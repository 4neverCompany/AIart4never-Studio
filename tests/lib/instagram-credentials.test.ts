import { describe, it, expect } from 'vitest';
import { resolveInstagramCredentials } from '@/lib/instagram-credentials';

// IG-STALE-FIX regression gate for the body-first resolver.
//
// Inverts the previous env-first behaviour (INSTAGRAM-CRED-FIX) that
// caused stale Vercel env vars to override fresh browser credentials.
// Both /api/social/post and /api/social/best-times call this helper.
// If anyone changes the fallback order back to env-first or accidentally
// short-circuits with `??` (which would lock in an empty-string body
// value), Maurice's auto-post failure mode returns.
describe('resolveInstagramCredentials', () => {
  it('prefers body over env (web/cron path with fresh browser snapshot)', () => {
    // The Maurice scenario: stale env vars on Vercel + fresh body from
    // the browser snapshot. Body must win.
    const result = resolveInstagramCredentials(
      { INSTAGRAM_ACCOUNT_ID: '123stale', INSTAGRAM_ACCESS_TOKEN: 'EAA-19-days-old' },
      { igAccountId: '999fresh', accessToken: 'EAA-fresh-from-browser' },
    );
    expect(result.igAccountId).toBe('999fresh');
    expect(result.igAccessToken).toBe('EAA-fresh-from-browser');
  });

  it('falls through to env when body is undefined (server-only callers)', () => {
    const result = resolveInstagramCredentials(
      { INSTAGRAM_ACCOUNT_ID: '123', INSTAGRAM_ACCESS_TOKEN: 'EAAenv' },
      undefined,
    );
    expect(result.igAccountId).toBe('123');
    expect(result.igAccessToken).toBe('EAAenv');
  });

  it('falls through to env when body fields are empty strings', () => {
    // A user clearing a field client-side would send empty strings; we
    // shouldn't lock that in as "the answer" — env fallback gets to try.
    const result = resolveInstagramCredentials(
      { INSTAGRAM_ACCOUNT_ID: '123', INSTAGRAM_ACCESS_TOKEN: 'EAAenv' },
      { igAccountId: '', accessToken: '' },
    );
    expect(result.igAccountId).toBe('123');
    expect(result.igAccessToken).toBe('EAAenv');
  });

  it('falls through to env when body fields are whitespace-only', () => {
    const result = resolveInstagramCredentials(
      { INSTAGRAM_ACCOUNT_ID: '123', INSTAGRAM_ACCESS_TOKEN: 'EAAenv' },
      { igAccountId: '  ', accessToken: '\t\n' },
    );
    expect(result.igAccountId).toBe('123');
    expect(result.igAccessToken).toBe('EAAenv');
  });

  it('returns empty strings when neither source provides a value', () => {
    const result = resolveInstagramCredentials({}, undefined);
    expect(result.igAccountId).toBe('');
    expect(result.igAccessToken).toBe('');
  });

  it('falls through to env for whichever single field the body omits', () => {
    // Partial body (only one field set) — env covers the missing one.
    const result = resolveInstagramCredentials(
      { INSTAGRAM_ACCOUNT_ID: '123env', INSTAGRAM_ACCESS_TOKEN: 'EAAenv' },
      { accessToken: 'EAA-only-body-token' },
    );
    expect(result.igAccountId).toBe('123env');
    expect(result.igAccessToken).toBe('EAA-only-body-token');
  });

  it('trims surrounding whitespace from body values', () => {
    // Browsers occasionally include trailing newlines on paste; the
    // resolver should clean those before forwarding to the IG API
    // (which rejects whitespace inside token strings).
    const result = resolveInstagramCredentials(
      {},
      { igAccountId: '  999  ', accessToken: '  EAAbody  \n' },
    );
    expect(result.igAccountId).toBe('999');
    expect(result.igAccessToken).toBe('EAAbody');
  });

  it('uses body values when env keys are explicitly undefined', () => {
    // `npm run dev` and the Vercel runtime both ship a process.env that
    // simply doesn't have these keys — make sure the `||` chain treats
    // that the same as `{}`.
    const env: { INSTAGRAM_ACCOUNT_ID?: string; INSTAGRAM_ACCESS_TOKEN?: string } = {
      INSTAGRAM_ACCOUNT_ID: undefined,
      INSTAGRAM_ACCESS_TOKEN: undefined,
    };
    const result = resolveInstagramCredentials(env, {
      igAccountId: '999',
      accessToken: 'EAAbody',
    });
    expect(result.igAccountId).toBe('999');
    expect(result.igAccessToken).toBe('EAAbody');
  });
});
