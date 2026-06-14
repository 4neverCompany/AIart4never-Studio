import type {NextConfig} from 'next';

const projectDir = import.meta.dirname;

// AIart4never Studio web-build CSP (camofox sidecar CSP removed with the strip; the Tauri build CSP lives in src-tauri/tauri.conf.json).

const WEB_CSP = [
  `default-src 'self'`,
  // 'unsafe-inline' is required for Next.js's runtime-injected
  // styles and is the existing v1.0 baseline. Style-src covers
  // both inline attributes and <style> tags.
  `style-src 'self' 'unsafe-inline'`,
  `font-src 'self' data:`,
  `img-src 'self' https://picsum.photos data:`,
  `connect-src 'self' https://api.minimax.io`,
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
    ],
  },
  // Web-Build CSP. The web build strips the default
  // Content-Security-Policy and replaces it with its own
  // Next-managed header, so we re-declare the policy here. On the
  // Tauri build the CSP comes from `src-tauri/tauri.conf.json` and
  // this `headers()` function is a no-op (Tauri serves the bundled
  // Next.js from a static dist and does not pass through
  // Next-managed headers).
  //
  // The `tests/api/next-config-csp.test.ts` regression test pins
  // this web build's policy.
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
export { WEB_CSP };
