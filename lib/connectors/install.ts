/**
 * M2 — FR-22 agentic-install flow.
 *
 * The ONLY supported path for a connector to enter the registry. It is a
 * two-step, operator-gated pipeline:
 *
 *   proposeConnector(operator input)  →  ConnectorProposal   (no persistence)
 *         ↓  operator inspects redactedView and confirms the EXACT config
 *   confirmAndInstall(proposal)       →  saveServer (untrusted+disabled)
 *                                     →  connect-probe + listTools
 *                                     →  on SUCCESS: markTrusted + setEnabled
 *
 * ─── FR-22 GUARANTEES (non-negotiable) ─────────────────────────────────────
 *  (1) SOURCE GUARD: every install entrypoint takes an explicit
 *      `source: 'operator'` and THROWS for anything else. FR-22: never install
 *      an MCP from observed/scraped/model-suggested content; the operator must
 *      paste the link/command and confirm the exact config.
 *  (2) TRUST ONLY ON CONFIRM: connecting or listing tools NEVER grants trust.
 *      Trust (`markTrusted`) and activation (`setEnabled(true)`) happen ONLY in
 *      `confirmAndInstall` AFTER the operator-confirmed proposal probes
 *      successfully. A failed probe leaves the connector disabled+untrusted.
 *
 * Anything returned to a caller or fit for logging goes through `redactConfig`
 * first (see `ConnectorProposal.redactedView`) — raw tokens never escape.
 */

import {
  saveServer as defaultSaveServer,
  removeServer as defaultRemoveServer,
  markTrusted as defaultMarkTrusted,
  setEnabled as defaultSetEnabled,
  validateServerConfig,
  redactConfig,
  connectMcp as defaultConnectMcp,
  listMcpTools as defaultListMcpTools,
  type McpServerConfig,
  type McpToolInfo,
  type McpConnection,
} from '@/lib/mcp';
import { getErrorMessage } from '@/lib/errors';
import { verifyToken } from '@/lib/approval';
import type { ApprovalRequest, ApprovalToken } from '@/lib/approval';
import type { ConnectorProposal, InstallOutcome } from './types';

/**
 * 4NE-26: thrown / returned when {@link confirmAndInstall} is asked to activate
 * a connector WITHOUT a valid `connector-activate` approval token for that exact
 * connector. Activation (trust + enable) is an irreversible grant of authority,
 * so it funnels through the unified approval chokepoint. Mirrors the
 * `McpError` convention (prototype fix-up for `instanceof`).
 */
export class ApprovalRequiredError extends Error {
  constructor(message = 'connector activation requires a valid approval token') {
    super(message);
    this.name = 'ApprovalRequiredError';
    Object.setPrototypeOf(this, ApprovalRequiredError.prototype);
  }
}

/**
 * Build the CANONICAL approval request for activating a connector. The caller
 * obtains a token by passing THIS exact request to `@/lib/approval`'s
 * `assertApproved`; `confirmAndInstall` recomputes it and verifies the token.
 * `target` is the connector id, so a token for connector A cannot activate B.
 */
export function buildConnectorActivateRequest(config: McpServerConfig): ApprovalRequest {
  return {
    kind: 'connector-activate',
    summary: `Activate connector ${config.name} (${config.id})`,
    target: config.id,
    payloadPreview: { id: config.id, transport: config.transport },
  };
}

/**
 * Operator-provided install input. `source` MUST be the literal `'operator'`:
 * the type makes the misuse a compile error and `proposeConnector` enforces it
 * at runtime too (defence in depth — the value can arrive from untyped JSON).
 *
 * FR-22: never install an MCP from observed/scraped/model-suggested content;
 * the operator must paste the link/command and confirm the exact config.
 */
export interface ProposeConnectorInput {
  source: 'operator';
  name: string;
  transport: 'http' | 'stdio';
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * The registry/client functions `confirmAndInstall` and `uninstallConnector`
 * depend on. Injectable so tests never touch persistence or the network. All
 * default to the real `@/lib/mcp` surface.
 */
export interface InstallDeps {
  connect?: typeof defaultConnectMcp;
  list?: typeof defaultListMcpTools;
  registry?: {
    saveServer?: typeof defaultSaveServer;
    removeServer?: typeof defaultRemoveServer;
    markTrusted?: typeof defaultMarkTrusted;
    setEnabled?: typeof defaultSetEnabled;
  };
}

/**
 * Derive a stable, url-safe id from a connector name. Lowercased, non-alnum
 * runs collapsed to single hyphens, trimmed. Falls back to `'connector'` when
 * the name has no alphanumeric characters at all (so the id is never empty).
 */
export function slugifyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'connector';
}

/**
 * Step 1 of FR-22: turn operator-provided input into a candidate proposal.
 *
 * Does NOT persist and does NOT connect. The returned `config` is always
 * `trusted:false, enabled:false` — trust/activation are decided later in
 * `confirmAndInstall`, only after the operator confirms and the probe passes.
 *
 * `addedAt` is injectable via `now` so tests are deterministic; in real runtime
 * the caller passes `Date.now()` (or omits it — defaults to `0`, "caller
 * stamps time").
 *
 * @throws Error if `source !== 'operator'` (FR-22 source guard) or if the
 *   derived config fails `validateServerConfig` (the latter is a structural
 *   error — a form should never reach here with an invalid transport/url).
 */
export function proposeConnector(
  input: ProposeConnectorInput,
  now = 0,
): ConnectorProposal {
  // FR-22 source guard: a connector may be installed ONLY from operator-
  // provided input. Never install an MCP from observed/scraped/model-suggested
  // content; the operator must paste the link/command and confirm the exact
  // config. We check the runtime value (not just the type) because input can
  // arrive from untyped JSON / IPC boundaries.
  if (input.source !== 'operator') {
    throw new Error(
      `FR-22: connectors may be installed only from operator-provided input (source must be 'operator', got '${String(
        (input as { source?: unknown }).source,
      )}')`,
    );
  }

  const id = slugifyName(input.name);

  // Build the candidate. Always untrusted + disabled at this stage.
  const config: McpServerConfig = {
    id,
    name: input.name,
    transport: input.transport,
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.headers !== undefined ? { headers: input.headers } : {}),
    ...(input.command !== undefined ? { command: input.command } : {}),
    ...(input.args !== undefined ? { args: input.args } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    enabled: false,
    trusted: false,
    addedAt: now,
  };

  const validation = validateServerConfig(config);
  const warnings: string[] = [];
  if (!validation.ok) {
    // A malformed config is operator error surfaced as a thrown Error so the
    // caller (form/UI) can show it; it must not silently become a proposal.
    throw new Error(`invalid connector config: ${validation.errors.join('; ')}`);
  }

  // Advisory warnings the operator should see (non-fatal).
  if (config.transport === 'http' && config.url?.startsWith('http://')) {
    warnings.push('url is plain http (not https) — credentials would be sent unencrypted');
  }
  if (config.transport === 'stdio') {
    warnings.push(
      "stdio transport is not yet connectable (desktop subprocess sandboxing is deferred); the connect-probe will fail until it's supported",
    );
  }

  return {
    config,
    // FR-22: any returned/loggable view of a config is redacted — raw
    // tokens/headers never leave this function.
    redactedView: redactConfig(config),
    warnings,
  };
}

/**
 * Step 2 of FR-22: the operator-confirmed commit path. Reaching here means the
 * operator inspected `proposal.redactedView` and confirmed the exact config.
 *
 * 4NE-26: activation (trust + enable) is an irreversible grant of authority, so
 * it funnels through the unified approval chokepoint. `approvalToken` is the
 * proof the operator approved activating THIS exact connector; the caller
 * obtains it from `@/lib/approval`'s `assertApproved` using the request from
 * {@link buildConnectorActivateRequest}. A missing/mismatched token fails closed
 * BEFORE trust/enable: nothing is trusted or enabled.
 *
 * Sequence:
 *   0. verify `approvalToken` against the canonical activate request. Bad/absent
 *      → `{ok:false, stage:'validate', error: ApprovalRequiredError}` — no
 *      persistence, no probe, nothing enabled.
 *   1. `saveServer(config)` — persists, still untrusted+disabled.
 *   2. connect-probe via `connect` + `list` (never trusts on its own).
 *   3. probe SUCCESS → `markTrusted(id)` + `setEnabled(id, true)` → `{ok:true}`.
 *      probe FAILURE → leave it disabled+untrusted → `{ok:false, stage:'probe'}`.
 *
 * The probe client is ALWAYS closed (success or failure). Dependencies are
 * injected via `deps` so tests don't hit persistence or the network.
 */
export async function confirmAndInstall(
  proposal: ConnectorProposal,
  approvalToken: ApprovalToken,
  deps: InstallDeps = {},
): Promise<InstallOutcome> {
  const connect = deps.connect ?? defaultConnectMcp;
  const list = deps.list ?? defaultListMcpTools;
  const saveServer = deps.registry?.saveServer ?? defaultSaveServer;
  const markTrusted = deps.registry?.markTrusted ?? defaultMarkTrusted;
  const setEnabled = deps.registry?.setEnabled ?? defaultSetEnabled;

  const { config } = proposal;

  // (0) APPROVAL TOKEN FIRST — before saveServer, before the probe, before any
  // trust/enable. Verify the token binds to activating THIS exact connector.
  // No valid token → fail closed: do NOT persist, probe, trust, or enable.
  const activateRequest = buildConnectorActivateRequest(config);
  if (!verifyToken(approvalToken, activateRequest)) {
    return {
      ok: false,
      stage: 'validate',
      error: new ApprovalRequiredError(
        `connector activation blocked: no valid approval token for ${config.id}`,
      ),
    };
  }

  // (1) Persist first — still untrusted + disabled. Defensive: ensure the
  // committed row can never carry trust/enabled even if a caller hand-built a
  // proposal with the flags flipped.
  const toPersist: McpServerConfig = { ...config, trusted: false, enabled: false };
  try {
    await saveServer(toPersist);
  } catch (e) {
    return {
      ok: false,
      stage: 'validate',
      error: e instanceof Error ? e : new Error(getErrorMessage(e)),
    };
  }

  // (2) Connect-probe. This NEVER grants trust by itself (FR-22 guarantee 2);
  // trust is decided only by the explicit markTrusted call below, gated on a
  // successful probe.
  let connection: McpConnection | undefined;
  try {
    connection = await connect(toPersist);
    const tools: McpToolInfo[] = await list(connection.client);

    // (3a) Probe succeeded → operator-confirmed trust + activation.
    await markTrusted(toPersist.id);
    const enabled = await setEnabled(toPersist.id, true);

    // Reflect the now trusted+enabled state in the returned server.
    const server: McpServerConfig =
      enabled ?? { ...toPersist, trusted: true, enabled: true };

    return { ok: true, server, tools };
  } catch (e) {
    // (3b) Probe failed → leave the connector disabled + untrusted. We do NOT
    // call setEnabled/markTrusted, so the persisted row keeps trusted:false,
    // enabled:false from step (1).
    return {
      ok: false,
      stage: 'probe',
      error: e instanceof Error ? e : new Error(getErrorMessage(e)),
    };
  } finally {
    // Always close the probe client, whatever happened.
    if (connection) {
      try {
        await connection.close();
      } catch {
        /* best-effort: a close failure must not mask the install outcome */
      }
    }
  }
}

/**
 * Remove an installed connector by id. Thin pass-through to `removeServer`;
 * exists here so callers have the full connector lifecycle in one module.
 */
export async function uninstallConnector(
  id: string,
  deps: InstallDeps = {},
): Promise<McpServerConfig[]> {
  const removeServer = deps.registry?.removeServer ?? defaultRemoveServer;
  return removeServer(id);
}
