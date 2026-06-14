import { NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/errors';
import { MODEL_PROMPT_GUIDES, LEONARDO_MODELS } from '@/types/mashup';
import {
  getTextModelParams,
  resolveTextModel,
  getDefaultTextModelForProvider,
} from '@/lib/text-model-catalog';

/**
 * vercel-ai image-generation orchestrator (Option B, hybrid).
 *
 * Goal: when the active AI agent is vercel-ai (= MiniMax for text), make
 * the prompt-enhance + Leonardo-submit pair happen *server-side* in a
 * single round-trip, so the AI Engine genuinely "orchestrates" image
 * generation instead of letting the client stitch the two calls
 * together. The client keeps polling via the existing
 * `/api/leonardo/{id}` route — there's no server-side polling here, so
 * the Vercel-serverless 60s/300s `maxDuration` ceiling isn't load-bearing.
 *
 * Request shape:
 *   {
 *     idea: string,
 *     modelId: string,
 *     width: number, height: number,
 *     quality?: 'LOW' | 'MEDIUM' | 'HIGH',
 *     styleIds?: string[],
 *     quantity?: number,
 *     negativePrompt?: string,   // forwarded as a "Do not include:" suffix
 *     systemPrompt?: string,     // settings.agentPrompt
 *     niches?: string[],
 *     genres?: string[],
 *     apiKey?: string,           // Leonardo key override (user-supplied)
 *     skipEnhance?: boolean,     // bypass MiniMax — submit `idea` verbatim
 *                                // (used by client moderation-retry path,
 *                                // which has already rewritten the prompt)
 *   }
 *
 * Response (success):
 *   {
 *     generationId: string,
 *     prompt: string,            // the final prompt actually submitted
 *     width: number, height: number,
 *     provider: 'minimax+leonardo',
 *   }
 *
 * Errors return `{ error: string }` with a 4xx/5xx status, mirroring the
 * shapes the existing `/api/leonardo` route uses, so the client error
 * handler doesn't need to learn a new dialect.
 *
 * MINIMAX_API_KEY is required for the enhance step; LEONARDO_API_KEY
 * (or per-request `apiKey`) is required for the Leonardo submit step.
 * Either missing → 503 with a help message naming the missing env var.
 */
export const runtime = 'nodejs';

interface RequestBody {
  idea?: unknown;
  modelId?: unknown;
  width?: unknown;
  height?: unknown;
  quality?: unknown;
  styleIds?: unknown;
  quantity?: unknown;
  negativePrompt?: unknown;
  systemPrompt?: unknown;
  niches?: unknown;
  genres?: unknown;
  apiKey?: unknown;
  skipEnhance?: unknown;
  promptEnhance?: unknown;
}

// Mirrored from `/api/leonardo` so a v2 model id round-trips to the
// correct Leonardo API name. Duplicated rather than imported to keep
// the two routes independently deployable.
const MODEL_ID_MAP: Record<string, string> = {
  'nano-banana': 'gemini-2.5-flash-image',
  'nano-banana-2': 'nano-banana-2',
  'nano-banana-pro': 'gemini-image-2',
  'gpt-image-1.5': 'gpt-image-1.5',
  'gpt-image-2': 'gpt-image-2',
};

function sanitizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim());
}

/**
 * Compose the system message the MiniMax enhance call sees. The order
 * matches the pi-route doctrine: hard guardrails first (no fences, no
 * preamble), then the user's agentPrompt, then the per-model prompt
 * guide so the rewrite respects style/length conventions for the
 * specific Leonardo model that will render it, then niches/genres.
 */
function buildEnhanceSystemPrompt(args: {
  systemPrompt?: string;
  modelId: string;
  niches: string[];
  genres: string[];
}): string {
  const parts: string[] = [
    "You are an image-prompt engineer for Leonardo's v2 image API. Rewrite the user's rough idea into a single, vivid image generation prompt. Output ONLY the prompt — no preamble, no commentary, no markdown fences, no quote marks.",
  ];
  if (args.systemPrompt && args.systemPrompt.trim()) {
    parts.push(args.systemPrompt.trim());
  }
  const guide = MODEL_PROMPT_GUIDES[args.modelId];
  if (guide) {
    parts.push(`Target model: ${args.modelId}. Follow its prompt doctrine:\n${guide}`);
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
 * Call MiniMax `chat/completions` non-streaming and return the joined
 * assistant text. Mirrors `streamMinimaxChat` from /api/ai/prompt but
 * collects the deltas server-side instead of forwarding them as SSE.
 */
async function enhanceViaMinimax(args: {
  system: string;
  userMessage: string;
  modelOverride?: string;
}): Promise<string> {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    throw new Error(
      'MINIMAX_API_KEY is not configured on the server. The vercel-ai image orchestrator needs it to enhance the prompt.',
    );
  }
  const baseURL =
    process.env.MINIMAX_API_BASE_URL?.trim() || 'https://api.minimaxi.chat/v1';
  const url = `${baseURL.replace(/\/$/, '')}/chat/completions`;
  // V082-CATALOG: pass the override + env-var through
  // `resolveTextModel` for alias normalisation. Unknown IDs (typos,
  // future models not in the catalog yet) pass through verbatim so
  // the upstream provider gets the call. Default falls back to the
  // catalog's provider default (M3) instead of the legacy M2.5 hardcode.
  const resolvedOverride = args.modelOverride
    ? resolveTextModel(args.modelOverride)
    : undefined;
  const envRaw = process.env.VERCEL_AI_MODEL?.trim();
  const resolvedEnv = envRaw ? resolveTextModel(envRaw) : undefined;
  const modelId =
    resolvedOverride?.modelId || args.modelOverride?.trim() ||
    resolvedEnv?.modelId || envRaw ||
    getDefaultTextModelForProvider('minimax') ||
    'MiniMax-M3';
  const messages = [
    { role: 'system' as const, content: args.system },
    { role: 'user' as const, content: args.userMessage },
  ];
  // P2 of PROV-AGNOSTIC-PARAMS: pull the `enhance` mode profile from the
  // text-model spec so the prompt rewrite stays focused (low temp). Falls
  // back to an empty object when the modelId isn't spec'd — spread is a
  // no-op then and the API sees its own defaults.
  const params = getTextModelParams(modelId, 'enhance');
  const requestBody: Record<string, unknown> = {
    model: modelId,
    messages,
    stream: true,
  };
  if (params.temperature !== undefined) requestBody.temperature = params.temperature;
  if (params.maxTokens !== undefined) requestBody.max_tokens = params.maxTokens;
  if (params.topP !== undefined) requestBody.top_p = params.topP;

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
 * Strip MiniMax-M2.5 reasoning artefacts. The model wraps its
 * chain-of-thought in `<think>...</think>` blocks; only the post-think
 * body should reach Leonardo. Also strip surrounding quotes / fences
 * if the model decided to wrap the prompt despite the system order.
 */
function cleanEnhancedPrompt(raw: string): string {
  let out = raw;
  // Drop any <think>...</think> blocks (greedy across newlines).
  out = out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // Strip leading/trailing code fences if the model added them.
  out = out.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
  // Strip surrounding quotes.
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

interface LeonardoSubmitArgs {
  prompt: string;
  modelId: string;
  width: number;
  height: number;
  styleIds?: string[];
  quality?: 'LOW' | 'MEDIUM' | 'HIGH';
  quantity?: number;
  apiKey: string;
  /** IMG-INVEST-001 issue 1: Leonardo `prompt_enhance` toggle. */
  promptEnhance?: 'ON' | 'OFF';
}

/**
 * Submit a generation to Leonardo and return the generationId. Does
 * NOT poll — the client takes over via `/api/leonardo/{id}` so this
 * route always returns within a few seconds.
 */
async function submitToLeonardo(args: LeonardoSubmitArgs): Promise<string> {
  const apiModelId = MODEL_ID_MAP[args.modelId] || args.modelId;
  const parameters: Record<string, unknown> = {
    prompt: args.prompt,
    width: args.width,
    height: args.height,
    quantity: Math.min(args.quantity ?? 1, 8),
    // IMG-INVEST-001 issue 1: honour the caller's spec-driven choice;
    // defaults to 'ON' for back-compat with legacy callers.
    prompt_enhance: args.promptEnhance === 'OFF' ? 'OFF' : 'ON',
    quality: args.quality || 'HIGH',
  };
  if (args.modelId === 'gpt-image-1.5') {
    parameters.quantity = Math.min(parameters.quantity as number, 4);
  }
  if (Array.isArray(args.styleIds) && args.styleIds.length > 0) {
    parameters.style_ids = args.styleIds;
  }
  const body = JSON.stringify({
    model: apiModelId,
    parameters,
    public: false,
  });

  const res = await fetch('https://cloud.leonardo.ai/api/rest/v2/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.apiKey}`,
      Accept: 'application/json',
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Leonardo HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  const job = data.sdGenerationJob as Record<string, unknown> | undefined;
  const gen = data.generation as Record<string, unknown> | undefined;
  const generate = data.generate as Record<string, unknown> | undefined;
  const generationId =
    job?.generationId ||
    data.generationId ||
    data.id ||
    gen?.id ||
    generate?.generationId;
  if (typeof generationId !== 'string' || !generationId) {
    throw new Error(`Leonardo returned no generationId: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return generationId;
}

export async function POST(req: Request): Promise<Response> {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const idea = typeof body.idea === 'string' ? body.idea.trim() : '';
  if (!idea) {
    return NextResponse.json({ error: 'idea is required' }, { status: 400 });
  }
  const modelId = typeof body.modelId === 'string' ? body.modelId : '';
  if (!modelId) {
    return NextResponse.json({ error: 'modelId is required' }, { status: 400 });
  }
  // Guard against accidentally routing a MiniMax-native model through
  // here. The minimax-image-01 path lives at /api/minimax-image.
  const modelEntry = LEONARDO_MODELS.find(m => m.id === modelId);
  if (modelEntry?.provider === 'minimax') {
    return NextResponse.json(
      { error: `${modelId} is a MiniMax-native model. Use /api/minimax-image, not /api/ai/image.` },
      { status: 400 },
    );
  }

  const width = typeof body.width === 'number' && Number.isFinite(body.width) ? Math.trunc(body.width) : 1024;
  const height = typeof body.height === 'number' && Number.isFinite(body.height) ? Math.trunc(body.height) : 1024;
  const skipEnhance = body.skipEnhance === true;
  // IMG-INVEST-001 issue 1: surface caller's prompt_enhance choice.
  const promptEnhance: 'ON' | 'OFF' | undefined =
    body.promptEnhance === 'ON' || body.promptEnhance === 'OFF' ? body.promptEnhance : undefined;
  const quality =
    body.quality === 'LOW' || body.quality === 'MEDIUM' || body.quality === 'HIGH'
      ? body.quality
      : undefined;
  const styleIds = sanitizeStringArray(body.styleIds);
  const quantity =
    typeof body.quantity === 'number' && Number.isFinite(body.quantity)
      ? Math.trunc(body.quantity)
      : 1;
  const negativePrompt = typeof body.negativePrompt === 'string' ? body.negativePrompt.trim() : '';
  const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt : '';
  const niches = sanitizeStringArray(body.niches);
  const genres = sanitizeStringArray(body.genres);
  const leonardoKey =
    (typeof body.apiKey === 'string' && body.apiKey.trim()) ||
    process.env.LEONARDO_API_KEY ||
    '';
  if (!leonardoKey || leonardoKey === 'MY_LEONARDO_API_KEY') {
    return NextResponse.json(
      { error: 'Leonardo API key is missing. Set it in Settings or via LEONARDO_API_KEY.' },
      { status: 400 },
    );
  }

  // ── Step 1: enhance the idea via MiniMax (unless caller opted out) ──
  let enhancedPrompt: string;
  if (skipEnhance) {
    enhancedPrompt = idea;
  } else {
    try {
      const system = buildEnhanceSystemPrompt({ systemPrompt, modelId, niches, genres });
      const raw = await enhanceViaMinimax({ system, userMessage: idea });
      enhancedPrompt = cleanEnhancedPrompt(raw) || idea;
    } catch (e: unknown) {
      return NextResponse.json(
        { error: `Prompt enhance failed: ${getErrorMessage(e) || 'unknown error'}` },
        { status: 502 },
      );
    }
  }
  // Splice the negative-prompt hint into the prompt the same way the
  // existing reroll path does, so Leonardo sees a single string.
  const finalPrompt = negativePrompt
    ? `${enhancedPrompt}\nDo not include: ${negativePrompt}`
    : enhancedPrompt;

  // ── Step 2: submit to Leonardo, return generationId ───────────────
  let generationId: string;
  try {
    generationId = await submitToLeonardo({
      prompt: finalPrompt,
      modelId,
      width,
      height,
      styleIds: styleIds.length > 0 ? styleIds : undefined,
      quality,
      quantity,
      apiKey: leonardoKey,
      promptEnhance,
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: `Leonardo submit failed: ${getErrorMessage(e) || 'unknown error'}` },
      { status: 502 },
    );
  }

  return NextResponse.json({
    generationId,
    prompt: finalPrompt,
    width,
    height,
    provider: 'minimax+leonardo',
  });
}
