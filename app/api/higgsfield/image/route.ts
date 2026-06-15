import { NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/errors';
import { callMcpTool, connectMcp } from '@/lib/mcp';
import type { McpServerConfig } from '@/lib/mcp';
import { getCharacter, getElementRef } from '@/lib/canon';
import type { CharacterId } from '@/lib/canon';

/**
 * Higgsfield image-generation orchestrator (SUBMIT half) — the foundation of the
 * generation realignment (Leonardo OUT, Higgsfield IN, canon Element-anchored).
 *
 * This is the async submit leg. It does NOT poll — the client takes over via the
 * sibling `GET /api/higgsfield/image/[id]` route, so this handler always returns
 * within a few seconds (one MiniMax enhance round-trip + one MCP `generate_image`
 * fire-and-return).
 *
 * Why the MCP registry is NOT read here: the connector registry is a CLIENT-side
 * concern (it lives in browser storage). Rather than have the route reach into a
 * registry, the CLIENT passes the resolved, enabled+trusted Higgsfield connector
 * config in the request body — exactly the way `/api/social/post` passes the
 * credentials it needs. The route then connects with that config via
 * {@link connectMcp}.
 *
 * THE OBSERVED HIGGSFIELD CONTRACT (confirmed against one real generation):
 *   - submit tool   : `generate_image`, args `{ params: { model, prompt, aspect_ratio, count } }`.
 *   - submit echo   : `{ results: [{ id, type, status: 'pending', model, params }], adjustments }`.
 *                     The job id is `results[0].id` (one entry per requested count).
 *   - model remap   : we submit `nano_banana_2`; the server echoes the internal
 *                     name `nano_banana_flash`. NEVER assume the echoed model
 *                     string equals what we submitted.
 *   - canon anchor  : embedding the literal `<<<elementId>>>` placeholder INSIDE
 *                     `params.prompt` makes the backend resolve the Element and
 *                     inject its locked reference image (confirmed: the completed
 *                     response echoed `params.reference_elements[]`). This is the
 *                     canon "always EDIT from a locked reference" rule.
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

/** The submit tool slug the Higgsfield MCP server advertises over the wire. */
const GENERATE_IMAGE_TOOL = 'generate_image';

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
 * Compose the system message the MiniMax enhance call sees. Replicated from
 * `/api/ai/image`'s `buildEnhanceSystemPrompt` but retargeted at Higgsfield's
 * Nano-Banana edit-from-reference doctrine: hard guardrails first (no fences,
 * no preamble), then the operator's agentPrompt, then niches/genres. The canon
 * Element placeholder is prepended AFTER enhance (see POST), so we explicitly
 * tell the model to leave any `<<<…>>>` token untouched.
 */
function buildEnhanceSystemPrompt(args: {
  systemPrompt?: string;
  niches: string[];
  genres: string[];
}): string {
  const parts: string[] = [
    "You are an image-prompt engineer for the Higgsfield Nano Banana image model. Rewrite the user's rough idea into a single, vivid image-generation prompt for an EDIT-from-reference workflow (the locked character reference is supplied separately). Output ONLY the prompt — no preamble, no commentary, no markdown fences, no quote marks. If the idea contains a token like <<<some-id>>>, leave it exactly as-is.",
  ];
  if (args.systemPrompt && args.systemPrompt.trim()) {
    parts.push(args.systemPrompt.trim());
  }
  if (args.niches.length > 0) {
    parts.push(`Platform niches: ${args.niches.join(', ')}.`);
  }
  if (args.genres.length > 0) {
    parts.push(`Target genres: ${args.genres.join(', ')}.`);
  }
  return parts.join('\n\n');
}

/**
 * Call MiniMax `chat/completions` (streaming) and return the joined assistant
 * text. Replicated from `/api/ai/image`'s `enhanceViaMinimax`, trimmed of the
 * Leonardo-catalog model resolution: this route just needs the plain enhance,
 * so we use a low temperature and the MiniMax default/env model. Reads
 * `process.env.MINIMAX_API_KEY`; throws a tagged error when it is missing so
 * the POST handler can map it to a 503.
 */
async function enhanceViaMinimax(args: {
  system: string;
  userMessage: string;
}): Promise<string> {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    throw new MissingMinimaxKeyError(
      'MINIMAX_API_KEY is not configured on the server. The Higgsfield image orchestrator needs it to enhance the prompt.',
    );
  }
  const baseURL =
    process.env.MINIMAX_API_BASE_URL?.trim() || 'https://api.minimax.io/v1';
  const url = `${baseURL.replace(/\/$/, '')}/chat/completions`;
  const modelId = process.env.VERCEL_AI_MODEL?.trim() || 'MiniMax-M3';
  const messages = [
    { role: 'system' as const, content: args.system },
    { role: 'user' as const, content: args.userMessage },
  ];
  const requestBody: Record<string, unknown> = {
    model: modelId,
    messages,
    stream: true,
    temperature: 0.3,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MiniMax HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  if (!res.body) throw new Error('MiniMax response has no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let acc = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nlIdx: number;
    while ((nlIdx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nlIdx).trim();
      buf = buf.slice(nlIdx + 1);
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return acc;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') acc += delta;
      } catch {
        // Skip malformed/keepalive chunks.
      }
    }
  }
  return acc;
}

/**
 * Strip MiniMax reasoning artefacts. Replicated from `/api/ai/image`'s
 * `cleanEnhancedPrompt`: drop `<think>...</think>` chain-of-thought, then any
 * leading/trailing code fences and surrounding quotes the model may have added
 * despite the system order.
 */
function cleanEnhancedPrompt(raw: string): string {
  let out = raw;
  out = out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  out = out.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
  if (
    (out.startsWith('"') && out.endsWith('"')) ||
    (out.startsWith("'") && out.endsWith("'"))
  ) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

/** Tagged error so the POST handler maps a missing MiniMax key to 503. */
class MissingMinimaxKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingMinimaxKeyError';
    Object.setPrototypeOf(this, MissingMinimaxKeyError.prototype);
  }
}

/**
 * Validate the `connector` field is a usable {@link McpServerConfig}. The client
 * sends the operator's enabled+trusted Higgsfield connector; we only need enough
 * shape to hand to {@link connectMcp} (the deeper validation lives in the
 * registry's `validateServerConfig`, client-side).
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
 * Defensively pull the generation/job id out of the `generate_image` echo.
 *
 * The confirmed shape is `{ results: [{ id, status, ... }], adjustments }`, so
 * `results[0].id` is the job UUID. `callMcpTool` returns the MCP `content` array
 * (or the raw result), so the echo may arrive as a structured object OR wrapped
 * in `[{ type: 'text', text: '<json>' }]`. We walk both — mirroring
 * `lib/publish/dispatch.ts`'s `extractId` defensiveness.
 */
export function extractJobId(raw: unknown): string | undefined {
  const parsed = unwrapToolPayload(raw);
  if (!parsed || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  const results = obj.results;
  if (Array.isArray(results) && results.length > 0) {
    const first = results[0] as Record<string, unknown> | undefined;
    const id = first?.id;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return undefined;
}

/**
 * Unwrap an MCP tool result into a plain object. `callMcpTool` hands back the
 * `content` array; Higgsfield's JSON may be the first element's `.text` (a JSON
 * string) or already structured. Returns the first parsed object found.
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
      // MCP text part: { type: 'text', text: '<json>' }.
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
      // Some servers return the object directly inside the array.
      if (part && typeof part === 'object' && 'results' in part) return part;
    }
    return undefined;
  }
  if (typeof raw === 'object') {
    // Already the payload, or wrapped one level (e.g. `{ content: [...] }`).
    if ('results' in (raw as Record<string, unknown>)) return raw;
    const content = (raw as Record<string, unknown>).content;
    if (content !== undefined) return unwrapToolPayload(content);
    return raw;
  }
  return undefined;
}

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

  // ── Step 1: enhance the idea via MiniMax (unless caller opted out) ──
  let enhancedPrompt: string;
  if (skipEnhance) {
    enhancedPrompt = idea;
  } else {
    try {
      const system = buildEnhanceSystemPrompt({ systemPrompt, niches, genres });
      const rawEnhanced = await enhanceViaMinimax({ system, userMessage: idea });
      enhancedPrompt = cleanEnhancedPrompt(rawEnhanced) || idea;
    } catch (e: unknown) {
      if (e instanceof MissingMinimaxKeyError) {
        return NextResponse.json({ error: e.message }, { status: 503 });
      }
      return NextResponse.json(
        { error: `Prompt enhance failed: ${getErrorMessage(e) || 'unknown error'}` },
        { status: 502 },
      );
    }
  }

  // ── Step 2: CANON ANCHOR ───────────────────────────────────────────
  // Prepend the character's Higgsfield Element placeholder `<<<elementId>>>` so
  // the backend resolves it and injects the LOCKED character reference image.
  // This is the canon "always EDIT from a locked reference" rule (lib/canon).
  // A character with no registered Element (e.g. kaelus-alt) proceeds with the
  // prompt only and `anchored: false` — the client can fall back to a locked
  // reference image via `--image` in a later step.
  const elementRef = getElementRef(characterId);
  const anchored = typeof elementRef === 'string';
  const finalPrompt = anchored ? `${elementRef} ${enhancedPrompt}` : enhancedPrompt;

  // ── Step 3: submit to Higgsfield via the generic MCP client ────────
  // ALWAYS close the client (mirrors lib/publish/dispatch.ts).
  let connection: Awaited<ReturnType<typeof connectMcp>> | undefined;
  let jobId: string | undefined;
  try {
    connection = await connectMcp(connector);
    const raw = await callMcpTool(connection.client, GENERATE_IMAGE_TOOL, {
      params: {
        model,
        prompt: finalPrompt,
        aspect_ratio: aspectRatio,
        count,
      },
    });
    jobId = extractJobId(raw);
    if (!jobId) {
      throw new Error(
        `Higgsfield returned no job id: ${JSON.stringify(raw).slice(0, 200)}`,
      );
    }
  } catch (e: unknown) {
    // Any failure in the connect → submit → extract chain is an upstream/MCP
    // fault (bad connector, transport error, tool-error, or a malformed echo
    // with no job id). The client can't fix these by re-POSTing the same body,
    // so they map to 502 (bad upstream) rather than a 4xx.
    return NextResponse.json(
      { error: `Higgsfield submit failed: ${getErrorMessage(e) || 'unknown error'}` },
      { status: 502 },
    );
  } finally {
    if (connection) await closeQuietly(connection);
  }

  return NextResponse.json({
    jobId,
    prompt: finalPrompt,
    characterId,
    anchored,
    // The model we SUBMITTED — NOT the echoed `nano_banana_flash` remap.
    model,
    provider: 'higgsfield',
  });
}

/** Close a connection, swallowing close errors so they don't mask the result. */
async function closeQuietly(connection: {
  close: () => Promise<void>;
}): Promise<void> {
  try {
    await connection.close();
  } catch {
    /* a failed close must not turn a successful submit into a failure */
  }
}
