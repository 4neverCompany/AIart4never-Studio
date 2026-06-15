/**
 * 4NE-28 — per-connector health-check.
 *
 * Answers a single operator question for each registered MCP connector: "is
 * this thing reachable, and how many tools does it expose right now?" Built ON
 * TOP of the read-only `@/lib/mcp` surface (connect + listMcpTools + the
 * registry list); it never mutates the registry and never grants trust.
 *
 * The check is deliberately conservative and side-effect-light:
 *   - a DISABLED connector is reported `'disabled'` WITHOUT connecting (we do
 *     not probe something the operator has switched off);
 *   - an ENABLED connector is connected, its tools listed, and on success
 *     reported `'ok'` with a `toolCount` and a measured `latencyMs`;
 *   - any failure is classified from the thrown `McpError`: an auth-ish error
 *     (401/403 / "unauthorized" / "forbidden") → `'auth-error'`, a connect /
 *     transport failure → `'unreachable'`, anything else → `'error'`.
 *
 * The probe client is ALWAYS closed (success or failure) — a health check must
 * never leak a live connection. All side effects (connect / list / clock) are
 * injectable so tests run with no network and a deterministic clock.
 */

import {
  connectMcp as defaultConnectMcp,
  listMcpTools as defaultListMcpTools,
  listServers as defaultListServers,
  McpError,
  type McpServerConfig,
  type McpConnection,
} from '@/lib/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getErrorMessage } from '@/lib/errors';

/** Health verdict for a single connector. */
export type ConnectorHealthStatus =
  | 'ok'
  | 'disabled'
  | 'unreachable'
  | 'auth-error'
  | 'error';

/**
 * The result of one connector health check. JSON-serialisable so the CLI / a
 * future UI can render it directly. `toolCount` / `latencyMs` are present only
 * on `'ok'`; `error` carries the (already redaction-safe) message on a failure.
 */
export interface ConnectorHealth {
  id: string;
  name: string;
  status: ConnectorHealthStatus;
  /** Number of tools the server advertised (present on `'ok'`). */
  toolCount?: number;
  /** Round-trip ms for connect + listTools, from the injected clock (`'ok'`). */
  latencyMs?: number;
  /** Failure message (present on `'unreachable'` / `'auth-error'` / `'error'`). */
  error?: string;
  /** Epoch ms the check ran, from the injected clock. */
  checkedAt: number;
}

/**
 * Side effects injected into the health check. All default to the real
 * `@/lib/mcp` surface; tests pass spies so nothing touches the network.
 */
export interface HealthDeps {
  connect?: (cfg: McpServerConfig) => Promise<McpConnection>;
  list?: (client: Client) => Promise<unknown[]>;
  listServers?: () => Promise<McpServerConfig[]>;
  /** Clock for `checkedAt` + `latencyMs`. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Classify a thrown error into a health status. An {@link McpError} carries a
 * stable `code` plus a message we sniff for auth signals; anything else is a
 * generic `'error'`.
 *
 *  - auth-ish (401 / 403 / "unauthorized" / "forbidden" in the message, or a
 *    `tool-error` that reads as auth) → `'auth-error'`;
 *  - `connect-failed` / `not-yet-supported` / `list-tools-failed` (transport &
 *    handshake & listing failures) → `'unreachable'`;
 *  - everything else → `'error'`.
 */
function classifyError(e: unknown): { status: ConnectorHealthStatus; error: string } {
  const message = e instanceof Error ? e.message : getErrorMessage(e);
  const lower = message.toLowerCase();
  const looksAuth =
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('unauthor') ||
    lower.includes('forbidden') ||
    lower.includes('auth');

  if (looksAuth) {
    return { status: 'auth-error', error: message };
  }

  if (e instanceof McpError) {
    switch (e.code) {
      case 'connect-failed':
      case 'not-yet-supported':
      case 'list-tools-failed':
        return { status: 'unreachable', error: message };
      default:
        return { status: 'error', error: message };
    }
  }

  return { status: 'error', error: message };
}

/**
 * Check one connector's health.
 *
 * A disabled connector short-circuits to `'disabled'` WITHOUT connecting. An
 * enabled connector is connected, its tools listed, and the round-trip timed
 * via the injected `now`. The probe client is ALWAYS closed in a `finally`.
 */
export async function checkConnectorHealth(
  config: McpServerConfig,
  deps: HealthDeps = {},
): Promise<ConnectorHealth> {
  const connect = deps.connect ?? defaultConnectMcp;
  const list = deps.list ?? defaultListMcpTools;
  const now = deps.now ?? Date.now;

  const checkedAt = now();
  const base = { id: config.id, name: config.name, checkedAt };

  // Disabled → never connect. The operator has switched it off; report that.
  if (!config.enabled) {
    return { ...base, status: 'disabled' };
  }

  const startedAt = now();
  let connection: McpConnection | undefined;
  try {
    connection = await connect(config);
    const tools = await list(connection.client);
    const toolCount = Array.isArray(tools) ? tools.length : 0;
    return {
      ...base,
      status: 'ok',
      toolCount,
      latencyMs: now() - startedAt,
    };
  } catch (e) {
    const { status, error } = classifyError(e);
    return { ...base, status, error };
  } finally {
    // ALWAYS close — a health check must never leak a live connection. A close
    // failure is swallowed: it must not mask the health verdict.
    if (connection) {
      try {
        await connection.close();
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * Check every registered connector. Reads the registry via `listServers` and
 * runs {@link checkConnectorHealth} on each (sequentially — connector counts
 * are tiny and sequential keeps the latency numbers honest).
 */
export async function checkAllConnectors(
  deps: HealthDeps = {},
): Promise<ConnectorHealth[]> {
  const listServers = deps.listServers ?? defaultListServers;
  const servers = await listServers();
  const out: ConnectorHealth[] = [];
  for (const cfg of servers) {
    out.push(await checkConnectorHealth(cfg, deps));
  }
  return out;
}
