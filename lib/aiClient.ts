/**
 * Client-side helpers for streaming AI text. /api/pi/prompt and
 * /api/nca/prompt expose the same text/event-stream contract:
 *
 *   data: {"text":"<delta>"}\n\n
 *   ...
 *   data: {"error":"..."}\n\n   (on failure)
 *   data: [DONE]\n\n
 *
 * AI-AGENT-ROUTING: callers pass `provider: settings.activeAiAgent` to pick
 * which backend handles the request. Default is pi for back-compat
 * with installs that haven't toggled the AI Agent setting yet.
 *
 * Provider history:
 *   - 'pi'  — legacy default. Long-lived RPC subprocess via lib/pi-client.
 *   - 'mmx' — @deprecated 2026-06-02. Replaced by 'nca' on 2026-05-02
 *             (NCA-INTEGRATION-DEV). The mmx chat path had structural
 *             bugs (wrong stdin shape, SSE/JSON mixing); nca exposes
 *             a clean ndjson contract. The 'mmx' alias is kept as a
 *             back-compat redirect to nca so existing
 *             settings.activeAiAgent values keep working without a
 *             one-shot migration. Multimodal mmx routes
 *             (image/music/video/speech/describe) are NOT replaced —
 *             nca is text-only.
 *   - 'nca' — @deprecated 2026-06-02. Replaced by 'vercel-ai' as the
 *             second / fallback provider (0513-CONSOLIDATION). The
 *             nca subprocess path is still wired for installs that
 *             pinned `activeAiAgent: 'nca'` before v1.0.1 — the value
 *             keeps working and routes to /api/nca/prompt. New code
 *             should pick 'vercel-ai' for the default AI Agent. ndjson
 *             stream, MiniMax by default (M2.5; M2.7 / M2.7-highspeed
 *             available via NCA_MODEL env or per-call `model` param).
 *   - 'vercel-ai' — current default. Vercel AI SDK provider (no
 *             subprocess), served by /api/ai/prompt. LLM-INTEGRATION-
 *             0513. 0513-CONSOLIDATION trimmed the backend chain from
 *             {MiniMax, OpenAI, Anthropic, OpenRouter} to {MiniMax,
 *             OpenAI}; MiniMax is the default and OpenAI is the
 *             fallback. The 'vercel-ai' route is the only one
 *             recommended for new code.
 */

// 4NE-21 / Story 1.5: every streaming caller funnels through `streamAI`,
// so recording the MiniMax `usage` SSE event here centralises quota
// tracking for the stream path (tag/caption/enhance/negative-prompt/idea
// calls). Fire-and-forget — a persistence failure must never break the
// stream (see the try/catch around the call below).
import { recordTokens } from '@/lib/minimax-quota';
import type { CharacterId } from '@/lib/canon';
// AGENTIC-CORE: the agentic chat console resolves the operator's Higgsfield
// MCP connector client-side and threads it into `streamAgent` (the registry is
// browser-side; the route reads it from the body). Type-only import.
import type { McpServerConfig } from '@/lib/mcp';

export type PiMode =
  | 'chat'
  | 'generate'
  | 'idea'
  | 'enhance'
  | 'caption'
  | 'tag'
  | 'negative-prompt'
  | 'collection-info';

/**
 * Source-attribution record emitted by `/api/ai/prompt` when web-search
 * pre-enrichment yields hits (DDG/Brave snippets layered into the user
 * message). Shape is intentionally identical to `TrendSource` in
 * `Sidebar.tsx` so the existing trending-sources render path can show
 * /api/trending + /api/ai/prompt sources side-by-side without a second
 * UI affordance. The server fills `topic` with the bucket label
 * (`'web search'` / `'trending'`) and `source` with the URL's hostname.
 */
export interface AiSource {
  topic: string;
  headline: string;
  source: string;
  url: string;
}

export interface StreamAIOptions {
  mode?: PiMode;
  systemPrompt?: string;
  signal?: AbortSignal;
  /**
   * Active niches/genres from Settings. Forwarded verbatim to the route
   * so the server can tailor the trending web-search query (see
   * `buildTrendingQuery` in app/api/pi/prompt/route.ts). Only used for
   * `mode: 'idea'`; ignored for other modes.
   */
  niches?: string[];
  genres?: string[];
  /**
   * AI-AGENT-ROUTING: which AI agent backend handles this call. Mirrors
   * UserSettings.activeAiAgent.
   *
   * M3.3-P3 commit a: narrowed from `'pi' | 'nca' | 'mmx' | 'vercel-ai'`
   * to just `'vercel-ai'`. The pi/nca/mmx subprocess agents are
   * retired in v1.8.0; a one-shot IDB migration in `useSettings.ts`
   * rewrites any persisted legacy value to `'vercel-ai'` on first load.
   */
  provider?: 'vercel-ai';
  /**
   * Optional per-call model override, forwarded to the underlying
   * provider route as `body.model`. Currently only honoured by the
   * nca route (e.g. 'MiniMax-M2.7'); pi reads its model from server
   * env and ignores this field.
   */
  model?: string;
  /**
   * Invoked once per stream when the server emits a `sources` SSE
   * event — currently /api/ai/prompt sends one immediately after the
   * web-search pre-enrichment step, before any text deltas. Callbacks
   * are best-effort; throwing from the callback aborts the stream.
   * Non-vercel-ai providers don't emit this event and the callback
   * never fires.
   */
  onSources?: (sources: AiSource[]) => void;
  /**
   * V1.1.1-SKILLS-AUTO-USE: list of skill names from
   * `docs/research/higgsfield-skills/` to inject into the system
   * prompt for this stream. The frontend reads
   * `settings.activeSkills` and forwards the list here; the server
   * route loads + concatenates the skill bodies before calling
   * the model. Unknown names are silently ignored.
   */
  activeSkills?: string[];

  /**
   * V1.2.5: optional Higgsfield CLI token entered in Settings
   * → HiggsfieldConnection → "Higgsfield CLI token". When set,
   * the server forwards it to the @higgsfield/cli binary as
   * `HIGGSFIELD_API_KEY`, bypassing the OAuth web flow. The
   * CLI is the production path for power-users; the OAuth
   * flow remains the default for new users.
   */
  higgsfieldCliToken?: string;

  /**
   * M1 CANON-WIRING: the active Master4never character. Forwarded to
   * `/api/ai/prompt` so the server injects `buildCanonSystemBlock` for this
   * character into the text-mode system stack — every caption / idea / enhance
   * / tag / negative-prompt call stays on-canon. The frontend reads
   * `settings.activeCharacterId`; the server defaults to 'kael' when absent.
   */
  activeCharacterId?: CharacterId;
}

/**
 * Stream text deltas from /api/pi/prompt. Yields each token/chunk as it
 * arrives so callers can render progressively. The generator ends when
 * the server emits `[DONE]`.
 *
 * The per-request `systemPrompt` (e.g. `settings.agentPrompt`) is
 * forwarded verbatim and layered on top of the mode directive on the
 * server side. There is no longer a separate "global" client-side
 * system prompt — callers pass the single `agentPrompt` when they need
 * one.
 */
export async function* streamAI(
  message: string,
  options?: StreamAIOptions
): AsyncGenerator<string, void, void> {
  // AI-AGENT-ROUTING: pick the route based on the caller's provider hint.
  // M3.3-P3 commit a: `provider` is now strictly `'vercel-ai'`; the
  // nca + pi URL branches are gone and the canonical route is
  // `/api/ai/prompt`. A one-shot IDB migration in `useSettings.ts`
  // rewrites any persisted `'pi' | 'nca' | 'mmx'` value to
  // `'vercel-ai'` on first load, so callers that thread
  // `settings.activeAiAgent` through this option never see the
  // legacy variants here.
  const provider = options?.provider ?? 'vercel-ai';
  const url = '/api/ai/prompt';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      message,
      mode: options?.mode,
      systemPrompt: options?.systemPrompt,
      niches: options?.niches,
      genres: options?.genres,
      model: options?.model,
      // V1.1.1-SKILLS-AUTO-USE: forward the active skill list to
      // the server so it can load + inject the skill bodies into
      // the system prompt. Pi and nca routes ignore this field
      // (they build the system prompt server-side from their own
      // state), but vercel-ai honors it.
      activeSkills: options?.activeSkills,
      // V1.2.5: forward the user's CLI token (if any) to the
      // server. The route plumbs it into the provider registry
      // before the next `getProvider('higgsfield')` call.
      higgsfieldCliToken: options?.higgsfieldCliToken,
      // M1 CANON-WIRING: forward the active Master4never character so the
      // server injects the right canon block. Omitted → server default 'kael'.
      activeCharacterId: options?.activeCharacterId,
    }),
    signal: options?.signal,
  });

  if (!res.ok || !res.body) {
    let errMsg = `${provider} request failed (${res.status})`;
    try {
      const err = await res.json() as Record<string, unknown>;
      if (typeof err?.error === 'string') errMsg = err.error;
    } catch {
      // ignore
    }
    throw new Error(errMsg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIndex: number;
    while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);

      for (const line of rawEvent.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          if (parsed.error) throw new Error(String(parsed.error));
          // 4NE-21 / Story 1.5: the route emits one terminal `usage` event
          // (from MiniMax's include_usage chunk) just before [DONE]. Record
          // those tokens against the monthly quota. Fire-and-forget and
          // fully isolated — we never yield it as text and a record failure
          // must not break the stream for the caller.
          if (parsed.usage && typeof parsed.usage === 'object') {
            try {
              const u = parsed.usage as { input?: unknown; output?: unknown };
              const inTok = typeof u.input === 'number' ? u.input : 0;
              const outTok = typeof u.output === 'number' ? u.output : 0;
              void recordTokens(inTok, outTok).catch(() => {});
            } catch {
              // recording is best-effort; swallow everything
            }
          }
          if (Array.isArray(parsed.sources) && options?.onSources) {
            // Best-effort cast: server-side shape matches AiSource by
            // construction (see /api/ai/prompt's sources emission).
            // Filter defensively so a malformed entry doesn't poison
            // the callback's downstream renderer.
            const clean: AiSource[] = [];
            for (const s of parsed.sources) {
              if (s && typeof s === 'object') {
                const r = s as Record<string, unknown>;
                if (
                  typeof r.topic === 'string' &&
                  typeof r.headline === 'string' &&
                  typeof r.source === 'string' &&
                  typeof r.url === 'string'
                ) {
                  clean.push({ topic: r.topic, headline: r.headline, source: r.source, url: r.url });
                }
              }
            }
            if (clean.length > 0) options.onSources(clean);
          }
          if (typeof parsed.text === 'string' && parsed.text.length > 0) {
            yield parsed.text;
          }
        } catch (e) {
          if (e instanceof Error && e.message && !e.message.startsWith('Unexpected')) {
            throw e;
          }
          // Ignore malformed lines — keepalives or partial frames.
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// AGENTIC-CORE: the agentic chat console's client entry.
//
// `streamAgent` is the sibling of `streamAI` for the TOOL-USING director path.
// Where `streamAI` POSTs `mode:'chat'|'idea'|…` and yields plain text deltas
// (the legacy tool-less MiniMax stream), `streamAgent` POSTs
// `mode:'director', stream:true` and yields TYPED events so the console can
// render the agent's reasoning, its tool-calls (generate_prompt, critique_prompt,
// generate_image → Higgsfield, …) as chips, and the produced beat thumbnails.
//
// The MCP connector registry + skills + active character all live CLIENT-side
// (browser storage), so the caller resolves them (useConnectors / useSkills /
// useSettings) and threads them in here; the route reads them out of the body
// — exactly the pattern the generate route uses.
// ---------------------------------------------------------------------------

/** One produced asset reference surfaced by a generate_image/video tool. */
export interface AgentAssetRef {
  provider: string;
  id: string;
  url: string;
}

/**
 * A typed event yielded by `streamAgent`. Mirrors the SSE shape emitted by
 * `/api/ai/prompt`'s streaming director path (`handleDirectorStream`).
 */
export type AgentEvent =
  | { type: 'text'; text: string; stepType?: string; idx?: number }
  // The internal director-plan step. Carries NO scaffold text — it's a marker
  // so the console can show a subtle "planning…" pill. The plan scaffold is
  // deliberately NOT streamed to the visible chat (it's Replay-UI-only); see
  // `stepToEvent` in app/api/ai/prompt/route.ts.
  | { type: 'plan'; stepType?: string; idx?: number }
  | { type: 'tool-call'; tool: string; args?: unknown; idx?: number; cost?: number }
  | {
      type: 'tool-result';
      tool: string;
      assetRef?: AgentAssetRef;
      output?: unknown;
      idx?: number;
    }
  | {
      type: 'done';
      prompt: string;
      cost?: number;
      tokensUsed?: { input: number; output: number };
      runId?: string;
      modelId?: string;
      provider?: string;
      truncatedBy?: string;
      canon?: unknown;
    }
  | { type: 'error'; error: string };

export interface StreamAgentOptions {
  /** 1-6 content pillars (Director requires at least one). */
  niches: string[];
  /** 0-10 style tags. */
  genres?: string[];
  /** The active Master4never character whose canon anchors the run. */
  characterId?: CharacterId;
  /**
   * The operator's resolved, enabled+trusted Higgsfield MCP connector. The
   * registry is client-side, so the console resolves it (useConnectors) and
   * passes it here; the route threads it into the loop so generate_image can
   * submit through Higgsfield. Omit → the tool raises a clear in-loop error.
   */
  higgsfieldConnector?: McpServerConfig;
  /** Active skill names (useSkills/useSettings). Folded into the prompt. */
  skills?: { name: string; version?: string }[];
  /** Optional per-call text-model override (settings.activeTextModel). */
  model?: string;
  /** Optional Higgsfield CLI token (settings.higgsfieldCliToken). */
  higgsfieldCliToken?: string;
  /** Storage partition key for the run log. */
  userId?: string;
  /** Optional hard step cap / USD budget for this run. */
  maxSteps?: number;
  budgetUsd?: number;
  signal?: AbortSignal;
}

/**
 * Stream the Director agent loop. POSTs `mode:'director', stream:true` to
 * `/api/ai/prompt` and yields typed `AgentEvent`s as the loop plans, calls
 * tools, and produces assets. The generator ends when the server emits
 * `[DONE]`. A server-side failure arrives as a terminal `{type:'error'}`
 * event (not a throw) so the console can render it in-thread; a transport /
 * network failure (the fetch itself) still throws.
 */
export async function* streamAgent(
  message: string,
  options: StreamAgentOptions,
): AsyncGenerator<AgentEvent, void, void> {
  const res = await fetch('/api/ai/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      mode: 'director',
      stream: true,
      // The Director loop reads the concept from `ideaConcept` (not `message`).
      ideaConcept: message,
      // Clamp to the director input schema (niches <=6, genres <=10) so the
      // operator's full Settings lists never trip runDirectorLoop validation.
      niches: (options.niches ?? []).slice(0, 6),
      genres: (options.genres ?? []).slice(0, 10),
      activeCharacterId: options.characterId,
      higgsfieldConnector: options.higgsfieldConnector,
      skillContext: options.skills,
      model: options.model,
      higgsfieldCliToken: options.higgsfieldCliToken,
      userId: options.userId,
      maxSteps: options.maxSteps,
      budgetUsd: options.budgetUsd,
    }),
    signal: options.signal,
  });

  if (!res.ok || !res.body) {
    let errMsg = `agent request failed (${res.status})`;
    try {
      const err = (await res.json()) as Record<string, unknown>;
      if (typeof err?.error === 'string') errMsg = err.error;
    } catch {
      // ignore — non-JSON error body
    }
    throw new Error(errMsg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIndex: number;
    while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);

      for (const line of rawEvent.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data) as AgentEvent;
          if (parsed && typeof (parsed as { type?: unknown }).type === 'string') {
            yield parsed;
          }
        } catch {
          // Ignore malformed lines — keepalives or partial frames.
        }
      }
    }
  }
}

/**
 * Convenience: consume the whole stream and return the concatenated text.
 * Use this for callers that parse JSON output and don't need progressive
 * rendering.
 */
export async function streamAIToString(
  message: string,
  options?: StreamAIOptions
): Promise<string> {
  let out = '';
  for await (const delta of streamAI(message, options)) {
    out += delta;
  }
  // Reasoning models (MiniMax-M2.5, GLM-5.1, DeepSeek-R1…) emit
  // <think>…</think> chain-of-thought before the answer. Callers like
  // expandIdeaToPrompt forward this string straight to Leonardo as an
  // image prompt, so leaking reasoning tags corrupts generation for
  // every non-MiniMax model. Strip here at the boundary; downstream
  // JSON parsers re-strip idempotently.
  return stripThinkBlocks(out);
}

/**
 * Strip `<think>…</think>` reasoning blocks from a model response.
 *
 * MiniMax-M2.5 (and other reasoning models — GLM-5.1, DeepSeek-R1
 * family, etc.) emit their chain-of-thought wrapped in literal
 * `<think>…</think>` tags before the actual answer. The reasoning
 * block can itself contain JSON-like text or stray brace characters,
 * which trips up the first-open/last-close brace-slice strategy in
 * `parseJsonFromLLM` and produces a swallowed `JSON.parse` error.
 *
 * Exported so server-side helpers (e.g. /api/ai/image's prompt
 * cleaner) can share the same logic. Greedy across newlines because
 * a single `<think>` block can span dozens of lines. Tolerates a
 * runaway opening tag without a closing tag — that's the model
 * truncating mid-reasoning; we discard everything from the unmatched
 * `<think>` to end-of-string rather than parse partial reasoning as
 * the answer.
 */
export function stripThinkBlocks(raw: string): string {
  let out = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  // Drop any unterminated leading <think>… block (model truncated
  // before emitting the closing tag).
  const openIdx = out.indexOf('<think>');
  if (openIdx !== -1 && !out.slice(openIdx).includes('</think>')) {
    out = out.slice(0, openIdx);
  }
  return out.trim();
}

/**
 * Robust JSON extraction from an LLM response.
 *
 * Reasoning models (GLM-5.1, MiniMax-M2.5, et al.) frequently wrap
 * their output in `<think>…</think>` blocks AND markdown code fences,
 * sometimes append explanatory commentary after the closing bracket.
 * JSON.parse rejects anything around the top-level value, so this
 * helper strips think blocks, strips fences, then slices from the
 * first `[` to the last `]` (or `{` / `}` for objects) before
 * parsing. Falls back to an empty array / object on empty input.
 */
function parseJsonFromLLM(raw: string, kind: 'array' | 'object'): unknown {
  let text = stripThinkBlocks(raw)
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();
  const fallback = kind === 'array' ? [] : {};
  if (!text) return fallback;
  const open = kind === 'array' ? '[' : '{';
  const close = kind === 'array' ? ']' : '}';
  const first = text.indexOf(open);
  const last = text.lastIndexOf(close);
  if (first !== -1 && last > first) {
    text = text.slice(first, last + 1);
  }
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Typed entry points for LLM JSON parsing. Each helper enforces the
 * top-level shape at runtime — callers get an empty array / object
 * (not a cast lie) if the LLM returns the wrong kind.
 */
export function extractJsonArrayFromLLM(raw: string): unknown[] {
  const parsed = parseJsonFromLLM(raw, 'array');
  return Array.isArray(parsed) ? parsed : [];
}

export function extractJsonObjectFromLLM(raw: string): Record<string, unknown> {
  const parsed = parseJsonFromLLM(raw, 'object');
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}
