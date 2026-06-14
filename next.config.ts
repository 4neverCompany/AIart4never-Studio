import type {NextConfig} from 'next';

const projectDir = import.meta.dirname;

// ---- V1.1.3-CORS: Web-Build CSP for camofox direct-connect ----
//
// The Tauri build CSP is in `src-tauri/tauri.conf.json` and already
// permits `connect-src http://127.0.0.1:9377-9380`. The Vercel web
// build (which loads at `https://mashupforge.vercel.app`) needs
// the same rule so a user with a standalone-installed camofox
// (see `docs/camofox-standalone-install.md`) can be reached from
// the browser. Vercel adds its own CSP by default that strips
// `connect-src` of loopback entries; we re-declare the full policy
// here so the sidecar can be reached.
//
// IMPORTANT: the 4-port range mirrors the 3-stage discovery in
// `src-tauri/src/lib.rs` (`CAMOFOX_PORTS = [9377, 9378, 9379, 9380]`).
// The two MUST stay in sync; a vitest regression test
// (`tests/api/next-config-csp.test.ts`) asserts the union on every CI
// run. We also add `127.0.0.1:9889` as the CORS-proxy fallback port
// (see `scripts/camofox-cors-proxy.mjs`) — the proxy listens on 9889
// by default and bridges to the real sidecar port.
const CAMOFOX_LOOPBACK_PORTS = [9377, 9378, 9379, 9380, 9889];
const CAMOFOX_CONNECT_SRC = CAMOFOX_LOOPBACK_PORTS
  .map((p) => `http://127.0.0.1:${p}`)
  .join(' ');

const WEB_CSP = [
  `default-src 'self'`,
  // 'unsafe-inline' is required for Next.js's runtime-injected
  // styles and is the existing v1.0 baseline. Style-src covers
  // both inline attributes and <style> tags.
  `style-src 'self' 'unsafe-inline'`,
  `font-src 'self' data:`,
  `img-src 'self' https://cdn.leonardo.ai https://picsum.photos data:`,
  // V1.1.3-CORS: the sidecar is reachable on 127.0.0.1:9377-9380
  // (CAMOFOX_PORTS) and the CORS-proxy fallback on 9889
  // (scripts/camofox-cors-proxy.mjs). Both are loopback so the
  // risk surface is the user's own machine.
  `connect-src 'self' ${CAMOFOX_CONNECT_SRC} https://cdn.leonardo.ai https://api.minimaxi.chat https://generativelanguage.googleapis.com`,
  `script-src 'self' 'unsafe-inline'`,
  // frame-src: allow the Higgsfield OAuth iframe-style auth flow
  // (it uses a popup window, not an iframe, but the directive
  // documents the intent for the next agent).
  `frame-src 'self'`,
  // base-uri: lock down <base> to 'self' to prevent the URL
  // hijack via <base href="...">.
  `base-uri 'self'`,
  `form-action 'self'`,
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    optimizePackageImports: ['lucide-react', 'motion'],
  },
  outputFileTracingExcludes: {
    '*': ['./src-tauri/**', './docs/**', './tests/**', './scripts/**', './.github/**'],
    // M3.3-P3 commit c: the `/api/pi/**` self-referential trace exclude
    // is gone with the pi route. The self-trace workaround for the
    // next.config.ts reference was a pi-route-only artifact.
  },
  // Expose the CI commit SHA so the desktop Settings panel can show the
  // exact build. Falls back to 'dev' in local dev. GITHUB_SHA is set by
  // GitHub Actions automatically on every push/PR run.
  env: {
    NEXT_PUBLIC_BUILD_SHA: (process.env.GITHUB_SHA ?? 'dev').slice(0, 7),
  },
  // Emit `.next/standalone/server.js` + a minimal `node_modules` subset so
  // the Tauri desktop bundle can ship a self-contained Next runtime. Vercel
  // ignores `output: 'standalone'` and uses its own adapter, so this is
  // safe for both deploy targets.
  output: 'standalone',
  // Pin the standalone trace root to THIS project dir. Without this Next
  // auto-detects a workspace root higher up (any ancestor with a lockfile)
  // and replicates that path tree inside .next/standalone, so server.js
  // ends up at `.next/standalone/projects/<name>/server.js` instead of the
  // flat layout our Tauri server wrapper expects.
  outputFileTracingRoot: projectDir,
  typescript: {
    ignoreBuildErrors: false,
  },
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'picsum.photos',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'cdn.leonardo.ai',
        port: '',
        pathname: '/**',
      },
    ],
  },
  // V1.1.3-CORS: Web-Build CSP. Vercel strips the default
  // Content-Security-Policy and replaces it with its own
  // Next-managed header, so we re-declare the policy here. On the
  // Tauri build the CSP comes from `src-tauri/tauri.conf.json` and
  // this `headers()` function is a no-op (Tauri serves the bundled
  // Next.js from a static dist and does not pass through
  // Next-managed headers).
  //
  // The Tauri-CSP test (`tests/api/tauri-csp.test.ts`) pins the
  // Tauri build's policy; this test pins the Vercel build's policy.
  // The two lists must agree on `connect-src` for the sidecar
  // ports — the `tests/api/next-config-csp.test.ts` regression
  // test asserts the union.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: WEB_CSP,
          },
          // Defense-in-depth: deny framing of our content by any
          // other origin. The Tauri-WebView loads from the
          // tauri:// origin so this is mostly relevant for the
          // Vercel deploy.
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
  // DEP-CLEANUP-2026-06-02: removed `transpilePackages: ['motion']`.
  // motion 12.x ships proper CJS + ESM exports (verified via
  // node_modules/motion/package.json `exports` map — `motion/react`
  // resolves to dist/es/react.mjs) so Next 16's automatic CJS/ESM
  // interop is sufficient. The directive was historically needed for
  // motion 11.x pre-exports, but the bump to ^12.40.0 makes it
  // redundant.
};

export default nextConfig;
// Re-export so the regression test can introspect the policy.
export { WEB_CSP, CAMOFOX_LOOPBACK_PORTS, CAMOFOX_CONNECT_SRC };
