/**
 * M2 — Generic MCP client wrapper (thin layer over `@modelcontextprotocol/sdk`).
 *
 * Responsibilities, deliberately small:
 *   - `connectMcp`    — build a `Client` + the right transport from a config,
 *                       connect, and hand back `{ client, close }`.
 *   - `listMcpTools`  — list a connected server's tools, normalised to
 *                       {@link McpToolInfo}.
 *   - `callMcpTool`   — invoke one tool and return its result content.
 *
 * Everything the SDK can throw is wrapped in a typed {@link McpError} so the
 * caller never has to know the SDK's error shapes. We NEVER auto-retry — a
 * tool call may be destructive, and silently re-issuing it could double-spend
 * credits or duplicate side effects. Retry is a deliberate caller decision.
 *
 * SDK import paths (confirmed against node_modules/@modelcontextprotocol/sdk
 * v1.29.0 — package is ESM, `type: module`, exports map under `./client`):
 *   - `Client`                      ← `@modelcontextprotocol/sdk/client/index.js`
 *   - `StreamableHTTPClientTransport`
 *                                   ← `@modelcontextprotocol/sdk/client/streamableHttp.js`
 *
 * stdio is DEFERRED: spawning a local subprocess needs desktop sandboxing
 * (allow-list, working dir, env scrubbing) that belongs to a later increment.
 * Rather than half-implement it, `connectMcp` throws a clear `not-yet-supported`
 * McpError for `transport === 'stdio'`.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getErrorMessage } from '@/lib/errors';
import type { McpServerConfig, McpToolInfo } from './types';

/** Client identity advertised to MCP servers during the init handshake. */
const CLIENT_INFO = { name: 'master4never-agent', version: '0.1.0' } as const;

/**
 * Typed wrapper for every failure surfaced by this module. `code` is a stable
 * string callers can branch on; `cause` preserves the original throwable.
 *
 * Codes:
 *   - `not-yet-supported` — feature deferred (e.g. stdio transport).
 *   - `connect-failed`    — transport/handshake failed.
 *   - `list-tools-failed` — `listTools` threw.
 *   - `call-tool-failed`  — `callTool` threw.
 *   - `tool-error`        — the tool ran but returned `isError: true`.
 */
export type McpErrorCode =
  | 'not-yet-supported'
  | 'connect-failed'
  | 'list-tools-failed'
  | 'call-tool-failed'
  | 'tool-error';

export class McpError extends Error {
  readonly code: McpErrorCode;
  readonly cause?: unknown;

  constructor(code: McpErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
    // Preserve `instanceof` after ES2017 transpilation.
    Object.setPrototypeOf(this, McpError.prototype);
  }
}

/**
 * A live MCP connection. `client` is the raw SDK client (for advanced use);
 * `close` tears the connection down and must always be called when done.
 */
export interface McpConnection {
  client: Client;
  close: () => Promise<void>;
}

/**
 * Connect to the MCP server described by `cfg` and return the live client.
 *
 * - `transport === 'http'`  → builds a {@link StreamableHTTPClientTransport}
 *   from `cfg.url`, threading `cfg.headers` through the transport's
 *   `requestInit.headers`.
 * - `transport === 'stdio'` → throws `not-yet-supported` (see module docs).
 *
 * Connecting does NOT imply trust — trust is operator-granted in the registry
 * (see `lib/mcp/registry.ts`). An `AbortSignal` may be supplied to cancel a
 * slow handshake.
 */
export async function connectMcp(
  cfg: McpServerConfig,
  opts?: { signal?: AbortSignal },
): Promise<McpConnection> {
  if (cfg.transport === 'stdio') {
    throw new McpError(
      'not-yet-supported',
      "stdio transport is not yet supported (desktop subprocess sandboxing is a later increment); use an 'http' connector for now",
    );
  }

  if (cfg.transport !== 'http') {
    throw new McpError(
      'connect-failed',
      `unknown transport "${String(cfg.transport)}"`,
    );
  }

  if (!cfg.url) {
    throw new McpError('connect-failed', 'http transport requires a url');
  }

  let url: URL;
  try {
    url = new URL(cfg.url);
  } catch (e) {
    throw new McpError('connect-failed', `invalid url "${cfg.url}"`, e);
  }

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
  });

  const client = new Client(CLIENT_INFO, { capabilities: {} });

  try {
    await client.connect(transport, opts?.signal ? { signal: opts.signal } : undefined);
  } catch (e) {
    // Best-effort cleanup of the half-open transport before surfacing.
    try {
      await client.close();
    } catch {
      /* ignore secondary close error */
    }
    throw new McpError(
      'connect-failed',
      `failed to connect to MCP server "${cfg.name}": ${getErrorMessage(e)}`,
      e,
    );
  }

  return {
    client,
    close: async () => {
      try {
        await client.close();
      } catch (e) {
        throw new McpError(
          'connect-failed',
          `failed to close MCP connection "${cfg.name}": ${getErrorMessage(e)}`,
          e,
        );
      }
    },
  };
}

/**
 * List the tools a connected server advertises, mapped to {@link McpToolInfo}.
 * Only `name` / `description` / `inputSchema` are surfaced — the rest of the
 * SDK's tool shape is intentionally dropped to keep the app surface small.
 */
export async function listMcpTools(client: Client): Promise<McpToolInfo[]> {
  let result: Awaited<ReturnType<Client['listTools']>>;
  try {
    result = await client.listTools();
  } catch (e) {
    throw new McpError('list-tools-failed', `listTools failed: ${getErrorMessage(e)}`, e);
  }

  const tools = Array.isArray(result?.tools) ? result.tools : [];
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/**
 * Call one tool by name with `args` and return its result content.
 *
 * If the server responds with `isError: true`, we throw a `tool-error`
 * McpError (the tool ran but reported failure) rather than returning a
 * success-shaped value. We do NOT auto-retry — see the module docs.
 */
export async function callMcpTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  let result: Awaited<ReturnType<Client['callTool']>>;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch (e) {
    throw new McpError(
      'call-tool-failed',
      `callTool "${name}" failed: ${getErrorMessage(e)}`,
      e,
    );
  }

  if (result && typeof result === 'object' && 'isError' in result && result.isError) {
    throw new McpError(
      'tool-error',
      `tool "${name}" returned an error result`,
      result,
    );
  }

  // Prefer the structured `content` array; fall back to the whole result for
  // the compatibility `{ toolResult }` shape.
  if (result && typeof result === 'object' && 'content' in result) {
    return (result as { content: unknown }).content;
  }
  return result;
}
