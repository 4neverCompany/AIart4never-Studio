/**
 * M2 — Generic MCP client manager: public surface.
 *
 * Re-exports the connector registry (persisted config CRUD + pure validators),
 * the thin SDK client wrapper, and the shared types. Import from `@/lib/mcp`
 * rather than reaching into the individual files.
 */

export type {
  McpTransportKind,
  McpServerConfig,
  McpToolInfo,
  McpConnectionState,
} from './types';

export {
  MCP_SERVERS_KEY,
  listServers,
  getServer,
  saveServer,
  removeServer,
  setEnabled,
  markTrusted,
  validateServerConfig,
  redactConfig,
} from './registry';
export type { ValidationResult } from './registry';

export {
  McpError,
  connectMcp,
  listMcpTools,
  callMcpTool,
} from './client';
export type { McpErrorCode, McpConnection } from './client';
