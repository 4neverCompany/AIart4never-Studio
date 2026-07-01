/**
 * Shared Higgsfield image-generation core (framework-free).
 *
 * AGENTIC-CORE realignment: the in-app agent's `generate_image` tool and the
 * `app/api/higgsfield/image/*` routes both generate canon-anchored Kael images
 * through the operator's Higgsfield MCP connector. This module is the single,
 * tested source of truth for that flow so the route and the tool can't drift.
 *
 * The two exports mirror the route's two legs:
 *   - {@link submitHiggsfieldGeneration} — (optional MiniMax enhance) → prepend
 *     the canon `<<<elementId>>>` anchor → `callMcpTool('generate_image', …)` →
 *     return `{ jobId, prompt, anchored, model, characterId }`.
 *   - {@link pollHiggsfieldJob} — `callMcpTool('job_display', { id })` → parse the
 *     `results[0].status` + `results[0].results.{rawUrl,minUrl}` nesting →
 *     `{ status, images }`.
 *
 * Why the connector is PASSED IN (never read from a registry): the MCP connector
 * registry is a CLIENT-side concern (it lives in browser storage). Server code
 * (the routes, and the agent loop running on the Node side) never reaches into
 * the registry — the client supplies the resolved, enabled+trusted
 * {@link McpServerConfig}. The agent loop threads it through the RunContext.
 *
 * THE OBSERVED HIGGSFIELD CONTRACT (confirmed against one real generation):
 *   - submit tool   : `generate_image`, args `{ params: { model, prompt, aspect_ratio, count } }`.
 *   - submit echo   : `{ results: [{ id, type, status: 'pending', model, params }], adjustments }`.
 *                     The job id is `results[0].id` (one entry per requested count).
 *   - model remap   : we submit `nano_banana_2`; the server echoes the internal
 *                     name `nano_banana_flash`. NEVER assume the echoed model
 *                     string equals what we submitted — callers report the
 *                     SUBMITTED model.
 *   - canon anchor  : embedding the literal `<<<elementId>>>` placeholder INSIDE
 *                     `params.prompt` makes the backend resolve the Element and
 *                     inject its locked reference image (confirmed: the completed
 *                     response echoed `params.reference_elements[]`). This is the
 *                     canon "always EDIT from a locked reference" rule.
 *   - poll tool     : `job_display`, args `{ id: '<uuid>' }` — exactly ONE UUID
 *                     per call.
 *   - done signal   : `results[0].status === 'completed'` AND `results[0].results`
 *                     present. The finished-media object is `results[0].results`
 *                     ({ rawUrl, minUrl }), distinct from the top-level `results[]`
 *                     array AND from `results[0].params.reference_elements[].medias[].url`
 *                     (the INPUT Element image). We read ONLY
 *                     `results[0].results.{rawUrl,minUrl}`.
 */

import { callMcpTool, connectMcp } from '@/lib/mcp';
import type { McpServerConfig } from '@/lib/mcp';
import { getElementRef } from '@/lib/canon';
import type { CharacterId } from '@/lib/canon';

// ---------------------------------------------------------------------------
// Tool slugs (the Higgsfield MCP server advertises these names over the wire)
// ---------------------------------------------------------------------------

/** The submit tool slug. The server remaps/echoes the model as `nano_banana_flash`. */
export const GENERATE_IMAGE_TOOL = 'generate_image';
/** The poll tool slug. `show_generations` is history-browsing only — not a poll. */
export const JOB_DISPLAY_TOOL = 'job_display';

// ---------------------------------------------------------------------------
// MiniMax enhance (the same low-temperature rewrite the route used)
// ---------------------------------------------------------------------------

/** Tagged error so a caller can map a missing MiniMax key to a 503. */
export class MissingMinimaxKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingMinimaxKeyError';
    Object.setPrototypeOf(this, MissingMinimaxKeyError.prototype);
  }
}

/**
 * Story 2.8 — thrown when a recurring character has no resolved Higgsfield
 * Element for this turn (the `show_reference_elements` lookup wasn't run, or was
 * ambiguous). The generation is REFUSED before any submit — we never spend
 * credits on an un-anchored recurring character. Non-retryable: the agent must
 * resolve the Element first. The tool layer maps this to a clear ToolExecutionError.
 */
export class UnresolvedElementError extends Error {
  readonly characterId: string;
  constructor(characterId: string) {
    super(
      `No resolved Higgsfield Element for character "${characterId}" — resolve it with `
        + `show_reference_elements before generating (refusing to spend un-anchored).`,
    );
    this.name = 'UnresolvedElementError';
    this.characterId = characterId;
    Object.setPrototypeOf(this, UnresolvedElementError.prototype);
  }
}

/**
 * Compose the system message the MiniMax enhance call sees. Hard guardrails
 * first (no fences, no preamble), then the operator's agentPrompt, then
 * niches/genres. The canon Element placeholder is prepended AFTER enhance, so
 * we explicitly tell the model to leave any `<<<…>>>` token untouched.
 */
export function buildEnhanceSystemPrompt(args: {
  systemPrompt?: string;
  niches?: string[];
  genres?: string[];
}): string {
  const niches = (args.niches ?? []).filter((s) => s && s.trim());
  const genres = (args.genres ?? []).filter((s) => s && s.trim());
  const parts: string[] = [
    "You are an image-prompt engineer for the Higgsfield Nano Banana image model. Rewrite the user's rough idea into a single, vivid image-generation prompt for an EDIT-from-reference workflow (the locked character reference is supplied separately). Output ONLY the prompt — no preamble, no commentary, no markdown fences, no quote marks. If the idea contains a token like <<<some-id>>>, leave it exactly as-is.",
  ];
  if (args.systemPrompt && args.systemPrompt.trim()) {
    parts.push(args.systemPrompt.trim());
  }
  if (niches.length > 0) {
    parts.push(`Platform niches: ${niches.join(', ')}.`);
  }
  if (genres.length > 0) {
    parts.push(`Target genres: ${genres.join(', ')}.`);
  }
  return parts.join('\n\n');
}

/**
 * Call MiniMax `chat/completions` (streaming) and return the joined assistant
 * text. Uses a low temperature and the MiniMax default/env model. Reads
 * `process.env.MINIMAX_API_KEY`; throws {@link MissingMinimaxKeyError} when it
 * is missing so the caller can map it to a 503.
 */
export async function enhanceViaMinimax(args: {
  system: string;
  userMessage: string;
  signal?: AbortSignal;
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
    signal: args.signal ?? AbortSignal.timeout(45_000),
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
 * Strip MiniMax reasoning artefacts: drop `<think>...</think>` chain-of-thought,
 * then any leading/trailing code fences and surrounding quotes the model may
 * have added despite the system order.
 */
export function cleanEnhancedPrompt(raw: string): string {
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

// ---------------------------------------------------------------------------
// Defensive MCP payload parsing
// ---------------------------------------------------------------------------

/**
 * Unwrap an MCP tool result into a plain object. `callMcpTool` hands back the
 * `content` array; Higgsfield's JSON may be the first element's `.text` (a JSON
 * string) or already structured. Returns the first parsed object found.
 */
export function unwrapToolPayload(raw: unknown): unknown {
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

/**
 * Defensively pull the generation/job id out of the `generate_image` echo.
 * The confirmed shape is `{ results: [{ id, status, ... }], adjustments }`, so
 * `results[0].id` is the job UUID.
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

// ---------------------------------------------------------------------------
// Public API: submit + poll
// ---------------------------------------------------------------------------

export interface SubmitHiggsfieldGenerationArgs {
  /** The operator's resolved, enabled+trusted Higgsfield connector. */
  connector: McpServerConfig;
  /**
   * The model to SUBMIT (default `nano_banana_2`). The server remaps/echoes it
   * as `nano_banana_flash`; the returned `model` is the SUBMITTED one.
   */
  model?: string;
  /** The rough idea / prompt. When `enhance` is on, this is rewritten first. */
  prompt: string;
  /** Aspect ratio forwarded verbatim to `generate_image`. */
  aspectRatio: string;
  /** How many images to request (default 1). */
  count?: number;
  /**
   * The canon character whose live `<<<elementId>>>` anchor is prepended.
   * Default 'kael'. Story 2.8: a character with NO resolved Element throws
   * {@link UnresolvedElementError} (no submit, no spend) — never un-anchored.
   */
  characterId?: CharacterId;
  /**
   * Story 2.8 — an OPERATOR-supplied explicit Element id. Used ONLY by
   * operator-consented HTTP routes (the human picks/resolves the Element in a UI
   * that holds the client-side connector). The autonomous agent tool NEVER sets
   * this — it resolves via the RunContext memo (`getElementRef`), so the model
   * can't smuggle an id into a spend. When present, it is the anchor directly.
   */
  elementId?: string;
  /** Whether to run the MiniMax enhance before submit (default true). */
  enhance?: boolean;
  /** Enhance system-prompt knobs (only used when `enhance` is true). */
  enhanceSystemPrompt?: string;
  niches?: string[];
  genres?: string[];
  /** Abort signal forwarded to the enhance fetch. */
  signal?: AbortSignal;
}

export interface SubmitHiggsfieldGenerationResult {
  /** `results[0].id` from the submit echo. */
  jobId: string;
  /** The final prompt actually submitted (canon anchor + enhanced/raw idea). */
  prompt: string;
  /** Whether a canon `<<<element>>>` was prepended. */
  anchored: boolean;
  /** The model we SUBMITTED — NOT the echoed `nano_banana_flash` remap. */
  model: string;
  /** The character the prompt was anchored to. */
  characterId: CharacterId;
}

const DEFAULT_MODEL = 'nano_banana_2';
const DEFAULT_CHARACTER: CharacterId = 'kael';

/**
 * Submit one Higgsfield generation: (optional MiniMax enhance) → prepend the
 * canon `<<<elementId>>>` anchor → `callMcpTool('generate_image', …)` → return
 * the job id + the prompt actually submitted.
 *
 * Always closes the MCP connection (mirrors `lib/publish/dispatch.ts`).
 *
 * Throws on failure (the caller maps to a route 4xx/5xx or a tool error):
 *   - {@link MissingMinimaxKeyError} when enhance is on and the key is missing,
 *   - a plain Error when enhance fails, the MCP submit fails, or the echo
 *     carries no job id.
 */
export async function submitHiggsfieldGeneration(
  args: SubmitHiggsfieldGenerationArgs,
): Promise<SubmitHiggsfieldGenerationResult> {
  const model = args.model && args.model.trim() ? args.model.trim() : DEFAULT_MODEL;
  const characterId = args.characterId ?? DEFAULT_CHARACTER;
  const count =
    typeof args.count === 'number' && Number.isFinite(args.count)
      ? Math.max(1, Math.trunc(args.count))
      : 1;
  const enhance = args.enhance !== false;

  // ── Step 1: enhance the idea via MiniMax (unless the caller opted out) ──
  let enhancedPrompt: string;
  if (!enhance) {
    enhancedPrompt = args.prompt;
  } else {
    const system = buildEnhanceSystemPrompt({
      ...(args.enhanceSystemPrompt !== undefined
        ? { systemPrompt: args.enhanceSystemPrompt }
        : {}),
      ...(args.niches ? { niches: args.niches } : {}),
      ...(args.genres ? { genres: args.genres } : {}),
    });
    const rawEnhanced = await enhanceViaMinimax({
      system,
      userMessage: args.prompt,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    enhancedPrompt = cleanEnhancedPrompt(rawEnhanced) || args.prompt;
  }

  // ── Step 2: CANON ANCHOR (Story 2.8 — fail safe, never spend un-anchored) ──
  // Resolve the character's LIVE Higgsfield Element token from the RunContext
  // memo (written by the show_reference_elements lookup; record fallback during
  // migration). If nothing is resolved for this character, REFUSE — do not
  // submit, do not spend. There is no hardcoded lockedRefs image fallback
  // anymore, so "fail safe" here means "do not spend".
  // An operator-supplied explicit id (operator-consented routes) wins; otherwise
  // resolve from the live RunContext memo (the autonomous agent path).
  const elementRef = args.elementId && args.elementId.trim()
    ? `<<<${args.elementId.trim()}>>>`
    : getElementRef(characterId);
  if (!elementRef) {
    throw new UnresolvedElementError(characterId);
  }
  // Governance: the anchor id must be the SERVER-resolved one, never a string
  // the model typed. Strip ANY <<<...>>> span the model may have smuggled into
  // its prompt (non-greedy, matches even malformed tokens containing `<`/`>`),
  // then prepend the single validated anchor.
  const cleanedPrompt = enhancedPrompt.replace(/<<<[\s\S]*?>>>/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const finalPrompt = `${elementRef} ${cleanedPrompt}`;
  const anchored = true;

  // ── Step 3: submit to Higgsfield via the generic MCP client ───────────
  let connection: Awaited<ReturnType<typeof connectMcp>> | undefined;
  try {
    connection = await connectMcp(args.connector);
    const raw = await callMcpTool(connection.client, GENERATE_IMAGE_TOOL, {
      params: {
        model,
        prompt: finalPrompt,
        aspect_ratio: args.aspectRatio,
        count,
      },
    });
    const jobId = extractJobId(raw);
    if (!jobId) {
      throw new Error(
        `Higgsfield returned no job id: ${JSON.stringify(raw).slice(0, 200)}`,
      );
    }
    return {
      jobId,
      prompt: finalPrompt,
      anchored,
      // The model we SUBMITTED — NOT the echoed nano_banana_flash remap.
      model,
      characterId,
    };
  } finally {
    if (connection) await closeQuietly(connection);
  }
}

export interface PollHiggsfieldJobArgs {
  /** The SAME connector used to submit. */
  connector: McpServerConfig;
  /** The job UUID returned by {@link submitHiggsfieldGeneration}. */
  jobId: string;
}

export interface PollHiggsfieldJobResult {
  /** 'pending' | 'in_progress' | 'completed' | string. */
  status: string;
  /** `[rawUrl, minUrl]` (filtered) once completed; `[]` while in flight. */
  images: string[];
}

/**
 * Poll ONE generation job by UUID via `job_display`. Always closes the MCP
 * connection. Throws on transport/tool failure.
 */
export async function pollHiggsfieldJob(
  args: PollHiggsfieldJobArgs,
): Promise<PollHiggsfieldJobResult> {
  let connection: Awaited<ReturnType<typeof connectMcp>> | undefined;
  try {
    connection = await connectMcp(args.connector);
    const raw = await callMcpTool(connection.client, JOB_DISPLAY_TOOL, {
      id: args.jobId,
    });
    return parseJobDisplay(raw);
  } finally {
    if (connection) await closeQuietly(connection);
  }
}

/** Close a connection, swallowing close errors so they don't mask the result. */
async function closeQuietly(connection: {
  close: () => Promise<void>;
}): Promise<void> {
  try {
    await connection.close();
  } catch {
    /* a failed close must not turn a success into a failure */
  }
}
