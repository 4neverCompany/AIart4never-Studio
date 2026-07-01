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
// AGENTIC-HARNESS: the conversational agent core (`runAgent`) — type-only
// import here (the value is lazy-imported inside `handleAgentStream` so the
// streaming-mode test mocks, which only stub `streamText`, don't transitively
// pull `lib/agent-core`). The new agent-core SSE path maps the token-level
// `streamText` `fullStream` to the SAME typed SSE events AgentConsole consumes.
import type { ModelMessage } from 'ai';
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
// Director mode dispatcher (Story 10.3 — thin).
//
// The live console (lib/aiClient streamAgent) sends stream:true + agentCore:true
// + `messages` and is served by handleAgentStream. The legacy brief-based paths
// (ideaConcept/niches -> runDirectorLoop, JSON envelope + SSE) were retired in
// the pivot (PRD Section 5 / FR-1 = messages-in is the sole input). A stale
// brief-shaped request gets a clear 400 (no silent fall-through).
// ---------------------------------------------------------------------------
// V1.6: server-side wall-clock ceiling for one Director run. The loop's
// step/budget caps are evaluated only BETWEEN completed steps — a hung
// provider connection records no step and can run forever without this.
const DIRECTOR_SERVER_TIMEOUT_MS = 240_000;

async function handleDirectorMode(
  body: Record<string, unknown>,
  clientSignal?: AbortSignal,
): Promise<Response> {
  // Story 10.3: the legacy brief-based director (ideaConcept/niches ->
  // runDirectorLoop) was retired in the pivot (PRD Section 5; FR-1 = messages-in
  // is the sole input shape). The live console (lib/aiClient streamAgent) always
  // sends stream:true + agentCore:true + `messages` -- that is the only path this
  // handler serves. A stale brief-shaped request fails CLEAR (no silent
  // fall-through to a removed runDirectorLoop).
  if (body.stream === true && body.agentCore === true) {
    return handleAgentStream(body, clientSignal);
  }
  return new Response(
    JSON.stringify({
      error:
        "The legacy brief-based director path (ideaConcept/niches -> runDirectorLoop) "
        + "was retired in the pivot. Use the conversational agent: POST "
        + "{ mode:'director', stream:true, agentCore:true, messages:[...] }.",
    }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  );
}

// ---------------------------------------------------------------------------
// AGENTIC-HARNESS: conversational agent-core STREAMING handler.
//
// The clean replacement for `handleDirectorStream`. Where that path forces a
// niches/genres/ideaConcept brief through `runDirectorLoop` (the rigid frame),
// this path runs the REAL conversational agent (`lib/agent-core` `runAgent`):
// messages-in (`ModelMessage[]`), open-ended tool use, natural turn-end, a soft
// (never-throwing) budget meter, and a generous `stepCountIs(256)` runaway net.
//
// It maps the token-level `streamText` `fullStream` parts to the EXACT SAME SSE
// events AgentConsole already consumes (so the console barely changes):
//   - text-delta  → {type:'text', text:<delta>}                 (token-level)
//   - tool-call   → {type:'tool-call', tool, args, idx}
//   - tool-result → {type:'tool-result', tool, output, assetRef?, idx}
//   - tool-error  → {type:'tool-result', tool, output:{error}, idx}  (chip resolves)
//   - finish      → {type:'done', prompt, text, cost, tokensUsed, runId, modelId,
//                    provider, truncatedBy:<rich stopReason>, canon?}
//   - error       → {type:'error', error}
//   terminated by `data: [DONE]`.
//
// NO plan event is emitted (the agent has no rigid scaffold). The `done` event
// carries BOTH `prompt` (the last generate_prompt draft, for back-compat with
// the console's "surface the prompt if the bubble is empty" path) AND `text`
// (the accumulated visible answer).
// ---------------------------------------------------------------------------
async function handleAgentStream(
  body: Record<string, unknown>,
  clientSignal?: AbortSignal,
): Promise<Response> {
  const encoder = new TextEncoder();
  const send = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: Record<string, unknown>,
  ): void => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };

  // --- Read the conversation (messages-in). No niches/genres/ideaConcept
  //     brief on this path; the agent reads the messages directly. ----------
  const messages = readModelMessages(body);
  if (messages.length === 0) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        send(controller, { type: 'error', error: 'messages is required for the agent-core path' });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { headers: sseHeaders() });
  }

  const characterId = resolveCharacterId(
    (body as { activeCharacterId?: unknown }).activeCharacterId,
  );
  const higgsfieldConnector = readHiggsfieldConnector(body);
  const safeUserId =
    typeof body.userId === 'string' && body.userId.length > 0
      ? body.userId.slice(0, 120)
      : 'agent-console';
  const modelOverride =
    typeof body.model === 'string' && body.model.length > 0 ? body.model : undefined;

  // Optional active skills (forward-compat with the brief path's skillContext).
  let safeSkillContext: { name: string; version?: string }[] | undefined;
  const rawSkills = body.skillContext;
  if (Array.isArray(rawSkills)) {
    safeSkillContext = rawSkills
      .filter(
        (s): s is { name: string; version?: string } =>
          typeof s === 'object'
          && s !== null
          && typeof (s as { name?: unknown }).name === 'string'
          && (s as { name: string }).name.length > 0,
      )
      .map((s) => {
        const v = (s as { version?: unknown }).version;
        return {
          name: (s as { name: string }).name,
          ...(typeof v === 'string' && v.length > 0 ? { version: v } : {}),
        };
      });
  }

  // SOFT budget meter (USD). Visible, never a mid-step throw. The console can
  // pass `budgetUsd`; absent → the meter just totals.
  let softBudgetUsd: number | undefined;
  if (typeof body.budgetUsd === 'number' && Number.isFinite(body.budgetUsd) && body.budgetUsd > 0) {
    softBudgetUsd = body.budgetUsd;
  }
  // Optional runaway-net override (the agent normally stops naturally first).
  let safetyMaxSteps: number | undefined;
  if (typeof body.maxSteps === 'number' && Number.isFinite(body.maxSteps) && body.maxSteps > 0) {
    safetyMaxSteps = body.maxSteps;
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Lazy import keeps the streaming-mode test mocks (which stub `streamText`)
      // from transitively failing on the agent-core module graph.
      const { runAgent } = await import('@/lib/agent-core');

      // V1.6 parity: bound the run in wall-clock time AND honour a client abort.
      // The wall-clock guard is reported as a rich stopReason on the done event.
      const timeoutSignal = AbortSignal.timeout(DIRECTOR_SERVER_TIMEOUT_MS);
      const runSignal = clientSignal
        ? AbortSignal.any([clientSignal, timeoutSignal])
        : timeoutSignal;

      let handle: Awaited<ReturnType<typeof runAgent>> | null = null;
      try {
        handle = await runAgent({
          messages,
          characterId,
          ...(safeSkillContext ? { skillContext: safeSkillContext } : {}),
          ...(higgsfieldConnector ? { higgsfieldConnector } : {}),
          userId: safeUserId,
          ...(modelOverride ? { modelId: modelOverride } : {}),
          ...(softBudgetUsd !== undefined ? { softBudgetUsd } : {}),
          ...(safetyMaxSteps !== undefined ? { safetyMaxSteps } : {}),
          signal: runSignal,
        });

        // No provider configured → a single error event, then [DONE].
        if (!isAgentHandle(handle)) {
          send(controller, {
            type: 'error',
            error: 'No AI provider configured. Set MINIMAX_API_KEY.',
          });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }

        // A live handle (narrowed by `isAgentHandle`).
        const live = handle;

        // Stream the token-level fullStream → SSE events the console consumes.
        let idx = 0;
        let accumulatedText = '';
        // Back-compat: the LAST generate_prompt draft becomes the done `prompt`.
        let lastPromptDraft = '';
        let errored = false;
        let aborted = false;

        for await (const part of live.stream) {
          switch (part.type) {
            case 'text-delta': {
              // Token-level visible answer delta. Already <think>-stripped by
              // the stateful transform inside runAgent.
              const text = part.text;
              if (text.length > 0) {
                accumulatedText += text;
                send(controller, { type: 'text', text });
              }
              break;
            }
            case 'tool-call': {
              send(controller, {
                type: 'tool-call',
                tool: part.toolName,
                ...(part.input !== undefined ? { args: part.input } : {}),
                idx: idx++,
              });
              break;
            }
            case 'tool-result': {
              const out = part.output;
              const assetRef = extractAssetRef(out);
              const draft = extractPromptDraft(part.toolName, out);
              if (draft) lastPromptDraft = draft;
              send(controller, {
                type: 'tool-result',
                tool: part.toolName,
                ...(assetRef ? { assetRef } : {}),
                output: out,
                idx: idx++,
              });
              break;
            }
            case 'tool-error': {
              // Surface the error as a resolved tool-result so the console's
              // chip leaves its spinner; the message lands in `output.error`.
              send(controller, {
                type: 'tool-result',
                tool: part.toolName,
                output: { error: getErrorMessage(part.error) || 'tool error' },
                idx: idx++,
              });
              break;
            }
            case 'abort': {
              aborted = true;
              break;
            }
            case 'error': {
              errored = true;
              send(controller, {
                type: 'error',
                error: getErrorMessage(part.error) || 'Agent stream error',
              });
              break;
            }
            // text-start/end, reasoning-*, tool-input-*, step markers, raw,
            // finish/finish-step are not surfaced individually — the terminal
            // `done` below carries the run telemetry.
            default:
              break;
          }
        }

        // Terminal telemetry, read AFTER the stream drains.
        if (!errored) {
          // Rich stop reason: a crossed soft budget or a tripped wall-clock /
          // abort guard, else the natural turn-end. Soft budget NEVER stops the
          // run mid-step (it's a meter) — this is purely the reported reason.
          const truncatedBy = aborted
            ? (runSignal.aborted && timeoutSignal.aborted ? 'wall_clock' : 'aborted')
            : live.budgetCrossed()
              ? 'soft_budget'
              : 'natural';
          send(controller, {
            type: 'done',
            // Back-compat: the last generate_prompt draft (the console surfaces
            // it when the agent produced no visible text).
            prompt: lastPromptDraft,
            // The accumulated visible answer for this turn.
            text: accumulatedText,
            cost: live.cost(),
            tokensUsed: live.tokensUsed(),
            runId: live.runId,
            modelId: live.modelId,
            provider: live.provider,
            truncatedBy,
          });
        }
      } catch (e: unknown) {
        send(controller, { type: 'error', error: getErrorMessage(e) || 'Agent stream error' });
      } finally {
        // Tear down the run context (HIL-gated tools) regardless of outcome.
        if (handle && 'dispose' in handle) handle.dispose();
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}

/**
 * AGENTIC-HARNESS: narrow a `runAgent` result to a live handle. The other
 * branch is the `{ noProvider: true }` shape (no model configured). A live
 * handle always carries the `stream` accessor; the no-provider shape never
 * does — so a `'stream' in` probe is the discriminant TS respects on a const.
 */
function isAgentHandle(
  r: Awaited<ReturnType<typeof import('@/lib/agent-core')['runAgent']>>,
): r is Extract<typeof r, { stream: unknown }> {
  return 'stream' in r;
}

/**
 * AGENTIC-HARNESS: read the conversation (`ModelMessage[]`) off the request
 * body for the agent-core path. The chat client builds it from its turns list
 * (operator→user, agent→assistant). We validate just enough shape to hand to
 * `runAgent` — each entry must have a string `role` and a `content` field
 * (string or array, the two shapes the SDK accepts). Drops malformed entries
 * rather than failing the whole request.
 */
function readModelMessages(body: Record<string, unknown>): ModelMessage[] {
  const raw = body.messages;
  if (!Array.isArray(raw)) return [];
  const out: ModelMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const rec = m as Record<string, unknown>;
    const role = rec.role;
    const content = rec.content;
    if (typeof role !== 'string') continue;
    const validContent =
      typeof content === 'string' || Array.isArray(content);
    if (!validContent) continue;
    out.push({ role, content } as ModelMessage);
  }
  return out;
}

/**
 * AGENTIC-HARNESS: pull a prompt draft out of a `generate_prompt` tool result,
 * for the back-compat `done.prompt`. Other tools return undefined.
 */
function extractPromptDraft(toolName: string, out: unknown): string | undefined {
  if (toolName !== 'generate_prompt') return undefined;
  if (!out || typeof out !== 'object') return undefined;
  const draft = (out as { draft?: unknown }).draft;
  return typeof draft === 'string' && draft.trim().length > 0 ? draft.trim() : undefined;
}

/** SSE response headers shared by the streaming director path. */
function sseHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-AI-Provider': 'minimax',
  };
}

/**
 * Best-effort extraction of a generated `{ provider, id, url }` AssetRef from
 * a tool result. generate_image / generate_video wrap it under `assetRef`;
 * we tolerate the raw shape too. Returns undefined for non-asset tools.
 */
function extractAssetRef(
  out: unknown,
): { provider: string; id: string; url: string } | undefined {
  if (!out || typeof out !== 'object') return undefined;
  const o = out as Record<string, unknown>;
  const candidate = (o.assetRef && typeof o.assetRef === 'object' ? o.assetRef : o) as Record<
    string,
    unknown
  >;
  if (
    typeof candidate.provider === 'string'
    && typeof candidate.id === 'string'
    && typeof candidate.url === 'string'
  ) {
    return { provider: candidate.provider, id: candidate.id, url: candidate.url };
  }
  return undefined;
}
