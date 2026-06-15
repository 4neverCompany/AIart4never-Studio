/**
 * Publish dispatcher — runs a deterministic {@link PublishPlan} through the
 * generic MCP primitive (`lib/mcp`), gate-first.
 *
 * Order of operations is the whole point:
 *   1. {@link import('./gate').assertPublishable} runs FIRST, before any
 *      network. An unapproved set never reaches `connect` — the human gate is
 *      enforced ahead of every side effect.
 *   2. Build the per-target plan (Instagram / Pinterest).
 *   3. Connect to the connector via the INJECTED `connect` (so tests mock it),
 *      then run each step in order through `callMcpTool`, resolving
 *      `$child[i]` / `$parent` placeholders from prior step results.
 *   4. Return `{ ok:true, publishedId }` from the final publish step, or
 *      `{ ok:false, error }`. The client is ALWAYS closed.
 *
 * Idempotency: `request.idempotencyKey` is accepted and documented but not yet
 * persisted — see the `// 4NE-11:` note below.
 */

import type { McpServerConfig } from '@/lib/mcp';
import { callMcpTool, connectMcp } from '@/lib/mcp';
import { getErrorMessage } from '@/lib/errors';
import type { GeneratedImage } from '@/types/mashup';
import { getServer } from '@/lib/mcp';
import { assertPublishable } from './gate';
import { buildInstagramPlan } from './instagram';
import { childToken, PARENT_TOKEN } from './instagram';
import { buildPinterestPlan } from './pinterest';
import type { PublishPlan, PublishRequest, PublishResult } from './types';

/**
 * The request shape the dispatcher accepts: a {@link PublishRequest} plus an
 * optional idempotency key.
 */
export interface DispatchRequest extends PublishRequest {
  /**
   * 4NE-11: the caller (autonomy loop) should pass the asset-set hash here so a
   * retry of the same approved set doesn't double-post. We don't persist a
   * receipt store yet — see the `// 4NE-11:` note in {@link publish}.
   */
  idempotencyKey?: string;
}

/**
 * Dependencies injected into {@link publish}. `connect` is the MCP connect
 * function (defaults to the real `connectMcp`, overridden in tests).
 * `assetsForGate` is the FULL {@link GeneratedImage} set the gate inspects —
 * it carries the `approved` flag the narrowed `PublishAsset` deliberately drops.
 */
export interface PublishDeps {
  connect: typeof connectMcp;
  assetsForGate: GeneratedImage[];
  /**
   * Optional connector-config resolver. Defaults to the registry's `getServer`.
   * Injected so tests don't need a populated registry.
   */
  getConnector?: (id: string) => Promise<McpServerConfig | undefined> | McpServerConfig | undefined;
}

/** Build the per-target plan. Centralised so the target switch lives in one place. */
function buildPlan(req: PublishRequest): PublishPlan {
  switch (req.target) {
    case 'instagram':
      return buildInstagramPlan(req);
    case 'pinterest':
      return buildPinterestPlan(req);
    default: {
      // Exhaustiveness guard — a new PublishTarget must add a branch here.
      const never: never = req.target;
      throw new Error(`Unsupported publish target: ${String(never)}`);
    }
  }
}

/**
 * Defensively pull a created-container / pin id out of an MCP tool result.
 *
 * Composio returns the id somewhere in the result content, but the exact shape
 * varies (a `content` text array of JSON, a structured object, a bare string).
 * This walks the common shapes and returns the first plausible id, or undefined
 * if none is found (the caller then fails the step).
 *
 * Shapes handled, in order:
 *   - string that looks like an id
 *   - { id } | { creation_id } | { mediaId } | { pin_id } | { data: {...same...} }
 *   - MCP content array [{ type:'text', text:'<json or id>' }] → parse each text
 */
export function extractId(raw: unknown): string | undefined {
  if (raw == null) return undefined;

  // Bare string id.
  if (typeof raw === 'string') {
    const s = raw.trim();
    return s.length > 0 ? pickIdFromString(s) : undefined;
  }

  // MCP content array: [{ type: 'text', text: '...' }, ...].
  if (Array.isArray(raw)) {
    for (const part of raw) {
      const fromPart = extractId(part);
      if (fromPart) return fromPart;
    }
    return undefined;
  }

  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;

    // Direct id-ish keys.
    for (const key of ['id', 'creation_id', 'creationId', 'mediaId', 'media_id', 'pin_id', 'pinId']) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number') return String(v);
    }

    // MCP text part: { type: 'text', text: '...' } — the text may be JSON.
    if (typeof obj.text === 'string') {
      const fromText = pickIdFromString(obj.text);
      if (fromText) return fromText;
    }

    // Nested envelopes Composio sometimes uses.
    for (const key of ['data', 'result', 'response', 'content']) {
      if (key in obj) {
        const nested = extractId(obj[key]);
        if (nested) return nested;
      }
    }
  }

  return undefined;
}

/** Pull an id from a string that may be raw JSON, a `key=value`, or a bare id. */
function pickIdFromString(s: string): string | undefined {
  const trimmed = s.trim();
  if (!trimmed) return undefined;

  // Try JSON first — Composio text parts are frequently serialized objects.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const fromJson = extractId(parsed);
      if (fromJson) return fromJson;
    } catch {
      /* not JSON — fall through to treat as a bare id */
    }
    // A JSON object with no id key isn't a usable id.
    return undefined;
  }

  // Bare token: treat the whole string as the id.
  return trimmed;
}

/**
 * Resolve a single arg value, substituting placeholder tokens from prior step
 * results. `$child[i]` → `priorIds[i]`; `$parent` → the most recent created id
 * (`priorIds[priorIds.length - 1]`). Non-placeholder values pass through
 * unchanged. Arrays are resolved element-wise (the carousel `children` array).
 */
function resolveArgValue(value: unknown, priorIds: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => resolveArgValue(v, priorIds));
  }
  if (typeof value !== 'string') return value;

  if (value === PARENT_TOKEN) {
    const parent = priorIds[priorIds.length - 1];
    if (parent == null) {
      throw new Error(`Cannot resolve ${PARENT_TOKEN}: no prior step produced an id`);
    }
    return parent;
  }

  // $child[i]
  const m = /^\$child\[(\d+)\]$/.exec(value);
  if (m) {
    const idx = Number(m[1]);
    const id = priorIds[idx];
    if (id == null) {
      throw new Error(`Cannot resolve ${childToken(idx)}: step ${idx} produced no id`);
    }
    return id;
  }

  return value;
}

/** Resolve every arg in a step's args object against the prior step ids. */
function resolveArgs(
  args: Record<string, unknown>,
  priorIds: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = resolveArgValue(v, priorIds);
  }
  return out;
}

/**
 * Gate-first publish. See module docs for the full order of operations.
 *
 * `deps.connect` is injected so tests can supply a fake client; production
 * passes the real `connectMcp`. The gate runs BEFORE `connect`, so an
 * unapproved set never opens a connection.
 */
export async function publish(
  request: DispatchRequest,
  deps: PublishDeps,
): Promise<PublishResult> {
  const { target } = request;

  // 1. GATE FIRST — before any plan build or network. Throwing here means we
  //    never connect. This is the human-approval hard stop.
  try {
    assertPublishable(deps.assetsForGate);
  } catch (e) {
    return { ok: false, target, error: e instanceof Error ? e : new Error(getErrorMessage(e)) };
  }

  // 4NE-11: idempotency receipt store not implemented yet. The caller is
  // expected to pass `request.idempotencyKey` (the approved asset-set hash);
  // once a persistent receipt store exists, check it HERE and short-circuit a
  // duplicate publish before connecting. For now the key is accepted, logged by
  // the caller, and otherwise inert — a retry CAN double-post until then.
  void request.idempotencyKey;

  // 2. Build the deterministic plan for the target.
  let plan: PublishPlan;
  try {
    plan = buildPlan(request);
  } catch (e) {
    return { ok: false, target, error: e instanceof Error ? e : new Error(getErrorMessage(e)) };
  }

  // 3. Resolve the connector config, then connect via the injected `connect`.
  const resolveConnector = deps.getConnector ?? getServer;
  let cfg: McpServerConfig | undefined;
  try {
    cfg = await resolveConnector(request.connectorId);
  } catch (e) {
    return { ok: false, target, error: e instanceof Error ? e : new Error(getErrorMessage(e)) };
  }
  if (!cfg) {
    return {
      ok: false,
      target,
      error: new Error(`Unknown connector: ${request.connectorId}`),
    };
  }

  let connection: Awaited<ReturnType<typeof connectMcp>>;
  try {
    connection = await deps.connect(cfg);
  } catch (e) {
    return { ok: false, target, error: e instanceof Error ? e : new Error(getErrorMessage(e)) };
  }

  // 4. Run steps in order; collect each step's created id for placeholder
  //    resolution. The final step is the publish — its id is the result.
  const priorIds: string[] = [];
  let lastRaw: unknown;
  try {
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]!;
      const resolvedArgs = resolveArgs(step.args, priorIds);
      const raw = await callMcpTool(connection.client, step.tool, resolvedArgs);
      lastRaw = raw;
      // Every create step yields an id used by later placeholders. The final
      // publish step's id is the published id.
      const id = extractId(raw);
      priorIds.push(id ?? '');
    }
  } catch (e) {
    await closeQuietly(connection);
    return { ok: false, target, error: e instanceof Error ? e : new Error(getErrorMessage(e)) };
  }

  await closeQuietly(connection);

  const publishedId = extractId(lastRaw);
  if (!publishedId) {
    return {
      ok: false,
      target,
      error: new Error('Publish completed but no published id was returned by the final step'),
    };
  }

  return { ok: true, target, publishedId, raw: lastRaw };
}

/** Close a connection, swallowing close errors so they don't mask a publish result. */
async function closeQuietly(connection: { close: () => Promise<void> }): Promise<void> {
  try {
    await connection.close();
  } catch {
    /* a failed close must not turn a successful publish into a failure */
  }
}
