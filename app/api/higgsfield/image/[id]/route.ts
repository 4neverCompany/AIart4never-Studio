import { NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/errors';
import { callMcpTool, connectMcp } from '@/lib/mcp';
import type { McpServerConfig } from '@/lib/mcp';

/**
 * Higgsfield image-generation orchestrator (POLL half).
 *
 * `GET /api/higgsfield/image/[id]` polls ONE generation job by its UUID. The
 * submit route (`POST /api/higgsfield/image`) is fire-and-return; the client
 * loops THIS route until `status === 'completed'`, then reads `images`.
 *
 * Connector transport: the client passes the SAME Higgsfield connector config it
 * used to submit. A GET has no body, and the config carries secret headers, so
 * the clean approach is the `x-mcp-connector` request header carrying the
 * JSON-serialized {@link McpServerConfig}. (A query param would leak the bearer
 * token into URLs/logs; a GET body is non-standard.) The client sets:
 *
 *   fetch(`/api/higgsfield/image/${jobId}`, {
 *     headers: { 'x-mcp-connector': JSON.stringify(connector) },
 *   });
 *
 * THE OBSERVED HIGGSFIELD CONTRACT (confirmed against one real generation):
 *   - poll tool   : `job_display`, args `{ id: '<uuid>' }` — exactly ONE UUID per
 *                   call. (`show_generations` is history-browsing only — its own
 *                   description says do NOT use it as a post-generation poll.)
 *   - status      : 'pending' (submit) → 'in_progress' (early polls; no media yet)
 *                   → 'completed' (the finished-media object appears).
 *   - done signal : `results[0].status === 'completed'` AND `results[0].results`
 *                   is present.
 *   - image field : `results[0].results.rawUrl` (full-res .jpeg) and
 *                   `results[0].results.minUrl` (thumbnail _min.webp).
 *
 * NOTE the nesting collision: `results[0].results` is the finished-media object
 * `{ rawUrl, minUrl }`, distinct from the top-level `results[]` array AND from
 * `results[0].params.reference_elements[].medias[].url` (which is the INPUT
 * Element image, not the output). We read ONLY `results[0].results.{rawUrl,minUrl}`.
 *
 * Response (success):
 *   { status: 'pending' | 'in_progress' | 'completed' | string, images: string[] }
 *
 * `images` is `[rawUrl, minUrl]` (filtered) once completed; `[]` while pending /
 * in_progress. A missing/invalid connector → 400; a missing/invalid job id →
 * 400; an MCP/tool failure → 502.
 */
export const runtime = 'nodejs';

/** The poll tool slug the Higgsfield MCP server advertises over the wire. */
const JOB_DISPLAY_TOOL = 'job_display';

/** `job_display` requires exactly one UUID per call (must match this regex). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isConnectorConfig(raw: unknown): raw is McpServerConfig {
  if (!raw || typeof raw !== 'object') return false;
  const c = raw as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    typeof c.name === 'string' &&
    (c.transport === 'http' || c.transport === 'stdio')
  );
}

/** Parse the `x-mcp-connector` header (JSON {@link McpServerConfig}). */
function readConnectorHeader(req: Request): McpServerConfig | undefined {
  const header = req.headers.get('x-mcp-connector');
  if (!header) return undefined;
  try {
    const parsed: unknown = JSON.parse(header);
    return isConnectorConfig(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Unwrap an MCP tool result into a plain object. `callMcpTool` hands back the
 * `content` array; Higgsfield's JSON may be the first element's `.text` (a JSON
 * string) or already structured.
 */
function unwrapToolPayload(raw: unknown): unknown {
  if (raw == null) return undefined;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(raw)) {
    for (const part of raw) {
      if (part && typeof part === 'object' && 'text' in part) {
        const text = (part as { text: unknown }).text;
        if (typeof text === 'string') {
          try {
            return JSON.parse(text);
          } catch {
            /* not JSON — keep scanning */
          }
        }
      }
      if (part && typeof part === 'object' && 'results' in part) return part;
    }
    return undefined;
  }
  if (typeof raw === 'object') {
    if ('results' in (raw as Record<string, unknown>)) return raw;
    const content = (raw as Record<string, unknown>).content;
    if (content !== undefined) return unwrapToolPayload(content);
    return raw;
  }
  return undefined;
}

/**
 * Parse the `job_display` echo into `{ status, images }`.
 *
 * Done signal = `results[0].status === 'completed'` AND `results[0].results`
 * present. The finished-media object is `results[0].results` ({ rawUrl, minUrl })
 * — deliberately NOT `results[0].params.reference_elements[].medias[].url`.
 */
export function parseJobDisplay(raw: unknown): {
  status: string;
  images: string[];
} {
  const parsed = unwrapToolPayload(raw);
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const results = Array.isArray(obj.results) ? obj.results : [];
  const first = (results[0] ?? {}) as Record<string, unknown>;
  const status = typeof first.status === 'string' ? first.status : 'unknown';

  const images: string[] = [];
  // The nested finished-media object — present ONLY once completed.
  const media = first.results;
  if (media && typeof media === 'object') {
    const m = media as Record<string, unknown>;
    if (typeof m.rawUrl === 'string' && m.rawUrl) images.push(m.rawUrl);
    if (typeof m.minUrl === 'string' && m.minUrl) images.push(m.minUrl);
  }
  return { status, images };
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;

  // ── Validate job id (job_display needs exactly one UUID) ───────────
  const jobId = typeof id === 'string' ? id.trim() : '';
  if (!UUID_RE.test(jobId)) {
    return NextResponse.json(
      { error: 'A valid job id (UUID) is required' },
      { status: 400 },
    );
  }

  // ── Validate connector (passed back by the client via header) ──────
  const connector = readConnectorHeader(req);
  if (!connector) {
    return NextResponse.json(
      { error: 'Add a Higgsfield connector in Customize' },
      { status: 400 },
    );
  }

  // ── Poll via the generic MCP client; ALWAYS close ──────────────────
  let connection: Awaited<ReturnType<typeof connectMcp>> | undefined;
  let parsed: { status: string; images: string[] };
  try {
    connection = await connectMcp(connector);
    const raw = await callMcpTool(connection.client, JOB_DISPLAY_TOOL, { id: jobId });
    parsed = parseJobDisplay(raw);
  } catch (e: unknown) {
    return NextResponse.json(
      { error: `Higgsfield poll failed: ${getErrorMessage(e) || 'unknown error'}` },
      { status: 502 },
    );
  } finally {
    if (connection) await closeQuietly(connection);
  }

  return NextResponse.json(parsed);
}

/** Close a connection, swallowing close errors so they don't mask the result. */
async function closeQuietly(connection: {
  close: () => Promise<void>;
}): Promise<void> {
  try {
    await connection.close();
  } catch {
    /* a failed close must not turn a successful poll into a failure */
  }
}
