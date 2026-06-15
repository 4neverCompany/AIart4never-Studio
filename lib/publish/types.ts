/**
 * M2 — Gated publish path: shared types.
 *
 * The publish module turns an operator-approved set of assets into an ordered,
 * deterministic sequence of MCP tool calls against a social connector
 * (Instagram / Pinterest via Composio) and runs them through the generic MCP
 * primitive (`lib/mcp`). NOTHING here speaks HTTP or imports the MCP SDK — the
 * dispatcher does that through the injected `connectMcp`.
 *
 * These types are intentionally framework-free so the gate, the per-target plan
 * builders, the dispatcher, and any future UI can all share them without
 * dragging a transport into the bundle.
 */

/** The social platforms this module can publish to. */
export type PublishTarget = 'instagram' | 'pinterest';

/**
 * The minimal media descriptor the publish path needs. This is the *narrowed*
 * shape passed into plan builders — it deliberately drops the approval flag and
 * everything else on {@link import('@/types/mashup').GeneratedImage}, because by
 * the time an asset reaches a plan builder the human gate has already run (see
 * {@link import('./gate').assertPublishable}). Keep the gate the only thing that
 * reads `approved`.
 */
export interface PublishAsset {
  id: string;
  /** Publicly reachable media URL Composio fetches server-side. */
  url: string;
  /** True for video assets (reels). Images otherwise. */
  isVideo?: boolean;
}

/**
 * A single publish job. `connectorId` selects the persisted MCP connector
 * (`lib/mcp/registry`) the dispatcher resolves and connects to.
 *
 * - `igUserId` — Instagram Graph user id. Defaults to `'me'` (the connected
 *   account) when omitted; see {@link import('./instagram').buildInstagramPlan}.
 * - `boardId`  — Pinterest board the pin lands on; required by the Pinterest
 *   plan builder.
 * - `options`  — opaque per-target extras threaded into the relevant tool call
 *   (e.g. a Pinterest pin link). Builders pick out the keys they understand.
 */
export interface PublishRequest {
  target: PublishTarget;
  connectorId: string;
  assets: PublishAsset[];
  caption: string;
  igUserId?: string;
  boardId?: string;
  options?: Record<string, unknown>;
}

/**
 * One MCP tool call in a plan. `tool` is the Composio tool slug; `args` is the
 * exact argument object passed to `callMcpTool`. `args` values may contain
 * placeholder tokens (e.g. `'$child[0]'`, `'$parent'`) that the dispatcher
 * resolves from PRIOR step results at dispatch time — see
 * {@link import('./dispatch').publish}.
 */
export interface PublishStep {
  tool: string;
  args: Record<string, unknown>;
  /** Human-readable description for logs / the approval UI. */
  description: string;
}

/**
 * An ordered, deterministic plan: the same request always yields the same
 * steps in the same order. The final step is always the platform's "publish"
 * call, whose result carries the published id.
 */
export interface PublishPlan {
  target: PublishTarget;
  steps: PublishStep[];
}

/**
 * Result of running a plan. On success `publishedId` is the platform's id for
 * the published post/pin; `raw` is the final step's untouched MCP result for
 * debugging. On failure `error` wraps whatever went wrong (gate rejection,
 * connect failure, or a mid-plan MCP error).
 */
export type PublishResult =
  | { ok: true; target: PublishTarget; publishedId: string; raw?: unknown }
  | { ok: false; target: PublishTarget; error: Error };
