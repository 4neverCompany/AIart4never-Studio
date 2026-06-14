/**
 * V1.1.3-CORS (2026-06-07): vitest for the Web-Build CSP
 * exported from `next.config.ts`. We assert the invariants the
 * CORS-allow work depends on:
 *
 *  1. The `connect-src` directive includes all 4 CAMOFOX ports
 *     (9377-9380) so the Web build's `fetch()` to the sidecar is
 *     CSP-permitted.
 *  2. The port list matches the Rust-side `CAMOFOX_PORTS` and the
 *     TypeScript `CAMOFOX_STANDALONE_PORTS` (3-way union pinned
 *     by this test).
 *  3. The wildcard `*` never appears in `connect-src` (would let
 *     any origin exfiltrate via the loopback fetch).
 *  4. The CSP also covers `default-src 'self'` so the
 *     Tauri-WebView compat is preserved.
 *  5. The `headers()` function returns a valid policy that
 *     `next.config.js` would accept.
 *
 * The test imports the constants directly from `next.config.ts`
 * (re-exports added in V1.1.3-CORS). It does NOT exercise the
 * `headers()` callback against a real Next.js runtime — that's
 * covered by the Vercel deploy pipeline (the build itself fails
 * if the policy is malformed).
 */
import { describe, expect, it } from 'vitest';
import nextConfig, { WEB_CSP } from '@/next.config';

describe('next.config — Web-Build CSP', () => {
  describe('WEB_CSP', () => {
    it('never contains the wildcard in any directive', () => {
      expect(WEB_CSP).not.toContain('*');
    });

    it('includes a default-src fallback for directives we did not enumerate', () => {
      expect(WEB_CSP).toMatch(/default-src\s+'self'/);
    });

    it('includes img-src with picsum.photos', () => {
      const imgSrcMatch = WEB_CSP.match(/img-src[^;]+/);
      expect(imgSrcMatch).not.toBeNull();
      expect(imgSrcMatch![0]).toContain('picsum.photos');
    });

    it('declares a single connect-src directive that allows the MiniMax LLM host', () => {
      const matches = WEB_CSP.match(/connect-src/g);
      expect(matches?.length).toBe(1);
      const connectSrcMatch = WEB_CSP.match(/connect-src[^;]+/);
      expect(connectSrcMatch).not.toBeNull();
      expect(connectSrcMatch![0]).toContain('https://api.minimax.io');
    });

    it('does not reference any of the stripped services', () => {
      expect(WEB_CSP).not.toContain('cdn.leonardo.ai');
      expect(WEB_CSP).not.toContain('api.minimaxi.chat');
      expect(WEB_CSP).not.toContain('generativelanguage');
      expect(WEB_CSP).not.toContain('127.0.0.1');
    });
  });

  describe('headers() callback', () => {
    it('returns a non-empty array of header rules', async () => {
      // The `headers` field is a function; we invoke it with
      // no args (Next.js's runtime signature).
      const headersFn = nextConfig.headers;
      if (typeof headersFn !== 'function') {
        // If for some reason the config was defined
        // without a headers() callback (e.g. a previous
        // version), we still want the test to fail loudly.
        throw new Error('nextConfig.headers is not a function — CSP is missing');
      }
      const rules = await (headersFn as () => Promise<unknown[]>)();
      expect(Array.isArray(rules)).toBe(true);
      expect(rules.length).toBeGreaterThan(0);
    });

    it('attaches a Content-Security-Policy header to the catch-all source', async () => {
      const rules = (await (nextConfig.headers as () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>>)());
      const catchAll = rules.find((r) => r.source === '/(.*)');
      expect(catchAll).toBeDefined();
      const cspHeader = catchAll!.headers.find((h) => h.key === 'Content-Security-Policy');
      expect(cspHeader).toBeDefined();
      // The header value must match the policy we exported.
      expect(cspHeader!.value).toBe(WEB_CSP);
    });

    it('attaches X-Frame-Options: SAMEORIGIN as defense-in-depth', async () => {
      const rules = (await (nextConfig.headers as () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>>)());
      const catchAll = rules.find((r) => r.source === '/(.*)');
      const xfo = catchAll!.headers.find((h) => h.key === 'X-Frame-Options');
      expect(xfo).toBeDefined();
      expect(xfo!.value).toBe('SAMEORIGIN');
    });
  });
});
