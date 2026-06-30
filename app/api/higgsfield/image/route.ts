import { NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/errors';
import type { McpServerConfig } from '@/lib/mcp';
import { getCharacter } from '@/lib/canon';
import type { CharacterId } from '@/lib/canon';
import {
  submitHiggsfieldGeneration,
  MissingMinimaxKeyError,
  // Re-exported below so the route's existing test imports
  // (`@/app/api/higgsfield/image/route`'s `extractJobId`) keep resolving.
  extractJobId as sharedExtractJobId,
} from '@/lib/higgsfield/generate';

/**
 * Higgsfield image-generation orchestrator (SUBMIT half) — the foundation of the
 * generation realignment (Leonardo OUT, Higgsfield IN, canon Element-anchored).
 *
 * This is the async submit leg. It does NOT poll — the client takes over via the
 * sibling `GET /api/higgsfield/image/[id]` route, so this handler always returns
 * within a few seconds (one MiniMax enhance round-trip + one MCP `generate_image`
 * fire-and-return).
 *
 * AGENTIC-CORE: the enhance + canon-anchor + MCP-submit logic now lives in the
 * framework-free `lib/higgsfield/generate.ts` so the in-app agent's
 * `generate_image` tool shares the exact, tested behavior. This route is a thin
 * HTTP adapter over {@link submitHiggsfieldGeneration}: validate the body,
 * call the lib, map the lib's throws to HTTP status codes.
 *
 * Why the MCP registry is NOT read here: the connector registry is a CLIENT-side
 * concern (it lives in browser storage). The CLIENT passes the resolved,
 * enabled+trusted Higgsfield connector config in the request body.
 *
 * Request shape:
 *   {
 *     idea: string,                      // the rough idea (required)
 *     modelId?: string,                  // default 'nano_banana_2'
 *     characterId?: CharacterId,         // default 'kael'
 *     aspectRatio?: '4:5' | '9:16' | '2:3',  // default '4:5'
 *     count?: number,                    // default 1
 *     systemPrompt?: string,             // settings.agentPrompt (enhance system)
 *     niches?: string[],
 *     genres?: string[],
 *     skipEnhance?: boolean,             // bypass MiniMax — submit `idea` verbatim
 *     connector: McpServerConfig,        // the operator's Higgsfield connector
 *   }
 *
 * Response (success):
 *   {
 *     jobId: string,                     // results[0].id from the submit echo
 *     prompt: string,                    // the final prompt actually submitted
 *     characterId: CharacterId,
 *     anchored: boolean,                 // whether a canon <<<element>>> was prepended
 *     model: string,                     // the model id we SUBMITTED (not the echo)
 *     provider: 'higgsfield',
 *   }
 *
 * MINIMAX_API_KEY is required for the enhance step (unless `skipEnhance`); a
 * missing key → 503. A missing connector → 400 ("Add a Higgsfield connector in
 * Customize"). MCP/enhance failures map to 4xx/5xx with a clear message.
 */
export const runtime = 'nodejs';

/** The model we SUBMIT. The server remaps/echoes it as `nano_banana_flash`. */
const DEFAULT_MODEL = 'nano_banana_2';
const DEFAULT_CHARACTER: CharacterId = 'kael';
const DEFAULT_ASPECT: AspectRatio = '4:5';

/**
 * Required platform aspect-ratio mappings (all valid verbatim for nano_banana_2):
 *   IG 4:5 → '4:5'; story 9:16 → '9:16'; Pinterest 2:3 → '2:3'.
 */
type AspectRatio = '4:5' | '9:16' | '2:3';
const ALLOWED_ASPECTS: readonly AspectRatio[] = ['4:5', '9:16', '2:3'];

interface RequestBody {
  idea?: unknown;
  modelId?: unknown;
  characterId?: unknown;
  aspectRatio?: unknown;
  count?: unknown;
  systemPrompt?: unknown;
  niches?: unknown;
  genres?: unknown;
  skipEnhance?: unknown;
  connector?: unknown;
}

function sanitizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim());
}

/**
 * Validate the `connector` field is a usable {@link McpServerConfig}. The client
 * sends the operator's enabled+trusted Higgsfield connector; we only need enough
 * shape to hand to the shared lib (the deeper validation lives in the registry's
 * `validateServerConfig`, client-side).
 */
function isConnectorConfig(raw: unknown): raw is McpServerConfig {
  if (!raw || typeof raw !== 'object') return false;
  const c = raw as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    typeof c.name === 'string' &&
    (c.transport === 'http' || c.transport === 'stdio')
  );
}

/**
 * Re-export the shared `extractJobId` so any existing importer of this route
 * module keeps resolving the same symbol (the lib is the source of truth now).
 */
export const extractJobId = sharedExtractJobId;

export async function POST(req: Request): Promise<Response> {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // ── Validate idea ──────────────────────────────────────────────────
  const idea = typeof body.idea === 'string' ? body.idea.trim() : '';
  if (!idea) {
    return NextResponse.json({ error: 'idea is required' }, { status: 400 });
  }

  // ── Validate connector (client passes the resolved Higgsfield config) ─
  if (!isConnectorConfig(body.connector)) {
    return NextResponse.json(
      { error: 'Add a Higgsfield connector in Customize' },
      { status: 400 },
    );
  }
  const connector = body.connector;

  // ── Resolve params with defaults ───────────────────────────────────
  const model =
    typeof body.modelId === 'string' && body.modelId.trim()
      ? body.modelId.trim()
      : DEFAULT_MODEL;
  const aspectRatio: AspectRatio = ALLOWED_ASPECTS.includes(
    body.aspectRatio as AspectRatio,
  )
    ? (body.aspectRatio as AspectRatio)
    : DEFAULT_ASPECT;
  const count =
    typeof body.count === 'number' && Number.isFinite(body.count)
      ? Math.max(1, Math.trunc(body.count))
      : 1;
  const skipEnhance = body.skipEnhance === true;
  const systemPrompt =
    typeof body.systemPrompt === 'string' ? body.systemPrompt : '';
  const niches = sanitizeStringArray(body.niches);
  const genres = sanitizeStringArray(body.genres);

  // Validate characterId against the canon (defaults to kael). An unknown id
  // is a 400 rather than a thrown 500 from getCharacter.
  let characterId: CharacterId = DEFAULT_CHARACTER;
  if (body.characterId !== undefined) {
    const raw = typeof body.characterId === 'string' ? body.characterId : '';
    try {
      getCharacter(raw as CharacterId);
      characterId = raw as CharacterId;
    } catch {
      return NextResponse.json(
        { error: `Unknown canon character: ${raw || '(empty)'}` },
        { status: 400 },
      );
    }
  }

  // ── Enhance + canon-anchor + submit (shared lib) ──────────────────
  // The lib does: (optional MiniMax enhance) → prepend `<<<elementId>>>` →
  // callMcpTool('generate_image') → extract results[0].id. It always closes
  // the MCP connection. We map its throws to HTTP status codes:
  //   - MissingMinimaxKeyError → 503 (enhance needs the key)
  //   - anything else (enhance HTTP error, MCP/tool error, no job id) → 502.
  //
  // GOVERNANCE NOTE (Story 10.1 review L-2 + verification): this submit is NOT
  // routed through lib/approval/gate.ts. Story 10.1 routed ALL THREE autonomous
  // agent generation tools (`generate_image`, `generate_video`, `reframe_image`)
  // through the canonical gate; this route is instead an OPERATOR-INITIATED
  // request from the operator's own UI — the human click IS the consent, so the
  // autonomous spend gate does not apply here. The agent spend path is now fully
  // gated; the remaining ungated spend surfaces are operator-consent HTTP routes
  // (this route + the MMX/MiniMax routes), which the human operator drives
  // directly. Retiring this route if the UI no longer uses it is deliberate
  // follow-up work, not part of 10.1.
  try {
    const result = await submitHiggsfieldGeneration({
      connector,
      model,
      prompt: idea,
      aspectRatio,
      count,
      characterId,
      enhance: !skipEnhance,
      enhanceSystemPrompt: systemPrompt,
      niches,
      genres,
    });

    return NextResponse.json({
      jobId: result.jobId,
      prompt: result.prompt,
      characterId: result.characterId,
      anchored: result.anchored,
      // The model we SUBMITTED — NOT the echoed `nano_banana_flash` remap.
      model: result.model,
      provider: 'higgsfield',
    });
  } catch (e: unknown) {
    if (e instanceof MissingMinimaxKeyError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    // Any failure in the enhance/connect/submit/extract chain is an
    // upstream/MCP fault (bad connector, transport error, tool-error, a
    // malformed echo with no job id, or an enhance HTTP error). The client
    // can't fix these by re-POSTing the same body, so they map to 502.
    return NextResponse.json(
      { error: `Higgsfield submit failed: ${getErrorMessage(e) || 'unknown error'}` },
      { status: 502 },
    );
  }
}
