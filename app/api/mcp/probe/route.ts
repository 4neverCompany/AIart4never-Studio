import { NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/errors';
import {
  connectMcp,
  listMcpTools,
  redactConfig,
  McpError,
  type McpServerConfig,
  type McpToolInfo,
  type McpConnection,
} from '@/lib/mcp';

/**
 * Server-side MCP connect-probe — the single MCP-reachability primitive for the
 * hosted web.
 *
 * WHY THIS EXISTS: connecting to a remote MCP server (Higgsfield / Composio /
 * …) from the BROWSER fails on the public web — those servers reject the
 * browser origin via CORS. The connector add/test/health flow used to run the
 * connect-probe CLIENT-side (`lib/mcp` `connectMcp`/`listMcpTools` from the
 * hook), so it broke on https://a-iart4never-studio.vercel.app. This route
 * moves the probe SERVER-SIDE (Node runtime, no CORS), mirroring the Option-B
 * pattern the `app/api/higgsfield/image` route already uses: the CLIENT passes
 * the resolved connector config in the body, the SERVER connects.
 *
 * The connector registry stays a CLIENT-side concern (it lives in browser
 * storage); this route never reads it — the client supplies the
 * {@link McpServerConfig}.
 *
 * Request shape:
 *   { config: McpServerConfig }   // the connector to probe
 *
 * Response (success, 200):
 *   { ok: true, tools: McpToolInfo[] }
 *
 * Response (failure, 4xx/5xx):
 *   { ok: false, error: string, code: string }
 *
 *   - invalid body / missing config / `transport:'stdio'` → 400 (the client
 *     can't fix a stdio connector by retrying — it's desktop-only).
 *   - auth-ish failure (401/403/"unauthorized"/"forbidden") → 401.
 *   - connect / transport / list-tools failure → 502 (upstream MCP fault).
 *   - anything else → 500.
 *
 * The probe client is ALWAYS closed in a `finally`. Tokens are NEVER logged —
 * any log of the config goes through `redactConfig` first.
 */
export const runtime = 'nodejs';

interface RequestBody {
  config?: unknown;
}

/**
 * Minimal structural guard that `config` is a usable {@link McpServerConfig}.
 * The deeper validation lives in the registry's `validateServerConfig`
 * (client-side); here we only need enough shape to hand to `connectMcp`.
 */
function isConnectorConfig(raw: unknown): raw is McpServerConfig {
  if (!raw || typeof raw !== 'object') return false;
  const c = raw as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    typeof c.name === 'string' &&
    (c.transport === 'http' || c.transport === 'stdio')
  );
}

/**
 * Map a thrown error to an HTTP status + a stable `code`. Mirrors the health
 * check's classification: auth signals → 401, connect/transport/list failures
 * → 502, everything else → 500.
 */
function classify(e: unknown): { status: number; code: string; message: string } {
  const message = getErrorMessage(e) || 'unknown error';
  const lower = message.toLowerCase();
  const looksAuth =
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('unauthor') ||
    lower.includes('forbidden') ||
    lower.includes('auth');

  if (looksAuth) {
    return { status: 401, code: 'auth-error', message };
  }

  if (e instanceof McpError) {
    switch (e.code) {
      case 'connect-failed':
      case 'not-yet-supported':
      case 'list-tools-failed':
        return { status: 502, code: e.code, message };
      default:
        return { status: 502, code: e.code, message };
    }
  }

  return { status: 500, code: 'error', message };
}

export async function POST(req: Request): Promise<Response> {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid JSON body', code: 'bad-request' },
      { status: 400 },
    );
  }

  if (!isConnectorConfig(body.config)) {
    return NextResponse.json(
      { ok: false, error: 'config is required (a valid MCP connector)', code: 'bad-request' },
      { status: 400 },
    );
  }
  const config = body.config;

  // stdio can't run in the hosted web (no subprocess sandbox here) — reject up
  // front with a clear, retry-proof 400 rather than letting connectMcp throw a
  // generic `not-yet-supported`.
  if (config.transport === 'stdio') {
    return NextResponse.json(
      {
        ok: false,
        error: "stdio connectors can't run in the hosted web; desktop only",
        code: 'stdio-unsupported',
      },
      { status: 400 },
    );
  }

  // Connect → list tools → return. ALWAYS close the client.
  let connection: McpConnection | undefined;
  try {
    connection = await connectMcp(config);
    const tools: McpToolInfo[] = await listMcpTools(connection.client);
    return NextResponse.json({ ok: true, tools });
  } catch (e) {
    const { status, code, message } = classify(e);
    return NextResponse.json({ ok: false, error: message, code }, { status });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch {
        /* best-effort: a close failure must not mask the probe outcome */
      }
    }
  }
}
