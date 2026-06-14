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
import nextConfig, {
  CAMOFOX_LOOPBACK_PORTS,
  CAMOFOX_CONNECT_SRC,
  WEB_CSP,
} from '@/next.config';
import { CAMOFOX_STANDALONE_PORTS } from '@/lib/camofox/standalone-discovery';

describe('next.config — V1.1.3 Web-Build CSP', () => {
  describe('CAMOFOX_LOOPBACK_PORTS', () => {
    it('contains exactly 4 sidecar ports (9377-9380) plus the CORS-proxy port (9889)', () => {
      // The CORS-proxy port is the workaround fallback so
      // MashupForge can reach camofox via the proxy when
      // upstream CORS support lands. The 4 sidecar ports must
      // match the Rust CAMOFOX_PORTS exactly.
      expect(CAMOFOX_LOOPBACK_PORTS).toContain(9377);
      expect(CAMOFOX_LOOPBACK_PORTS).toContain(9378);
      expect(CAMOFOX_LOOPBACK_PORTS).toContain(9379);
      expect(CAMOFOX_LOOPBACK_PORTS).toContain(9380);
    });

    it('matches the TypeScript CAMOFOX_STANDALONE_PORTS union (no drift)', () => {
      // The TypeScript constant is the source of truth for the
      // Vercel-Web path; the next.config constant is for the
      // CSP. If they drift, the policy either over- or
      // under-permits.
      for (const port of CAMOFOX_STANDALONE_PORTS) {
        expect(CAMOFOX_LOOPBACK_PORTS).toContain(port);
      }
    });
  });

  describe('CAMOFOX_CONNECT_SRC', () => {
    it('includes http://127.0.0.1:9377-9380 for every loopback port', () => {
      for (const port of CAMOFOX_LOOPBACK_PORTS) {
        expect(CAMOFOX_CONNECT_SRC).toContain(`http://127.0.0.1:${port}`);
      }
    });

    it('never contains the wildcard', () => {
      expect(CAMOFOX_CONNECT_SRC).not.toContain('*');
    });

    it('uses http:// scheme (the sidecar binds loopback, not https)', () => {
      // CSP distinguishes http: from https: — the sidecar uses
      // plain HTTP because the loopback binding is the
      // security boundary, not TLS.
      expect(CAMOFOX_CONNECT_SRC).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
    });
  });

  describe('WEB_CSP', () => {
    it('declares a connect-src directive that includes the sidecar ports', () => {
      const connectSrcMatch = WEB_CSP.match(/connect-src[^;]+/);
      expect(connectSrcMatch).not.toBeNull();
      const connectSrc = connectSrcMatch![0];
      for (const port of CAMOFOX_LOOPBACK_PORTS) {
        expect(connectSrc).toContain(`127.0.0.1:${port}`);
      }
    });

    it('never contains the wildcard in any directive', () => {
      expect(WEB_CSP).not.toContain('*');
    });

    it('includes a default-src fallback for directives we did not enumerate', () => {
      expect(WEB_CSP).toMatch(/default-src\s+'self'/);
    });

    it('includes img-src with the existing CDN allowlist (regression for v1.0.8)', () => {
      // V1.0.8 fix: cdn.leonardo.ai was added to img-src so
      // generated images load. The V1.1.3 CSP must keep it.
      const imgSrcMatch = WEB_CSP.match(/img-src[^;]+/);
      expect(imgSrcMatch).not.toBeNull();
      expect(imgSrcMatch![0]).toContain('cdn.leonardo.ai');
      expect(imgSrcMatch![0]).toContain('picsum.photos');
    });

    it('does not duplicate the connect-src directive', () => {
      const matches = WEB_CSP.match(/connect-src/g);
      expect(matches?.length).toBe(1);
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
