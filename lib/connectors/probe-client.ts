'use client';

/**
 * CLIENT-side adapter that routes the MCP connect-probe through the SERVER
 * (`POST /api/mcp/probe`) instead of connecting from the browser.
 *
 * WHY: connecting to a remote MCP server (Higgsfield / Composio / …) from the
 * BROWSER fails on the public web — those servers reject the browser origin via
 * CORS. So the connector add/test/health flow must probe SERVER-SIDE. This
 * module produces `connect` / `list` implementations with the SAME shapes the
 * lib's `confirmAndInstall` (install.ts) and `checkConnectorHealth` (health.ts)
 * already inject — so we keep the deps-injection seam intact (the lib functions
 * never hardcode a fetch; the hook/component layer injects this) and the lib's
 * external contract + existing tests are unchanged.
 *
 * The adaptation: `connect(config)` POSTs the config to `/api/mcp/probe`, which
 * connects server-side and returns the tool list. On success we hand back a
 * fake {@link McpConnection} whose `client` merely carries that tool list and
 * whose `close` is a no-op (the server already closed the real connection).
 * `list(client)` returns the carried tools. On failure `connect` THROWS an
 * {@link McpError} with the server's `code`, so the lib's existing error
 * handling fires: `confirmAndInstall` lands in its `probe` stage and
 * `checkConnectorHealth` classifies it (`auth-error` / `unreachable` / `error`).
 */

import {
  McpError,
  type McpServerConfig,
  type McpToolInfo,
  type McpConnection,
  type McpErrorCode,
} from '@/lib/mcp';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getErrorMessage } from '@/lib/errors';

/** The server probe route's success/failure response shape. */
interface ProbeResponse {
  ok: boolean;
  tools?: McpToolInfo[];
  error?: string;
  code?: string;
}

/**
 * A fake client that just carries the tools the server returned. We cast it to
 * the SDK `Client` so it satisfies the `connect`/`list` dep types without
 * dragging in a real SDK client (which would re-introduce the CORS problem).
 */
interface ProbeClient {
  __probeTools: McpToolInfo[];
}

const PROBE_ENDPOINT = '/api/mcp/probe';

/** Map the server's stringy `code` back onto a known {@link McpErrorCode}. */
function toMcpErrorCode(code: string | undefined): McpErrorCode {
  switch (code) {
    case 'not-yet-supported':
    case 'connect-failed':
    case 'list-tools-failed':
    case 'call-tool-failed':
    case 'tool-error':
      return code;
    default:
      // Anything else (auth-error / bad-request / stdio-unsupported / error)
      // maps to a connect failure — health.ts treats `connect-failed` as
      // `unreachable`, and the message preserves the auth signal for the
      // `looksAuth` sniff to upgrade it to `auth-error`.
      return 'connect-failed';
  }
}

/**
 * `connect` dep backed by the server probe. POSTs `{ config }` to
 * `/api/mcp/probe`; on `{ ok: true }` returns a fake connection carrying the
 * tools; on `{ ok: false }` (or a non-2xx / network error) throws an McpError.
 */
async function probeConnect(config: McpServerConfig): Promise<McpConnection> {
  let res: Response;
  try {
    res = await fetch(PROBE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    });
  } catch (e) {
    // Network-level failure reaching our own route.
    throw new McpError(
      'connect-failed',
      `MCP probe request failed: ${getErrorMessage(e)}`,
      e,
    );
  }

  let data: ProbeResponse;
  try {
    data = (await res.json()) as ProbeResponse;
  } catch {
    throw new McpError(
      'connect-failed',
      `MCP probe returned a non-JSON response (status ${res.status})`,
    );
  }

  if (!res.ok || !data.ok) {
    const message = data.error || `MCP probe failed (status ${res.status})`;
    throw new McpError(toMcpErrorCode(data.code), message);
  }

  const tools = Array.isArray(data.tools) ? data.tools : [];
  const probeClient: ProbeClient = { __probeTools: tools };

  return {
    // The server already connected + closed the real client; this fake one
    // only carries the tool list for `probeList` to read.
    client: probeClient as unknown as Client,
    close: async () => {
      /* no-op: the server-side probe already closed the real connection */
    },
  };
}

/** `list` dep that reads the tools `probeConnect` stashed on the fake client. */
async function probeList(client: Client): Promise<McpToolInfo[]> {
  const probeClient = client as unknown as Partial<ProbeClient>;
  return Array.isArray(probeClient.__probeTools) ? probeClient.__probeTools : [];
}

/**
 * The server-backed probe deps to inject into `confirmAndInstall` /
 * `checkConnectorHealth` / `checkAllConnectors` from the hook/component layer.
 * Shapes match the lib's defaults exactly, so they drop in as `connect`/`list`.
 */
export const serverProbeDeps = {
  connect: probeConnect,
  list: probeList,
} as const;
