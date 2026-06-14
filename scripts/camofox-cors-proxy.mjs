#!/usr/bin/env node
// scripts/camofox-cors-proxy.mjs
//
// V1.1.3-CORS (2026-06-07): tiny CORS-proxy workaround for
// `@askjo/camofox-browser@1.11.2`. The upstream server binds to
// 127.0.0.1 and emits NO CORS headers (verified 2026-06-07 — see
// the env-vars table in the upstream README at
// https://github.com/jo-inc/camofox-browser). That means the
// Vercel-Web build at https://mashupforge.vercel.app can't reach
// the sidecar from a browser fetch, even with the
// `connect-src 127.0.0.1:9377-9380` CSP we ship in
// `next.config.ts`.
//
// This script bridges that gap. It listens on a single port
// (default 9889) and forwards every request to the real
// camofox sidecar (discovered on 9377-9380), stripping the
// loopback-only restriction by adding a CORS allow-origin
// header. The allowed origins come from the same
// `CAMOFOX_CORS_ORIGINS` env-var the Rust side uses, so the
// two configurations stay in sync.
//
// USAGE:
//   # Local dev — defaults are fine:
//   node scripts/camofox-cors-proxy.mjs
//
//   # Or with explicit origins (comma-separated, http/https only):
//   CAMOFOX_CORS_ORIGINS="http://localhost:3000,https://mashupforge.vercel.app" \
//     node scripts/camofox-cors-proxy.mjs
//
//   # Or override the listener / upstream port:
//   CAMOFOX_CORS_PROXY_PORT=9889 \
//   CAMOFOX_SIDECAR_PORT=9377 \
//     node scripts/camofox-cors-proxy.mjs
//
// SECURITY:
//   - The proxy binds to 127.0.0.1 by default. Pass --host 0.0.0.0
//     ONLY if you understand that every machine on the LAN can
//     now drive your local camofox instance.
//   - The default origin whitelist (no `*`) prevents a malicious
//     page in another tab from using the sidecar. See
//     `lib/camofox/cors-config.ts` for the full rationale.
//   - The proxy does NOT authenticate the camofox API key
//     (`CAMOFOX_API_KEY`). If you've set that on the sidecar, the
//     proxy inherits the trust — anyone who can reach 9889 can
//     drive the sidecar as you. Bind to 127.0.0.1 (the default)
//     and pair with a firewall rule if you need LAN access.
//
//   No third-party deps — stdlib only (node:http, node:url,
//   node:process). Why: this script is a workaround for a
//   cross-origin problem; adding a 50MB-of-deps CORS library
//   would be a self-defeating move. The 100-line stdlib version
//   is also auditable in a single read.

import http from 'node:http';
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';

const PROXY_PORT = Number.parseInt(process.env.CAMOFOX_CORS_PROXY_PORT ?? '9889', 10);
const PROXY_HOST = process.env.CAMOFOX_CORS_PROXY_HOST ?? '127.0.0.1';
const SIDECAR_PORTS = (process.env.CAMOFOX_SIDECAR_PORTS ?? '9377,9378,9379,9380')
  .split(',')
  .map((s) => Number.parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0 && n < 65536);

// Parse origins using the same rules as the TypeScript / Rust
// helpers. Mirrored inline because this script runs without a
// transpiler; keep in sync with `lib/camofox/cors-config.ts`
// and `src-tauri/src/lib.rs:resolve_camofox_cors_origins`.
const DEFAULT_ORIGINS = ['http://localhost:3000', 'https://mashupforge.vercel.app'];
function parseOrigins(raw) {
  if (!raw || !raw.trim()) return { origins: DEFAULT_ORIGINS, isDefault: true };
  const filtered = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => s !== '*')
    .filter((s) => s.startsWith('http://') || s.startsWith('https://'));
  return { origins: filtered.length > 0 ? filtered : DEFAULT_ORIGINS, isDefault: filtered.length === 0 };
}
const { origins: ALLOWED_ORIGINS, isDefault: ORIGINS_DEFAULTED } = parseOrigins(
  process.env.CAMOFOX_CORS_ORIGINS,
);

const SIDECAR_BASE = `http://127.0.0.1:${SIDECAR_PORTS[0]}`;

// Health-check the sidecar once at boot so the user gets a clear
// error if they forgot to start camofox. We don't fail-hard —
// the proxy still starts and surfaces the upstream error on
// the first request — but we log the warning so it's visible
// in `camofox-cors-proxy.log`.
async function probeSidecar() {
  for (const port of SIDECAR_PORTS) {
    try {
      const ok = await new Promise((resolve) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 1500 },
          (res) => {
            // Drain the body so the socket can close.
            res.resume();
            resolve(res.statusCode === 200);
          },
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      });
      if (ok) {
        console.log(`[cors-proxy] sidecar responding on http://127.0.0.1:${port}`);
        return;
      }
    } catch {
      // fall through to next port
    }
  }
  console.warn(
    `[cors-proxy] WARNING: no camofox sidecar found on ${SIDECAR_PORTS.join(', ')}.\n` +
      '          Start camofox (or the Tauri app) before browsing the Vercel-Web build.\n' +
      '          See docs/camofox-standalone-install.md for the standalone-install path.',
  );
}

function isOriginAllowed(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin);
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] ?? 'Content-Type,Authorization',
    );
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

const server = http.createServer((req, res) => {
  setCorsHeaders(req, res);

  // Short-circuit preflight.
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Reject requests whose Origin is set but not in the
  // whitelist. The browser would also reject, but doing it
  // server-side gives a clearer 403 body.
  const origin = req.headers.origin;
  if (origin && !isOriginAllowed(origin)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: 'Origin not allowed by camofox CORS proxy',
        origin,
        allowed: ALLOWED_ORIGINS,
      }),
    );
    return;
  }

  // Forward the request to the sidecar. We always go to
  // SIDECAR_BASE for simplicity (the Rust side has its own
  // 3-stage port discovery; the proxy just trusts whatever
  // SIDECAR_PORTS[0] points at). A more elaborate version
  // would mirror the 3-stage discovery, but that adds
  // complexity for a 4-port range and a workaround script.
  const target = new URL(req.url ?? '/', SIDECAR_BASE);
  const opts = {
    host: target.hostname,
    port: target.port,
    path: target.pathname + target.search,
    method: req.method,
    headers: { ...req.headers, host: target.host },
  };
  const upstream = httpRequest(opts, (upstreamRes) => {
    res.statusCode = upstreamRes.statusCode ?? 502;
    for (const [k, v] of Object.entries(upstreamRes.headers)) {
      // Strip the sidecar's own (nonexistent) CORS headers so
      // ours win. Strip hop-by-hop headers per RFC 7230.
      if (k.toLowerCase() === 'access-control-allow-origin') continue;
      if (k.toLowerCase() === 'access-control-allow-methods') continue;
      if (k.toLowerCase() === 'access-control-allow-headers') continue;
      if (k.toLowerCase() === 'connection') continue;
      if (v !== undefined) res.setHeader(k, v);
    }
    setCorsHeaders(req, res);
    upstreamRes.pipe(res);
  });
  upstream.on('error', (err) => {
    console.error(`[cors-proxy] upstream error: ${err.message}`);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
    }
    res.end(
      JSON.stringify({
        error: 'camofox sidecar unreachable',
        sidecar: SIDECAR_BASE,
        message: err.message,
      }),
    );
  });
  req.pipe(upstream);
});

server.listen(PROXY_PORT, PROXY_HOST, () => {
  console.log(`[cors-proxy] listening on http://${PROXY_HOST}:${PROXY_PORT}`);
  console.log(`[cors-proxy] forwarding to ${SIDECAR_BASE}`);
  console.log(
    `[cors-proxy] allowed origins: ${ALLOWED_ORIGINS.join(', ')}${ORIGINS_DEFAULTED ? ' (default)' : ''}`,
  );
  probeSidecar().catch((err) => console.error('[cors-proxy] probe failed:', err));
});

// Graceful shutdown so the user's terminal Ctrl-C doesn't leak
// the proxy with an open port.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[cors-proxy] ${sig} received, closing`);
    server.close(() => process.exit(0));
  });
}
