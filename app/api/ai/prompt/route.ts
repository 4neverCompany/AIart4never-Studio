// LLM-INTEGRATION-0513: Vercel AI SDK provider — direct API streaming.
//
// Same wire contract as /api/pi/prompt and /api/nca/prompt:
//   data: {"text":"<delta>"}\n\n
//   ...
//   data: {"error":"..."}\n\n   (on failure)
//   data: [DONE]\n\n
//
// Why a new route instead of patching the pi route:
//   - pi-client is a long-lived subprocess with its own auth + binary
//     install. This route is stateless and talks directly to the
//     provider's HTTPS endpoint, so it works on Vercel serverless and
//     in the Tauri desktop process without any sidecar/binary plumbing.
//   - The SSE shape is identical, so lib/aiClient.ts can route to this
//     route by URL alone; no client-side reader changes.
//
// Provider: MiniMax only (default model: MiniMax-M3).
//   MINIMAX_API_KEY  → minimax
//
// 4NE-20: the app is MiniMax-only for LLM text/agent calls. Earlier
// revisions carried an OpenAI fallback (and, before that, Anthropic /
// OpenRouter); those have been removed. MiniMax has long-standing
// credentials in this project (used by the nca subprocess path) and is
// the sole text/agent provider. The pi route and nca route are
// unaffected and remain the AI Agent settings options.
//
// The release/production deploy starts with no key set — the user
// pastes one in the Settings setup flow (or sets MINIMAX_API_KEY on
// Vercel).
//
// Per-request `model` body field, or VERCEL_AI_MODEL env var, overrides
// the default. Per-request always wins over env.
//
// Memory + trending enrichment (used by /api/pi/prompt for `idea` mode)
// is intentionally NOT replicated here. Those are pi-specific quality
// improvements that depend on the long-lived process for caching state.
// If the user wants the full idea pipeline, they should stay on the pi
// or nca provider. This route prioritises predictable streaming with
// zero subprocess management.
//
// V1.2.2 — DIRECTOR MODE
//   `mode: 'director'` switches this route to the new Director
//   agent loop (`lib/agent-loop/`). Unlike the other modes
//   (which stream text deltas), the Director mode returns a
//   single JSON object with the final prompt, the
//   chronological step log, and the total cost — the same
//   shape the Replay UI (v1.2 backlog) needs to render
//   step-by-step reasoning. The body shape stays the same
//   for the streaming modes, so existing callers
//   (lib/aiClient.ts, the Studio's mode switcher) keep
//   working untouched.

import { getErrorMessage } from '@/lib/errors';
import { buildSkillSystemBlock } from '@/lib/skill-loader';
// M1 CANON-WIRING: the canon engine shapes every prompt/caption/plan. The
// system block (full persona + locked look + hard rules + reality hallmarks
// + persistence mandate) is injected right after BASE_SYSTEM_PROMPT so the
// Master4never canon persona is authoritative for the text modes.
import {
  buildCanonSystemBlock,
  listCharacters,
  type CharacterId,
} from '@/lib/canon';
import {
  getTextModelParams,
  resolveTextModel,
  getDefaultTextModelForProvider,
  type TextGenParams,
} from '@/lib/text-model-catalog';
// AGENTIC-CORE: the chat client supplies the operator's Higgsfield MCP
// connector in the request body (the registry is client-side). We thread it
// into the Director loop's RunContext so the generate_image tool can submit a
// canon-anchored generation through Higgsfield.
import type { McpServerConfig } from '@/lib/mcp';
// V1.2.2-DIRECTOR: lazy-imported inside `handleDirectorMode`
// so the streaming-mode tests (which mock `ai` with a
// narrow `streamText` shape) don't transitively pull in
// `lib/agent-loop` (which imports `tool` from `ai`).
// Type-only import is fine — it has no runtime cost.

// Both the AI SDK provider clients and any future Node-only deps demand
// the Node runtime — edge stripped fetch agents the SDK relies on.
export const runtime = 'nodejs';

// Duplicated from lib/pi-client.ts on purpose (the brief forbids touching
// pi-client). If you change the wording here, mirror it there to keep
// the two routes producing comparable output.
const BASE_SYSTEM_PROMPT =
  "You are the creative AI engine for AIart4never Studio. You generate on-canon image prompts and captions for Master4never (also called Kael) — an original AI multiverse character who travels across self-contained, original fictional realities. All concepts must be ORIGINAL intellectual property: never rely on copyrighted universes, brands, trademarks, or named third-party characters. Follow instructions precisely. When asked to return JSON, return ONLY valid JSON with no preamble, no commentary, and no markdown code fences. When asked for a single string, return ONLY that string.";

type AiMode =
  | 'chat'
  | 'generate'
  | 'idea'
  | 'enhance'
  | 'caption'
  | 'tag'
  | 'negative-prompt'
  | 'collection-info'
  // V1.2.2-DIRECTOR: new non-streaming mode that drives
  // the multi-step tool-use loop and returns a JSON
  // {prompt, steps, cost, ...} envelope. See
  // lib/agent-loop/index.ts.
  | 'director';

// Same directives as the pi route. Duplicated rather than imported because
// the pi module's `MODE_DIRECTIVES` is private to its file and the brief
// forbids touching pi-client / pi route. If you add a mode there, mirror
// it here.
const MODE_DIRECTIVES: Record<AiMode, string> = {
  chat:
    'You are an elite creative AI assistant. Be vivid, direct, and spectacular. No hedging.',
  generate:
    'You are a world-class prompt engineer. Every prompt you write must be visually breathtaking. Follow the output format exactly. No preamble.',
  // M1: the canon engine will inject the full Master4never persona + Elements here.
  idea:
    'You are a creative genius generating concepts that break the internet — original Master4never multiverse realities, each a self-contained original fictional world the character Kael travels through. The wildest, most visually spectacular original concepts imaginable, with NO copyrighted franchises, brands, or named third-party characters. Avoid clichés. Return ONLY the requested format.',
  enhance:
    'You are an elite prompt enhancer. Transform the input into the most visually stunning, cinematic prompt possible. Maximize drama, detail, and visual impact. Return ONLY the enhanced prompt.',
  caption:
    'You are a viral social-media copywriter. Captions that stop thumbs and drive engagement. Return ONLY valid JSON.',
  tag:
    'You are a hashtag and tag strategist for maximum reach. Return ONLY a JSON array of tag strings.',
  'negative-prompt':
    'Generate the most effective negative prompt to eliminate visual artifacts and low-quality output. Return ONLY the negative prompt text.',
  'collection-info':
    'Generate rich collection metadata. Return ONLY valid JSON.',
  // V1.2.2-DIRECTOR: the system prompt is built by
  // `lib/agent-loop/plan.ts` (it embeds the 6-step plan
  // + niche/genre orientation). The mode-directive here
  // is intentionally minimal — the loop owns the role
  // definition, the route just routes to the loop.
  director:
    'You are the Director agent of AIart4never Studio. Operate the multi-step plan as described in your system prompt.',
};

function directiveFor(mode: unknown): string | null {
  if (typeof mode !== 'string') return null;
  return (MODE_DIRECTIVES as Record<string, string>)[mode] || null;
}

function sanitizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim());
}

// M1 CANON-WIRING: resolve the active Master4never character from the request
// body, validating against the canon's registered ids. Anything absent,
// non-string, or unknown falls back to the protagonist/narrator 'kael' so the
// canon block is ALWAYS present in the system stack — the server default is
// the safety net for callers that don't thread settings.activeCharacterId.
function resolveCharacterId(raw: unknown): CharacterId {
  const fallback: CharacterId = 'kael';
  if (typeof raw !== 'string') return fallback;
  const valid = listCharacters().some((c) => c.id === raw);
  return valid ? (raw as CharacterId) : fallback;
}

/**
 * AGENTIC-CORE: extract the operator's Higgsfield MCP connector from the
 * request body. The chat CLIENT must include the resolved, enabled+trusted
 * connector under `higgsfieldConnector` (or, for forward-compat, the first
 * Higgsfield-looking entry of a `connectors` array) — the MCP registry is
 * client-side, so the server never reads it. We validate just enough shape to
 * hand to `connectMcp` (deep validation is the registry's job, client-side).
 * Returns undefined when absent/malformed; the tool then raises a clear typed
 * error instead of the request failing.
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

function readHiggsfieldConnector(
  body: Record<string, unknown>,
): McpServerConfig | undefined {
  // Preferred: a single resolved connector the client already picked.
  const direct = body.higgsfieldConnector;
  if (isConnectorConfig(direct)) return direct;
  // Forward-compat: a `connectors` array — take the first valid Higgsfield-ish
  // one (matched by name, since the registry id is opaque).
  const list = body.connectors;
  if (Array.isArray(list)) {
    for (const c of list) {
      if (isConnectorConfig(c) && /higgsfield/i.test(c.name)) return c;
    }
  }
  return undefined;
}

// V080-DES-003: same focus-block helper as pi route; duplicated to avoid
// a circular import through the pi route module.
function buildFocusBlock(niches: string[], genres: string[]): string {
  if (niches.length === 0 && genres.length === 0) return '';
  const nicheClause =
    niches.length > 0 ? `The user creates content in: ${niches.join(', ')}.` : '';
  const genreClause =
    genres.length > 0 ? `Favor themes and styles like: ${genres.join(', ')}.` : '';
  return [
    'Focus areas:',
    nicheClause,
    genreClause,
    'Every output should visibly reflect these areas.',
  ]
    .filter(Boolean)
    .join(' ');
}

interface ResolvedProvider {
  // 4NE-20: MiniMax-only. The SDK `LanguageModel` field is gone — MiniMax
  // streams via the hand-rolled `streamMinimaxChat` (raw fetch to
  // /chat/completions), so the route only needs the model id.
  name: 'minimax';
  modelId: string;
}

/**
 * Resolve the MiniMax model from env vars + optional per-request model
 * override. Returns null when MINIMAX_API_KEY is not configured —
 * caller should 503.
 *
 * `modelOverride` (when present) is passed through verbatim after alias
 * normalisation. Unknown ids pass through so the upstream provider gets
 * the call — we shouldn't second-guess the user.
 */
/**
 * Stream MiniMax Chat Completions directly, bypassing the ai SDK.
 *
 * MiniMax's HTTP API is OpenAI-compatible at the request-shape level
 * (model + messages + stream) but only exposes `/v1/chat/completions`.
 * The ai SDK v6 OpenAI adapter targets `/v1/responses` (the new
 * Responses API), which MiniMax doesn't implement, so SDK requests
 * 404 against MiniMax.
 *
 * Reads the SSE event-stream from MiniMax line-by-line, extracts
 * `choices[0].delta.content` from each chunk, and re-emits each delta
 * as our own `data: {"text":"<delta>"}\n\n` event so the outer route
 * keeps a single SSE shape regardless of provider.
 *
 * The `data: [DONE]\n\n` terminator is added by the outer ReadableStream
 * finally block — don't write it here.
 */
async function streamMinimaxChat(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  system: string | undefined,
  userMessage: string,
  modelId: string,
  params?: TextGenParams,
): Promise<void> {
  const baseURL =
    process.env.MINIMAX_API_BASE_URL?.trim() || 'https://api.minimax.io/v1';
  const url = `${baseURL.replace(/\/$/, '')}/chat/completions`;
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: userMessage });

  // MiniMax uses snake_case parameter names; the lib emits camelCase.
  // Translate at the edge — only including each key when the caller
  // supplied a value, so we never overwrite the API's own defaults
  // with an explicit `undefined`.
  const requestBody: Record<string, unknown> = {
    model: modelId,
    messages,
    stream: true,
    // 4NE-21 / Story 1.5: opt into a terminal usage chunk. MiniMax is
    // OpenAI-compatible: with this flag the stream ends with one extra
    // chunk carrying `usage: { prompt_tokens, completion_tokens, ... }`
    // and an empty `choices` array, right before `[DONE]`. We capture it
    // and re-emit a single `usage` SSE event so the client can record the
    // tokens against the monthly quota. Best-effort: if MiniMax ignores
    // the flag (no usage chunk), we emit nothing and recording is skipped
    // for the stream path (the director path is the primary consumer).
    stream_options: { include_usage: true },
  };
  if (params?.temperature !== undefined) requestBody.temperature = params.temperature;
  if (params?.maxTokens !== undefined) requestBody.max_tokens = params.maxTokens;
  if (params?.topP !== undefined) requestBody.top_p = params.topP;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MiniMax HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  if (!res.body) {
    throw new Error('MiniMax response has no body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  // 4NE-21 / Story 1.5: token usage from MiniMax's terminal usage chunk.
  // Captured during parsing, emitted once when the stream ends. The flag
  // makes emission idempotent — the [DONE] path and the natural-end path
  // both call emitUsage, but only the first does anything.
  let pendingUsage: { input: number; output: number } | null = null;
  let usageEmitted = false;
  const emitUsage = (): void => {
    if (usageEmitted || !pendingUsage) return;
    usageEmitted = true;
    controller.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ usage: { input: pendingUsage.input, output: pendingUsage.output } })}\n\n`,
      ),
    );
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // SSE events are separated by blank lines. We split on '\n' and
    // parse each `data:` line independently; non-data lines (keepalive
    // comments, event: tags) are dropped.
    let nlIdx: number;
    while ((nlIdx = buf.indexOf('\n')) >= 0) {
      const rawLine = buf.slice(0, nlIdx);
      buf = buf.slice(nlIdx + 1);
      const line = rawLine.trim();
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        // 4NE-21: belt-and-braces — if a usage chunk arrived in the same
        // buffer as [DONE] but we haven't emitted yet, do it now before
        // returning. (MiniMax normally sends usage in its own chunk before
        // [DONE], handled below; this covers a buffer-boundary coalesce.)
        emitUsage();
        return;
      }
      try {
        const chunk = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          };
        };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ text: delta })}\n\n`),
          );
        }
        // 4NE-21 / Story 1.5: the terminal usage chunk carries token
        // counts and an empty `choices`. Capture it; emit the `usage` SSE
        // event when the stream finishes (on [DONE] or natural end). We
        // stash rather than emit inline because some providers send the
        // usage chunk a beat before the very last empty delta.
        if (
          chunk.usage &&
          (typeof chunk.usage.prompt_tokens === 'number' ||
            typeof chunk.usage.completion_tokens === 'number')
        ) {
          pendingUsage = {
            input:
              typeof chunk.usage.prompt_tokens === 'number'
                ? chunk.usage.prompt_tokens
                : 0,
            output:
              typeof chunk.usage.completion_tokens === 'number'
                ? chunk.usage.completion_tokens
                : 0,
          };
        }
      } catch {
        // Malformed chunk — skip. SSE keepalive comments and partial
        // chunks at buffer boundaries can land here.
      }
    }
  }

  // 4NE-21 / Story 1.5: stream ended without an explicit [DONE] (the
  // provider closed the connection). Flush any captured usage now, before
  // the outer ReadableStream writes its own terminal [DONE].
  emitUsage();
}

function resolveProvider(modelOverride?: string): ResolvedProvider | null {
  const envModel = process.env.VERCEL_AI_MODEL?.trim() || undefined;
  // V082-CATALOG: pass the override + env-var through
  // `resolveTextModel` for alias normalisation (e.g. legacy
  // `M2.7-highspeed` → canonical `MiniMax-M2.7-highspeed`). Unknown
  // IDs (typos, future models not in the catalog yet) pass through
  // verbatim so the upstream provider gets the call — better than
  // silently 503'ing the user for picking an id we haven't cataloged
  // yet. The catalog's role is the picker UI and alias resolution;
  // the route is the final arbiter of "what string do we send to
  // the provider".
  const resolvedOverride = modelOverride ? resolveTextModel(modelOverride) : undefined;
  const resolvedEnv = envModel ? resolveTextModel(envModel) : undefined;
  const requestedModel =
    resolvedOverride?.modelId || modelOverride?.trim() ||
    resolvedEnv?.modelId || envModel ||
    undefined;

  if (process.env.MINIMAX_API_KEY) {
    // V082-CATALOG: default for MiniMax is now M3 (the latest
    // generation), not the legacy M2.5. The Settings → AI Engine
    // picker surfaces M3 first and writes the selection to
    // VERCEL_AI_MODEL or the per-call `model` body field.
    const modelId =
      requestedModel || getDefaultTextModelForProvider('minimax') || 'MiniMax-M3';
    // 4NE-20: no SDK client built here — streaming goes through
    // `streamMinimaxChat` (raw fetch to /chat/completions). The route
    // only needs the resolved model id.
    return { name: 'minimax', modelId };
  }
  return null;
}

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { message, mode, systemPrompt, niches, genres, model, higgsfieldCliToken } = body || {};

  // V1.2.5: thread the user's Higgsfield CLI token (entered
  // in Settings → HiggsfieldConnection) into the provider
  // registry so the next `getProvider('higgsfield')` builds
  // a fresh adapter that forwards it as `HIGGSFIELD_API_KEY`
  // to the @higgsfield/cli binary. We accept any string
  // and let the CLI decide; an invalid token surfaces as a
  // 401 from the binary, which the error mapper already
  // turns into a clean `ProviderAuthError`.
  if (typeof higgsfieldCliToken === 'string') {
    const { setProviderRuntimeConfig } = await import('@/lib/providers/registry');
    setProviderRuntimeConfig({ higgsfieldCliToken });
  }

  // V1.2.2-DIRECTOR: short-circuit to the Director loop
  // when the caller sets `mode: 'director'`. The other
  // fields are not required — the loop reads its own
  // context from `niches` / `genres` / `ideaConcept` /
  // `skillContext` and returns a single JSON envelope
  // instead of an SSE stream. The streaming path
  // below is unchanged.
  if (mode === 'director') {
    // V1.6: thread the request abort so a client cancel (Skip idea /
    // client-side timeout) actually stops the paid server-side loop.
    return handleDirectorMode(body, req.signal);
  }

  if (typeof message !== 'string' || !message.trim()) {
    return new Response(JSON.stringify({ error: 'message is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const provider = resolveProvider(typeof model === 'string' ? model : undefined);
  if (!provider) {
    return new Response(
      JSON.stringify({
        error: 'No AI provider configured. Set MINIMAX_API_KEY.',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const directive = directiveFor(mode);
  const cleanNiches = sanitizeStringArray(niches);
  const cleanGenres = sanitizeStringArray(genres);
  const focusBlock = buildFocusBlock(cleanNiches, cleanGenres);
  const userSystem = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
  // M1 CANON-WIRING: the Master4never canon persona for the active character.
  // Injected RIGHT AFTER BASE_SYSTEM_PROMPT so the locked persona + look + hard
  // rules + reality hallmarks + persistence mandate are authoritative — every
  // caption/idea/enhance/etc. text mode now stays on-model. Defaults to 'kael'
  // when the caller omits or sends an invalid activeCharacterId.
  const characterId = resolveCharacterId(
    (body as { activeCharacterId?: unknown }).activeCharacterId,
  );
  const canonBlock = buildCanonSystemBlock(characterId);
  // V1.1.1-SKILLS-AUTO-USE: pull the user's active skills from the
  // request body. The frontend reads `settings.activeSkills` and
  // passes the list here so we don't have to round-trip the IDB
  // store on the server. Build the system-prompt fragment lazily
  // (file I/O for the loader) and append to the system stack.
  const activeSkillsRaw = Array.isArray((body as { activeSkills?: unknown }).activeSkills)
    ? (body as { activeSkills: unknown[] }).activeSkills
    : [];
  const activeSkills = activeSkillsRaw.filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  const skillBlock = await buildSkillSystemBlock(activeSkills);
  // Ordering: BASE_SYSTEM_PROMPT anchors output formatting (JSON-only, no
  // fences); the canon block (M1 CANON-WIRING) sits RIGHT AFTER it so the
  // Master4never persona + locked look + hard rules are authoritative; then
  // the directive sets the mode role, the user prompt refines it, the focus
  // block targets niches, and skills layer authoritative directives on top.
  const system =
    [BASE_SYSTEM_PROMPT, canonBlock, directive, userSystem, focusBlock, skillBlock]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join('\n\n') || undefined;

  // The user's message is forwarded to the model as-is. The previous
  // web/trending pre-enrichment (camofox sidecar + web-search fallback)
  // has been removed; idea generation will be driven by the agent's own
  // analysis in future work rather than live web context.
  const enrichedMessage = message;
  // Source attribution forwarded to the client via an SSE `sources`
  // event before the text stream starts. Kept (empty) so the client's
  // existing sources render path stays a harmless no-op.
  const gatheredSources: Array<{
    topic: string;
    headline: string;
    source: string;
    url: string;
  }> = [];

  // P2 of PROV-AGNOSTIC-PARAMS: resolve text-gen params for the active
  // (model, mode) pair. The lib emits an empty object for models without
  // a spec entry, which spreads cleanly into both branches below — so
  // unknown / unspec'd models keep their previous unparameterised
  // behaviour and only spec'd models get auto-tuned.
  const textParams = getTextModelParams(
    provider.modelId,
    typeof mode === 'string' ? mode : undefined,
  );

  const encoder = new TextEncoder();

  // Synthesise our own SSE stream so the route's wire shape stays
  // identical to /api/pi/prompt and /api/nca/prompt without depending
  // on Vercel's data-protocol wrapper.
  //
  // MiniMax only exposes /v1/chat/completions (it does NOT implement the
  // OpenAI Responses API the ai SDK v6 adapter targets), so we call the
  // chat endpoint directly via `streamMinimaxChat`. Every chunk leaves
  // this route as `data: {"text":"<delta>"}\n\n`.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // Source attribution event — emitted before text deltas so the
        // client can render the source-list affordance immediately,
        // without waiting for the model to finish. Skipped when web
        // search returned nothing usable (failed network, off-topic
        // results filtered out, mode without enrichment).
        if (gatheredSources.length > 0) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ sources: gatheredSources })}\n\n`),
          );
        }

        await streamMinimaxChat(controller, encoder, system, enrichedMessage, provider.modelId, textParams);
      } catch (e: unknown) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ error: getErrorMessage(e) || 'AI stream error' })}\n\n`,
          ),
        );
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Surfaces in browser devtools for debugging which backend served
      // the request. Not used by the client code path.
      'X-AI-Provider': provider.name,
      'X-AI-Model': provider.modelId,
    },
  });
}

// ---------------------------------------------------------------------------
// V1.2.2-DIRECTOR: Director mode handler.
//
// Returns a single JSON envelope instead of an SSE stream. The
// envelope shape mirrors `RunDirectorLoopResult` (see
// lib/agent-loop/index.ts) plus a `prompt` alias for the final
// draft so existing callers that only read `prompt` keep
// working.
//
// Request body:
//   {
//     "mode": "director",
//     "ideaConcept": "Kael in a storm-wreathed sky-temple reality",
//     "niches": ["Multiverse Crossovers", "Mythic Legends"],
//     "genres": ["Noir & Gritty", "Vibrant & Neon"],
//     "skillContext": [{ "name": "framing:camera-angles" }],
//     "userId": "ai-route",
//     "model": "MiniMax-M3"            // optional
//     "maxSteps": 8                    // optional
//     "budgetUsd": 0.50                // optional
//   }
//
// Response body (200):
//   {
//     "prompt": "<final prompt draft>",
//     "steps": [ Step, ... ],
//     "cost": 0.0234,
//     "runId": "run_...",
//     "modelId": "MiniMax-M3",
//     "provider": "minimax",
//     "truncatedBy": "natural" | "budget" | "step_limit" | "error"
//   }
//
// Error responses:
//   - 400: missing or invalid required fields
//   - 503: no AI provider configured
//   - 500: unexpected error (with a sanitised message)
// ---------------------------------------------------------------------------
// V1.6: server-side wall-clock ceiling for one Director run. The loop's
// step/budget caps are evaluated only BETWEEN completed steps — a hung
// provider connection records no step and can run forever without this.
const DIRECTOR_SERVER_TIMEOUT_MS = 240_000;

async function handleDirectorMode(
  body: Record<string, unknown>,
  clientSignal?: AbortSignal,
): Promise<Response> {
  const { ideaConcept, niches, genres, skillContext, userId, model } = body;

  if (typeof ideaConcept !== 'string' || !ideaConcept.trim()) {
    return new Response(
      JSON.stringify({ error: 'ideaConcept is required for director mode' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (!Array.isArray(niches) || niches.length === 0) {
    return new Response(
      JSON.stringify({ error: 'niches is required for director mode (1-6 items)' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // V1.6: clamp per-item length to the agent loop's 80-char Zod limit
  // so a long Content Pillar yields a truncated-but-working run instead
  // of an opaque 500 (the loop throws on schema violations). Mirrors
  // the client-side clamp in lib/director-pipeline.ts for direct API
  // callers.
  const cleanNiches = sanitizeStringArray(niches).map((s) => s.slice(0, 80));
  const cleanGenres = sanitizeStringArray(genres).map((s) => s.slice(0, 80));

  if (cleanNiches.length === 0) {
    return new Response(
      JSON.stringify({ error: 'niches must contain at least one non-empty string' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Optional skillContext — narrow safely (route-level
  // validation mirrors lib/agent-loop's own Zod schema).
  let safeSkillContext: { name: string; version?: string }[] | undefined;
  if (Array.isArray(skillContext)) {
    safeSkillContext = skillContext
      .filter(
        (s): s is { name: string; version?: string } =>
          typeof s === 'object'
          && s !== null
          && typeof (s as { name?: unknown }).name === 'string'
          && ((s as { name: string }).name.length > 0),
      )
      .map((s) => {
        const v = (s as { version?: unknown }).version;
        return {
          name: (s as { name: string }).name,
          ...(typeof v === 'string' && v.length > 0 ? { version: v } : {}),
        };
      });
  }

  const safeUserId =
    typeof userId === 'string' && userId.length > 0
      ? userId.slice(0, 120)
      : 'ai-route';

  const modelOverride = typeof model === 'string' && model.length > 0 ? model : undefined;

  // M1 CANON-WIRING: resolve the active Master4never character so the director
  // system prompt injects the right canon block. Defaults to 'kael' when the
  // caller omits or sends an invalid activeCharacterId.
  const characterId = resolveCharacterId(
    (body as { activeCharacterId?: unknown }).activeCharacterId,
  );

  // AGENTIC-CORE: pull the operator's Higgsfield connector out of the request
  // body. The MCP connector registry is CLIENT-side (browser storage), so the
  // chat CLIENT must include the resolved, enabled+trusted Higgsfield connector
  // here — the server never reads the registry. We thread it into the loop's
  // RunContext so the `generate_image` tool can submit a canon-anchored
  // generation. When absent, the tool raises a clear typed error mid-loop
  // ("No Higgsfield connector configured — add one in Customize") rather than
  // failing the whole request, so the Director can still produce a prompt.
  const higgsfieldConnector = readHiggsfieldConnector(body);

  // Optional maxSteps / budgetUsd. Both are passed through
  // verbatim to the loop; its own Zod schema rejects
  // nonsense values.
  let maxSteps: number | undefined;
  if (typeof body.maxSteps === 'number' && Number.isFinite(body.maxSteps)) {
    maxSteps = body.maxSteps;
  }
  let budgetUsd: number | undefined;
  if (typeof body.budgetUsd === 'number' && Number.isFinite(body.budgetUsd)) {
    budgetUsd = body.budgetUsd;
  }

  try {
    // Lazy import: keeps the streaming-mode test mocks
    // (which only stub `streamText`) from failing on the
    // missing `tool` export.
    const { runDirectorLoop } = await import('@/lib/agent-loop');
    // V1.6: bound the run in wall-clock time AND honour a client
    // abort. Without this, a hung provider connection never records a
    // step (so the step/budget stop conditions never fire) and a
    // client that gave up keeps paying for a result nobody reads.
    const timeoutSignal = AbortSignal.timeout(DIRECTOR_SERVER_TIMEOUT_MS);
    const loopSignal = clientSignal
      ? AbortSignal.any([clientSignal, timeoutSignal])
      : timeoutSignal;
    const result = await runDirectorLoop({
      niches: cleanNiches,
      genres: cleanGenres,
      ideaConcept: ideaConcept.trim(),
      ...(safeSkillContext ? { skillContext: safeSkillContext } : {}),
      // M1 CANON-WIRING: the director persona + image-prompt lock are anchored
      // to this character's canon.
      characterId,
      // AGENTIC-CORE: the operator's Higgsfield connector (client-supplied) so
      // the generate_image tool can submit through Higgsfield. Omitted when the
      // client didn't send one.
      ...(higgsfieldConnector ? { higgsfieldConnector } : {}),
      userId: safeUserId,
      ...(modelOverride ? { modelId: modelOverride } : {}),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
      signal: loopSignal,
    });

    // Map "no provider configured" to a 503 so the
    // client can show a clear setup CTA. Every other
    // error (budget, step limit, network) is a 200 with
    // truncatedBy set — the loop already captured the
    // best-effort final prompt in those cases.
    if (result.provider === 'unknown' && result.truncatedBy === 'error') {
      return new Response(
        JSON.stringify({
          error: 'No AI provider configured. Set MINIMAX_API_KEY.',
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // A configured provider that errored out and produced no prompt
    // used to fall through to the 200 below as `{ prompt: '' }`, which
    // the client surfaced as the opaque "🎬 Director unavailable
    // (empty prompt)". Surface the real cause (the loop's last error
    // step — e.g. a provider 404 from a bad model id, an auth failure,
    // or a network timeout) as a 502 so the UI shows what actually
    // failed. The pipeline still falls back to the verbatim concept
    // (requestDirectorPrompt never throws), but the reason is now real.
    if (result.truncatedBy === 'error' && !result.finalPrompt.trim()) {
      const lastError = [...result.steps]
        .reverse()
        .find(
          (s) =>
            s.type === 'error'
            && typeof s.reasoning === 'string'
            && s.reasoning.trim().length > 0,
        );
      const detail = lastError?.reasoning?.trim() || 'the Director loop produced no prompt';
      return new Response(
        JSON.stringify({
          error: `Director failed: ${detail}`,
          runId: result.runId,
          modelId: result.modelId,
          provider: result.provider,
          truncatedBy: result.truncatedBy,
        }),
        {
          status: 502,
          headers: {
            'Content-Type': 'application/json',
            'X-Director-Run-Id': result.runId,
            'X-AI-Provider': result.provider,
            'X-AI-Model': result.modelId,
          },
        },
      );
    }

    // V1.6: failure sentinel. The system prompt (lib/agent-loop/plan.ts)
    // instructs the model to finalize unrecoverable tool failures with
    // "DIRECTOR_FAILED: <reason>". Such a run finishes "naturally"
    // (finishReason stop, prompt non-empty) so neither guard above
    // fires — but returning it as a 200 prompt would send a failure
    // message to the image models. Map it to a 502 carrying the reason.
    if (/^DIRECTOR_FAILED\b/i.test(result.finalPrompt.trim())) {
      return new Response(
        JSON.stringify({
          error: `Director failed: ${result.finalPrompt.trim().slice(0, 300)}`,
          runId: result.runId,
          modelId: result.modelId,
          provider: result.provider,
          truncatedBy: result.truncatedBy,
        }),
        {
          status: 502,
          headers: {
            'Content-Type': 'application/json',
            'X-Director-Run-Id': result.runId,
            'X-AI-Provider': result.provider,
            'X-AI-Model': result.modelId,
          },
        },
      );
    }

    return new Response(
      JSON.stringify({
        prompt: result.finalPrompt,
        steps: result.steps,
        cost: result.totalCost,
        // 4NE-21 / Story 1.5: total MiniMax tokens this run consumed,
        // summed server-side from every step's usage. The client records
        // this against the monthly quota (lib/minimax-quota.ts). Older
        // clients that don't read it simply ignore the extra field.
        tokensUsed: { input: result.tokensUsed.input, output: result.tokensUsed.output },
        runId: result.runId,
        modelId: result.modelId,
        provider: result.provider,
        truncatedBy: result.truncatedBy,
        // 4NE-23: canon compliance of the final prompt (omitted by
        // JSON.stringify when undefined). The approval gate can flag canon
        // drift (e.g. a cyberdeck on a variant) before publish.
        canon: result.canon,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          // Replay-UI hint: the client can re-fetch the
          // run by id (lib/agent-loop/persistence.ts) to
          // render the step log later.
          'X-Director-Run-Id': result.runId,
          'X-AI-Provider': result.provider,
          'X-AI-Model': result.modelId,
        },
      },
    );
  } catch (e: unknown) {
    return new Response(
      JSON.stringify({ error: getErrorMessage(e) || 'Director loop error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
