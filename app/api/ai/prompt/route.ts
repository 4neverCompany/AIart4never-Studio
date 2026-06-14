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
// Provider selection priority (first env var wins):
//   1. MINIMAX_API_KEY     → minimax (default model: MiniMax-M2.5)
//   2. OPENAI_API_KEY      → openai (default model: gpt-4o-mini)
//
// 0513-CONSOLIDATION: the v1.0 chain was MiniMax → OpenAI → Anthropic →
// OpenRouter. Post-v1.0 cleanup cut the secondary providers to keep the
// dependency surface minimal. MiniMax remains the default (project has
// long-standing MiniMax credentials from the nca subprocess path);
// OpenAI is the only fallback. The pi route and nca route are unaffected
// by this trim and remain the AI Agent settings options.
//
// MiniMax sits at the top because the project already has long-standing
// MiniMax credentials (used by the nca subprocess path). The release/
// production deploy starts with no key set — the user pastes one in the
// Settings setup flow (or sets MINIMAX_API_KEY on Vercel) just like the
// other providers.
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

import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { getErrorMessage } from '@/lib/errors';
import { buildSkillSystemBlock } from '@/lib/skill-loader';
import {
  getTextModelParams,
  resolveTextModel,
  getDefaultTextModelForProvider,
  type TextGenParams,
} from '@/lib/text-model-catalog';
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
  "You are a creative AI assistant for MashupForge, an AI-driven studio that generates crossover image prompts across Star Wars, Marvel, DC, Warhammer 40k, and other fictional universes. Follow instructions precisely. When asked to return JSON, return ONLY valid JSON with no preamble, no commentary, and no markdown code fences. When asked for a single string, return ONLY that string.";

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
  idea:
    'You are a creative genius generating crossover concepts that break the internet. Marvel, DC, Star Wars, Warhammer 40k, anime, games — the wildest, most visually spectacular mashups imaginable. Avoid overused characters. Return ONLY the requested format.',
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
    'You are the Director agent of MashupForge. Operate the multi-step plan as described in your system prompt.',
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
  // 0513-CONSOLIDATION: chain trimmed from {minimax, openai, anthropic,
  // openrouter} to {minimax, openai}. See module header for rationale.
  name: 'minimax' | 'openai';
  model: LanguageModel;
  modelId: string;
}

/**
 * Pick a provider from env vars + optional per-request model override.
 * Returns null when no API key is configured — caller should 503.
 *
 * `modelOverride` (when present) is passed through verbatim. There's no
 * cross-provider validation: if a caller asks openai for an Anthropic
 * model name they get an opaque API error from the provider, which is
 * the right behaviour — we shouldn't second-guess the user.
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
    process.env.MINIMAX_API_BASE_URL?.trim() || 'https://api.minimaxi.chat/v1';
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
      if (payload === '[DONE]') return;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ text: delta })}\n\n`),
          );
        }
      } catch {
        // Malformed chunk — skip. SSE keepalive comments and partial
        // chunks at buffer boundaries can land here.
      }
    }
  }
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
    const minimax = createOpenAI({
      apiKey: process.env.MINIMAX_API_KEY,
      baseURL: 'https://api.minimaxi.chat/v1',
    });
    return { name: 'minimax', model: minimax(modelId), modelId };
  }
  if (process.env.OPENAI_API_KEY) {
    const modelId =
      requestedModel || getDefaultTextModelForProvider('openai') || 'gpt-4o-mini';
    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return { name: 'openai', model: openai(modelId), modelId };
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
        error:
          'No AI provider configured. Set MINIMAX_API_KEY (preferred) or OPENAI_API_KEY.',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const directive = directiveFor(mode);
  const cleanNiches = sanitizeStringArray(niches);
  const cleanGenres = sanitizeStringArray(genres);
  const focusBlock = buildFocusBlock(cleanNiches, cleanGenres);
  const userSystem = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
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
  // Ordering matches the pi route: directive sets the role, user
  // prompt refines it, focus block targets niches, skills layer
  // authoritative directives on top. BASE_SYSTEM_PROMPT anchors
  // the whole stack so output formatting (JSON-only, no fences)
  // stays consistent across providers.
  const system =
    [BASE_SYSTEM_PROMPT, directive, userSystem, focusBlock, skillBlock]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join('\n\n') || undefined;

  // Web-search pre-enrichment. MiniMax and OpenAI don't have built-in
  // browsing on the vercel AI SDK adapter (pi.dev and nca route their
  // own search), so we pre-fetch a short snippet block and append it
  // to the user's message before the model sees it. Strictly
  // best-effort: any failure falls through with no enrichment so a
  // flaky search backend can't break the request.
  //
  // Two modes get enrichment:
  //   - `idea`: query built from niches + genres + trending keywords,
  //     surfaces what's currently hot in the user's fandom areas.
  //   - `chat`: query is the user's message itself, gives the model
  //     a snapshot of recent web context for whatever they asked
  //     about (news, releases, "what's the latest on X").
  //
  // Other modes (enhance, caption, tag, etc.) skip enrichment — the
  // benefit doesn't justify the latency cost or rate-limit footprint
  // for prompt-rewrite / metadata generation work.
  let enrichedMessage = message;
  // Source attribution forwarded to the client via an SSE `sources`
  // event before the text stream starts. Same shape as TrendSource in
  // Sidebar.tsx so the existing trending-sources render path can show
  // these alongside /api/trending hits without a separate UI affordance.
  let gatheredSources: Array<{
    topic: string;
    headline: string;
    source: string;
    url: string;
  }> = [];
  const shouldEnrich = mode === 'idea' || mode === 'chat';
  if (shouldEnrich) {
    let query: string;
    let enrichmentLabel: string;
    let bucketLabel: string;
    if (mode === 'idea') {
      const queryParts = [
        'trending',
        ...cleanNiches,
        ...cleanGenres,
        'fandom crossover fanart 2026',
      ].filter((s) => s.length > 0);
      query = queryParts.join(' ');
      enrichmentLabel = 'Trending context for inspiration (recent search results, use as flavour, do not quote verbatim):';
      bucketLabel = 'trending';
    } else {
      // chat mode — search backends (DDG/Brave) truncate around 400-500
      // chars; cap the query so long chat messages still produce useful
      // matches instead of being dropped.
      query = message.trim().slice(0, 400);
      enrichmentLabel = 'Recent web context for the question above (cite naturally only if relevant, do not invent URLs):';
      bucketLabel = 'web search';
    }

    // Skip enrichment for trivially short chat messages (greetings,
    // acknowledgements). Idea mode always runs even with empty niches
    // because the trending-fandom suffix is itself a useful seed.
    const minLength = mode === 'chat' ? 8 : 1;
    if (query.length >= minLength) {
      try {
        // CAMOFOX-CAMOUFOX-1.1.0 (2026-06-06): route the AI prompt's
        // trending/web context through the camofox sidecar first,
        // fall back to webSearch() on any camofox failure. This is
        // the highest-CAPTCHA-pressure call-site in the codebase
        // (per master plan §4, call-site #4) so the migration has
        // the most leverage here.
        //
        // KNOWN GAP: camofoxSearch returns empty snippets (the
        // /extract + JSON-schema path is a Day 4 enhancement). The
        // enrichment below drops the snippet filter and shows
        // title-only lines. The UI source badge still works.
        const { withCamofoxHealth, scrubPii } = await import('@/lib/camofox');
        const results = await withCamofoxHealth(
          () =>
            import('@/lib/camofox').then((m) =>
              m.camofoxSearch({
                userId: 'ai-route',
                sessionKey: `ai-${bucketLabel}-${Date.now()}`,
                macro: '@google_search',
                query,
                count: 5,
              }),
            ),
          () => import('@/lib/web-search').then((m) => m.webSearch(query, 5)),
        );
        if (results.length > 0) {
          // CAMOFOX-CAMOUFOX-1.1.0: PII-scrub the snapshots before
          // building the enrichment lines. We don't have a session
          // config in this code path (ai/prompt is anonymous for
          // v1.0.x), so currentUserHandle is null and scrubPii is
          // a no-op. The hook is in place for the future
          // SessionConfig integration.
          const top3 = results
            .slice(0, 3)
            .filter((r) => r.title && r.url);
          const snippetLines = top3
            .map((r) => {
              // PII-scrub defensively (no-op when currentUserHandle
              // is null). Title and url don't need scrubbing in the
              // camofox path, but the snapshot text would.
              const title = scrubPii(r.title, null);
              return r.snippet
                ? `- ${title}: ${scrubPii(r.snippet, null)}`
                : `- ${title}`;
            })
            .filter((line) => line.length > 4);
          if (snippetLines.length > 0) {
            enrichedMessage =
              message +
              '\n\n' +
              enrichmentLabel +
              '\n' +
              snippetLines.join('\n');
          }
          // Build source records for the UI badge regardless of whether
          // the snippets met the enrichment threshold — the user benefits
          // from knowing the source list even when a single hit doesn't
          // produce a usable snippet line.
          gatheredSources = top3.map((r) => {
            let host = '';
            try {
              host = new URL(r.url).hostname.replace(/^www\./, '');
            } catch {
              // URL constructor throws on malformed input; fall back to
              // the raw URL so the badge still has something to render.
              host = r.url;
            }
            return { topic: bucketLabel, headline: r.title, source: host, url: r.url };
          });
        }
      } catch {
        // Non-critical — leave enrichedMessage as the original message
        // and gatheredSources empty.
      }
    }
  }

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

  // Synthesise our own SSE stream. The SDK exposes textStream as an
  // AsyncIterable<string>, which makes the per-delta SSE wrap trivial
  // and keeps the route's wire shape identical to /api/pi/prompt and
  // /api/nca/prompt without depending on Vercel's data-protocol wrapper.
  //
  // MiniMax exception: the ai SDK v6 OpenAI adapter calls /v1/responses
  // (the new OpenAI Responses API), but MiniMax only exposes the older
  // /v1/chat/completions endpoint. So for MiniMax we bypass streamText
  // and call the chat endpoint directly. The output SSE wire shape is
  // unchanged — every chunk still leaves this route as
  // `data: {"text":"<delta>"}\n\n`.
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

        if (provider.name === 'minimax') {
          await streamMinimaxChat(controller, encoder, system, enrichedMessage, provider.modelId, textParams);
        } else {
          const result = streamText({
            model: provider.model,
            system,
            prompt: enrichedMessage,
            ...(textParams.temperature !== undefined && { temperature: textParams.temperature }),
            ...(textParams.maxTokens !== undefined && { maxTokens: textParams.maxTokens }),
            ...(textParams.topP !== undefined && { topP: textParams.topP }),
          });
          for await (const delta of result.textStream) {
            if (!delta) continue;
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ text: delta })}\n\n`),
            );
          }
        }
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
//     "ideaConcept": "Darth Vader in Iron Man suit",
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
          error:
            'No AI provider configured. Set MINIMAX_API_KEY (preferred) or OPENAI_API_KEY.',
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
        runId: result.runId,
        modelId: result.modelId,
        provider: result.provider,
        truncatedBy: result.truncatedBy,
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
