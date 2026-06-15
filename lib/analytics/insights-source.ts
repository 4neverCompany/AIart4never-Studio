/**
 * 4NE-14 — Live Instagram insights source.
 *
 * The LEARN step's OBSERVE input: pull per-post engagement from Instagram via
 * Composio, mapped into our {@link PostInsight} shape. This dispatches through
 * the generic `lib/mcp` primitive exactly like `lib/publish` does — connect →
 * call one tool → map rows → ALWAYS close the client.
 *
 * What needs the LIVE connection vs. what's unit-tested:
 *   - `fetchInsights` is the impure piece: it requires the operator's Composio
 *     Instagram connection to actually return data. Its dispatch is exercised in
 *     tests with an INJECTED fake `connect` (no network), but a real run needs
 *     the connector configured + trusted in the MCP registry.
 *   - `mapRawInsight` is PURE and is the thing unit tests pin down: given a
 *     realistic Composio/IG insights row it must produce the right PostInsight,
 *     and given garbage it must return null (never throw, never emit NaN).
 */

import type { McpServerConfig } from '@/lib/mcp';
import { callMcpTool, connectMcp, getServer } from '@/lib/mcp';
import type { RealityId } from '@/lib/canon';
import type { PostInsight, Weekday } from './types';

/**
 * Composio tool slug for fetching Instagram media insights.
 *
 * NOTE: the EXACT slug is resolved from the connector's advertised tool list at
 * runtime (Composio occasionally revises slugs, and the operator's toolkit may
 * expose a variant). This constant is the expected/default name and the value
 * `fetchInsights` calls; if a connector advertises a different insights slug,
 * resolve it via `listMcpTools` before calling. We follow `lib/publish`'s
 * convention of never inventing tool names — this is the known Graph-insights
 * slug for IG user media.
 */
export const INSIGHTS_TOOL = 'INSTAGRAM_GET_IG_USER_MEDIA_INSIGHTS';

/** Planning metadata we join back onto a live insight row, keyed by `postId`. */
export interface PostRef {
  postId: string;
  assetId?: string;
  pillarId?: string;
  reality?: RealityId;
  day?: Weekday;
  /** Unix-ms publish time, used when the live row omits a timestamp. */
  postedAt?: number;
}

// ---------------------------------------------------------------------------
// Defensive mapping (PURE)
// ---------------------------------------------------------------------------

/** Coerce an unknown to a non-negative finite number, defaulting to 0. */
function toCount(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  return 0;
}

/** Coerce an unknown to a unix-ms timestamp, defaulting to 0. */
function toTimestamp(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : 0;
  if (typeof v === 'string') {
    const t = v.trim();
    // Numeric string (already ms or seconds-ish) → number; else try Date parse.
    const asNum = Number(t);
    if (Number.isFinite(asNum) && asNum > 0) return asNum;
    const parsed = Date.parse(t);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Pull a string id from common key spellings, or undefined. */
function pickId(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

/**
 * Read a named metric from either a flat object (`{ saves: 5 }`) or the IG
 * Graph "insights data" array shape (`[{ name:'saved', values:[{value:5}] }]`).
 * Tolerates synonyms (`saved`/`saves`, `total_interactions`, etc.).
 */
function readMetric(source: Record<string, unknown>, names: string[]): number {
  // 1. Flat key directly on the object.
  for (const n of names) {
    if (n in source) return toCount(source[n]);
  }
  // 2. IG Graph metrics array: { data: [{ name, values: [{ value }] }] } or a
  //    bare array under `insights` / `metrics`.
  const arrays: unknown[] = [];
  for (const key of ['data', 'insights', 'metrics', 'values']) {
    const a = source[key];
    if (Array.isArray(a)) arrays.push(...a);
  }
  for (const entry of arrays) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.toLowerCase() : '';
    if (!names.some((n) => n.toLowerCase() === name)) continue;
    // value may be e.value, or e.values[0].value
    if ('value' in e) return toCount(e.value);
    if (Array.isArray(e.values) && e.values.length > 0) {
      const first = e.values[0] as Record<string, unknown> | undefined;
      if (first && 'value' in first) return toCount(first.value);
    }
  }
  return 0;
}

/**
 * Map ONE raw Composio/IG insights row to a {@link PostInsight}, or `null` if
 * the row is unusable (not an object, or has no identifiable post id). Missing
 * metrics default to 0; never throws. PURE.
 *
 * The raw shape varies — Composio may hand back a flat object with counters, an
 * IG Graph insights `data` array, or a `{ data: {...} }` envelope. We unwrap a
 * single layer of `data`/`media` envelope, find a post id, then read each
 * metric tolerantly via {@link readMetric}.
 */
export function mapRawInsight(raw: unknown): PostInsight | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let obj = raw as Record<string, unknown>;

  // Unwrap a single envelope layer if the metrics clearly live under it.
  for (const key of ['media', 'response']) {
    const inner = obj[key];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      obj = inner as Record<string, unknown>;
      break;
    }
  }

  const postId = pickId(obj, ['postId', 'post_id', 'media_id', 'mediaId', 'id', 'ig_id']);
  if (!postId) return null; // no id → unusable

  const insight: PostInsight = {
    postId,
    postedAt: toTimestamp(obj.postedAt ?? obj.timestamp ?? obj.created_time ?? obj.posted_at),
    likes: readMetric(obj, ['likes', 'like_count', 'likeCount']),
    comments: readMetric(obj, ['comments', 'comments_count', 'commentsCount']),
    saves: readMetric(obj, ['saves', 'saved', 'save_count']),
    shares: readMetric(obj, ['shares', 'shared', 'share_count']),
    reach: readMetric(obj, ['reach']),
    impressions: readMetric(obj, ['impressions', 'views', 'video_views']),
  };

  const assetId = pickId(obj, ['assetId', 'asset_id']);
  if (assetId) insight.assetId = assetId;

  return insight;
}

/** Normalize a tool result into an array of candidate rows for mapping. */
function rowsFromResult(result: unknown): unknown[] {
  if (Array.isArray(result)) {
    // MCP content array: [{ type:'text', text:'<json>' }] OR an array of rows.
    const rows: unknown[] = [];
    for (const part of result) {
      if (part && typeof part === 'object' && 'type' in part && (part as { type: unknown }).type === 'text') {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') {
          const parsed = safeJsonParse(text);
          rows.push(...coerceRows(parsed));
          continue;
        }
      }
      rows.push(part);
    }
    return rows;
  }
  return coerceRows(result);
}

/** Pull rows out of a parsed object that may wrap the list under data/items/etc. */
function coerceRows(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    for (const key of ['data', 'items', 'media', 'results']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
    // A single row object.
    return [v];
  }
  return [];
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Live fetch (impure — needs the operator's Composio IG connection)
// ---------------------------------------------------------------------------

/** Dependencies injected into {@link fetchInsights}. `connect` is mocked in tests. */
export interface FetchInsightsDeps {
  /** MCP connect function — defaults to the real {@link connectMcp} in prod. */
  connect: typeof connectMcp;
  /**
   * Planning metadata to join onto live rows, keyed by `postId`. The live IG
   * insights don't know our pillar/reality/day — we enrich here on the join.
   */
  postRefs?: PostRef[];
  /**
   * Connector-config resolver. Defaults to the registry's `getServer`; injected
   * so tests don't need a populated registry.
   */
  getConnector?: (id: string) => Promise<McpServerConfig | undefined> | McpServerConfig | undefined;
  /**
   * Override the insights tool slug (e.g. after resolving it from the
   * connector's advertised tool list). Defaults to {@link INSIGHTS_TOOL}.
   */
  tool?: string;
}

/**
 * Fetch per-post insights from a Composio Instagram connector and map them to
 * {@link PostInsight}[].
 *
 * Flow (mirrors `lib/publish`'s dispatcher):
 *   1. Resolve the connector config via `deps.getConnector` (default registry).
 *   2. Connect via the INJECTED `deps.connect`.
 *   3. Call the insights tool ({@link INSIGHTS_TOOL} or `deps.tool`).
 *   4. Map each row via {@link mapRawInsight}, dropping unusable rows.
 *   5. Enrich each mapped insight with any matching `postRef` metadata
 *      (pillar / reality / day / assetId / fallback postedAt), joined on postId.
 *   6. ALWAYS close the client (even on a mid-flight error).
 *
 * Throws if the connector is unknown or the connect/tool call fails — the
 * caller (the weekly-report routine) decides how to surface that.
 */
export async function fetchInsights(
  connectorId: string,
  deps: FetchInsightsDeps,
): Promise<PostInsight[]> {
  const resolveConnector = deps.getConnector ?? getServer;
  const cfg = await resolveConnector(connectorId);
  if (!cfg) {
    throw new Error(`fetchInsights: unknown connector "${connectorId}"`);
  }

  const tool = deps.tool ?? INSIGHTS_TOOL;
  const refsById = new Map<string, PostRef>();
  for (const r of deps.postRefs ?? []) refsById.set(r.postId, r);

  const connection = await deps.connect(cfg);
  try {
    const result = await callMcpTool(connection.client, tool, {});
    const rows = rowsFromResult(result);

    const insights: PostInsight[] = [];
    for (const row of rows) {
      const mapped = mapRawInsight(row);
      if (!mapped) continue;
      insights.push(enrich(mapped, refsById.get(mapped.postId)));
    }
    return insights;
  } finally {
    // ALWAYS close — a failed close must not mask a fetch result/error.
    try {
      await connection.close();
    } catch {
      /* ignore close error */
    }
  }
}

/** Join planning metadata onto a mapped insight (live IG data lacks it). */
function enrich(insight: PostInsight, ref: PostRef | undefined): PostInsight {
  if (!ref) return insight;
  const out: PostInsight = { ...insight };
  if (ref.assetId !== undefined) out.assetId = ref.assetId;
  if (ref.pillarId !== undefined) out.pillarId = ref.pillarId;
  if (ref.reality !== undefined) out.reality = ref.reality;
  if (ref.day !== undefined) out.day = ref.day;
  // Use the planned publish time only if the live row didn't supply one.
  if (out.postedAt === 0 && ref.postedAt !== undefined) out.postedAt = ref.postedAt;
  return out;
}
