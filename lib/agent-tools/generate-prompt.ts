/**
 * v1.2 Tool Registry — `generate_prompt` tool.
 *
 * Calls an AI text model (M3 text+vision capable by default — the
 * Vercel AI SDK's `LanguageModel`) with a carefully composed prompt
 * template that folds in the user's content pillars, style tags,
 * active skills, and any trending context the Director pre-fetched.
 *
 * Why this is *not* just a route handler in `app/api/ai/prompt`:
 * the tool registry is the contract for the agent loop. The same
 * tool() definition can be invoked from:
 *   - the Director route's `generateText({ tools, ... })` call,
 *   - a future Replay UI that re-runs a single tool step,
 *   - an eval harness that wants to A/B-test prompt templates.
 *
 * The model used here is intentionally swappable: the Vercel AI SDK
 * accepts any `LanguageModel` (MiniMax M3, OpenAI gpt-4o-mini, etc.)
 * and the active choice is determined by env vars the same way
 * `app/api/ai/prompt/route.ts` does it. See `resolveTextModel` from
 * `lib/text-model-catalog`.
 */
import { tool, generateText, type LanguageModel } from 'ai';
import { extractDraftFromCommentary, trimCommentarySuffix } from './prompt-extract';
import {
  GeneratePromptInput,
  GeneratePromptOutput,
  zGeneratePromptInput,
  zGeneratePromptOutput,
  type SkillRef,
} from './schemas';
import {
  ToolNotAvailableError,
  ToolExecutionError,
  safeExecute,
  type ToolResult,
} from './errors';
import { buildDefaultAgentPrompt } from '@/lib/agent-prompt';

// ---------------------------------------------------------------------------
// Model resolution — mirrors `app/api/ai/prompt/route.ts`
// ---------------------------------------------------------------------------

interface ResolvedTextModel {
  provider: 'minimax' | 'openai';
  model: LanguageModel;
  modelId: string;
}

/**
 * Resolve a Vercel AI SDK text model from env vars. Same precedence
 * as the route handler (MINIMAX_API_KEY wins over OPENAI_API_KEY).
 *
 * Returns `null` when no API key is configured. The tool then
 * throws ToolNotAvailableError so the Director loop gets a clear
 * "not configured" failure instead of an opaque SDK error.
 *
 * Dynamic import: `@ai-sdk/openai` is a heavy module and we want
 * the agent-tools bundle to stay light for unit tests / web.
 */
async function resolveTextModel(opts: { override?: string }): Promise<ResolvedTextModel | null> {
  if (process.env.MINIMAX_API_KEY) {
    const { createOpenAI } = await import('@ai-sdk/openai');
    const openai = createOpenAI({
      apiKey: process.env.MINIMAX_API_KEY,
      baseURL: 'https://api.minimaxi.chat/v1',
    });
    const modelId = opts.override || process.env.VERCEL_AI_MODEL || 'MiniMax-M3';
    // MiniMax only implements /v1/chat/completions — the default `openai(id)`
    // callable targets the Responses API (/v1/responses) which 404s there and
    // makes the Director return an empty prompt. `openai.chat(id)` pins the
    // chat-completions transport. Mirrors lib/agent-loop/index.ts.
    return { provider: 'minimax', model: openai.chat(modelId), modelId };
  }
  if (process.env.OPENAI_API_KEY) {
    const { createOpenAI } = await import('@ai-sdk/openai');
    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const modelId = opts.override || 'gpt-4o-mini';
    return { provider: 'openai', model: openai.chat(modelId), modelId };
  }
  return null;
}

// ---------------------------------------------------------------------------
// System-prompt assembly
// ---------------------------------------------------------------------------

/**
 * Compose the system prompt the model sees when it generates the
 * draft. The base persona (lib/agent-prompt) anchors the role; the
 * niche/genre orientation narrows the focus; the skill catalogue
 * declares which named fragments will be folded in. Trending
 * context is layered into the user message (not the system prompt)
 * because the model treats it as fresh evidence, not as
 * instructions.
 */
function buildSystemPrompt(input: GeneratePromptInput): string {
  const basePersona = buildDefaultAgentPrompt({
    niches: input.niches,
    genres: input.genres,
  });

  if (input.skillContext.length === 0) return basePersona;

  const skillList = input.skillContext
    .map((s) => `- ${s.name}${s.version ? ` (v${s.version})` : ''}`)
    .join('\n');

  return [
    basePersona,
    '',
    'Active skills (fold the relevant fragments into the draft; only list a skill in `usedSkills` if it materially shaped the output):',
    skillList,
  ].join('\n');
}

/**
 * Build the user message. Trending context is appended as
 * "inspiration hints" with an explicit "do not quote" clause so
 * the model treats them as flavour, not as a content-source.
 */
function buildUserMessage(input: GeneratePromptInput): string {
  const parts: string[] = [
    `Angle: ${input.angle}`,
    '',
    `Niches: ${input.niches.join(', ')}`,
    `Genres: ${input.genres.join(', ')}`,
  ];

  if (input.trendingContext && input.trendingContext.length > 0) {
    const trendingLines = input.trendingContext
      .slice(0, 10) // hard cap so a runaway context doesn't blow the prompt
      .map((t) => `- [${t.niche}] ${t.title}${t.snippet ? ` — ${t.snippet}` : ''}`)
      .join('\n');
    parts.push(
      '',
      'Trending context (use as flavour, do not quote or paraphrase verbatim):',
      trendingLines,
    );
  }

  parts.push(
    '',
    'Generate a single image-prompt draft (40-150 words) that realises the angle above. Return ONLY the prompt text — no preamble, no JSON, no markdown fence.',
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

/**
 * Strip `<think>…</think>` reasoning blocks, markdown fence wrappers,
 * and the model's own "commentary" around the actual prompt. Mirrors
 * `stripThinkBlocks` in `lib/aiClient.ts` for the SSE client path;
 * duplicated here to avoid pulling the SSE client into a server-side
 * tool def. The commentary-stripping step (V1.7.0-PRE-PROD-FIX) lives
 * in `./prompt-extract.ts` and is shared with the agent-loop fallback
 * path so both stay in lock-step.
 */
function cleanModelOutput(raw: string): string {
  // 1. Strip <think>…</think> blocks (terminated + unterminated leading).
  let out = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const openIdx = out.indexOf('<think>');
  if (openIdx !== -1 && !out.slice(openIdx).includes('</think>')) {
    out = out.slice(0, openIdx);
  }
  // 2. Strip markdown fence wrappers.
  out = out
    .replace(/^```(?:text|json|markdown)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
  // 3. V1.7.0-PRE-PROD-FIX: pull just the draft body out of the
  //    commentary the model loves to wrap around it ("The checker is
  //    strict…", "Final prompt (copy-paste ready):", "Niches anchored.
  //    Ready to feed to generate_image — just say the word"). Without
  //    this, the entire commentary leaked into the image prompt and
  //    the image model produced off-topic output.
  const { draft } = extractDraftFromCommentary(out);
  // 4. Defensive: drop any trailing commentary the model appends
  //    AFTER the prompt body itself.
  return trimCommentarySuffix(draft);
}

/**
 * Pick the subset of `input.skillContext` whose names appear in
 * the cleaned prompt text. This is a coarse heuristic — a real
 * "did the skill influence the draft?" test would require the
 * model itself to report used skills. For now we approximate
 * with a token match (case-insensitive, whole-word).
 */
function inferUsedSkills(draft: string, skillContext: SkillRef[]): string[] {
  if (skillContext.length === 0) return [];
  const lower = draft.toLowerCase();
  const used: string[] = [];
  for (const s of skillContext) {
    const name = s.name.toLowerCase();
    // Whole-word match to avoid "anime" matching "animator".
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(lower)) used.push(s.name);
  }
  return used;
}

// ---------------------------------------------------------------------------
// Public API: typed execute() for non-SDK callers
// ---------------------------------------------------------------------------

/**
 * Execute `generate_prompt` without the AI SDK wrapper. The
 * function is pure from the caller's perspective: throw an
 * `AgentToolError` (or one of the `safeExecute`-wrapped shapes)
 * on failure, return a `zGeneratePromptOutput` on success.
 */
export async function executeGeneratePrompt(
  rawInput: unknown,
  opts: { signal?: AbortSignal; modelOverride?: string } = {},
): Promise<ToolResult<GeneratePromptOutput>> {
  return safeExecute(async () => {
    const parsed = zGeneratePromptInput.safeParse(rawInput);
    if (!parsed.success) throw parsed.error;
    const input = parsed.data;

    const resolved = await resolveTextModel({ override: opts.modelOverride });
    if (!resolved) {
      throw new ToolNotAvailableError(
        'generate_prompt',
        'no AI provider configured (set MINIMAX_API_KEY or OPENAI_API_KEY)',
      );
    }

    const system = buildSystemPrompt(input);
    const userMessage = buildUserMessage(input);

    let result;
    try {
      result = await generateText({
        model: resolved.model,
        system,
        prompt: userMessage,
        abortSignal: opts.signal,
      });
    } catch (e) {
      // Network / SDK errors — wrap as a retryable execution error.
      const reason = e instanceof Error ? e.message : String(e);
      throw new ToolExecutionError('generate_prompt', reason, {
        retryable: true,
        cause: e,
      });
    }

    const raw = result.text ?? '';
    const draft = cleanModelOutput(raw);
    const usedSkills = inferUsedSkills(draft, input.skillContext);

    const output = zGeneratePromptOutput.parse({
      draft,
      usedSkills,
      modelId: resolved.modelId,
    });
    return output;
  });
}

// ---------------------------------------------------------------------------
// Vercel AI SDK `tool()` definition
// ---------------------------------------------------------------------------

/**
 * The `generate_prompt` tool. Designed for the Director loop in
 * `app/api/ai/prompt/route.ts` (added in v1.2.2). The model picks
 * this tool when it has a clear angle and wants a draft prompt to
 * critique.
 */
export const generatePromptTool = tool({
  description:
    "Generate a draft image-prompt that realises the given angle, anchored by the user's content pillars and style tags. Optionally folds in named skills (camera-angles, voice guides) and trending context. Returns the draft text plus a list of skills that materially shaped the output.",
  inputSchema: zGeneratePromptInput,
  outputSchema: zGeneratePromptOutput,
  execute: async (input, options) => {
    const result = await executeGeneratePrompt(input, {
      signal: options?.abortSignal,
    });
    if (!result.ok) throw result.error;
    return result.value;
  },
});
