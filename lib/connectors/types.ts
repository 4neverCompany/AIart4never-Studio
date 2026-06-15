/**
 * M2 — Connectors & Skills manager: shared types.
 *
 * This module sits ON TOP of the read-only `lib/mcp` registry. Where `lib/mcp`
 * stores arbitrary connector rows and connects to them, `lib/connectors` adds
 * two things on top:
 *
 *   1. The FR-22 *agentic-install* flow (`install.ts`) — a propose → operator
 *      confirm → commit pipeline that is the ONLY way a connector enters the
 *      registry, and the only place trust is granted.
 *   2. The *Skills* layer (`skills.ts`) — named, least-privilege bundles that
 *      grant the agent a SUBSET of a connector's tools rather than the whole
 *      server.
 *
 * Nothing here imports the MCP SDK; these are framework-free data shapes shared
 * by the install flow, the skills store, and the future Connectors manager UI.
 */

import type { McpServerConfig, McpToolInfo } from '@/lib/mcp';

/**
 * The result of `proposeConnector`: a fully-formed candidate config that has
 * NOT been persisted and is NOT trusted/enabled, plus a log-safe `redactedView`
 * (secrets masked via `redactConfig`) and any non-fatal validation warnings.
 *
 * The operator inspects this — specifically `redactedView` — before confirming.
 * `config` carries the real (unredacted) secrets and is what gets committed on
 * confirm; never log `config`, only `redactedView`.
 */
export interface ConnectorProposal {
  /** Candidate config to commit on confirm. Always `trusted:false,enabled:false`. */
  config: McpServerConfig;
  /** Log-safe copy with secret header/env values masked. Safe to display/log. */
  redactedView: McpServerConfig;
  /** Non-fatal validation notes the operator should see before confirming. */
  warnings: string[];
}

/**
 * Outcome of `confirmAndInstall`. Discriminated on `ok`:
 *   - success → the persisted, now-trusted+enabled server plus its tools.
 *   - failure → the error and which `stage` it failed at (`validate` before
 *     persistence, `probe` during the connect/list-tools step). On a `probe`
 *     failure the connector is left persisted but disabled+untrusted.
 */
export type InstallOutcome =
  | { ok: true; server: McpServerConfig; tools: McpToolInfo[] }
  | { ok: false; error: Error; stage: 'validate' | 'probe' };

/**
 * A named bundle that grants the agent a SUBSET of one connector's tools.
 *
 * This is the least-privilege unit: instead of handing the agent every tool a
 * server exposes, an operator defines a Skill naming exactly the tools the
 * agent may use for a given job. `resolveSkillTools` (in `skills.ts`) intersects
 * `toolNames` with what the connector currently advertises.
 */
export interface Skill {
  /** Stable opaque id (slug). */
  id: string;
  /** Human-facing label. */
  name: string;
  /** What this skill lets the agent do (free text, shown in the manager). */
  description: string;
  /** Id of the `McpServerConfig` whose tools this skill draws from. */
  connectorId: string;
  /** The allow-listed subset of tool names the agent may call. */
  toolNames: string[];
  /** Optional hint to the agent on when/how to use these tools. */
  usageNote?: string;
}
