import { NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/errors';
import type { McpServerConfig } from '@/lib/mcp';
import {
  pollHiggsfieldJob,
  // Re-exported below so the route's existing test import
  // (`@/app/api/higgsfield/image/[id]/route`'s `parseJobDisplay`) keeps resolving.
  parseJobDisplay as sharedParseJobDisplay,
} from '@/lib/higgsfield/generate';

/**
 * Higgsfield image-generation orchestrator (POLL half).
 *
 * `GET /api/higgsfield/image/[id]` polls ONE generation job by its UUID. The
 * submit route (`POST /api/higgsfield/image`) is fire-and-return; the client
 * loops THIS route until `status === 'completed'`, then reads `images`.
 *
 * AGENTIC-CORE: the poll + parse logic now lives in the framework-free
 * `lib/higgsfield/generate.ts` so the in-app agent shares the exact, tested
 * behavior. This route is a thin HTTP adapter over {@link pollHiggsfieldJob}.
 *
 * Connector transport: the client passes the SAME Higgsfield connector config it
 * used to submit, via the `x-mcp-connector` request header carrying the
 * JSON-serialized {@link McpServerConfig}. (A query param would leak the bearer
 * token into URLs/logs; a GET body is non-standard.) The client sets:
 *
 *   fetch(`/api/higgsfield/image/${jobId}`, {
 *     headers: { 'x-mcp-connector': JSON.stringify(connector) },
 *   });
 *
 * THE OBSERVED HIGGSFIELD CONTRACT (confirmed against one real generation):
 *   - poll tool   : `job_display`, args `{ id: '<uuid>' }` — exactly ONE UUID per
 *                   call.
 *   - status      : 'pending' → 'in_progress' → 'completed'.
 *   - done signal : `results[0].status === 'completed'` AND `results[0].results`
 *                   is present.
 *   - image field : `results[0].results.rawUrl` (full-res) and `.minUrl` (thumb).
 *
 * Response (success):
 *   { status: 'pending' | 'in_progress' | 'completed' | string, images: string[] }
 *
 * `images` is `[rawUrl, minUrl]` (filtered) once completed; `[]` while pending /
 * in_progress. A missing/invalid connector → 400; a missing/invalid job id →
 * 400; an MCP/tool failure → 502.
 */
export const runtime = 'nodejs';

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
 * Re-export the shared `parseJobDisplay` so any existing importer of this route
 * module keeps resolving the same symbol (the lib is the source of truth now).
 */
export const parseJobDisplay = sharedParseJobDisplay;

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

  // ── Poll via the shared lib (connects + parses + ALWAYS closes) ────
  try {
    const parsed = await pollHiggsfieldJob({ connector, jobId });
    return NextResponse.json(parsed);
  } catch (e: unknown) {
    return NextResponse.json(
      { error: `Higgsfield poll failed: ${getErrorMessage(e) || 'unknown error'}` },
      { status: 502 },
    );
  }
}
