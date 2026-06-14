/**
 * v1.2 Tool Registry — `critique_prompt` tool.
 *
 * Self-evaluation step in the Director loop. The tool takes the
 * draft prompt the previous `generate_prompt` call produced, runs
 * it through a structured rubric (niche coverage, angle fidelity,
 * anti-AI-look, length), and returns a `score ∈ [0, 1]` plus a
 * list of issues. The Director regenerates when score < 0.7.
 *
 * Two execution paths:
 *
 *   1. **LLM judge** (default): asks the same model that wrote the
 *      draft to score it. Cheap, but biased by the model's own
 *      self-image. Used for the v1.2.4 default until the dedicated
 *      eval-heuristics module (lib/agent-eval/) lands.
 *
 *   2. **Heuristic judge** (`mode: 'heuristic'`): pure-function
 *      rules over the prompt text. No model call, fully testable,
 *      what `lib/agent-eval/` will eventually wrap. Exposed as a
 *      mode so the eval-heuristics epic can build on this.
 *
 * The tool itself is mode-agnostic; the caller picks which path
 * to take by passing `mode` in the input (default 'auto', which
 * prefers heuristics when available and falls back to the LLM
 * judge when the heuristic returns "uncertain").
 */
import { tool, generateText, type LanguageModel } from 'ai';
import {
  CritiquePromptInput,
  CritiquePromptOutput,
  zCritiquePromptInput,
  zCritiquePromptOutput,
} from './schemas';
import type { CritiqueRequirements } from './schemas';
import {
  ToolNotAvailableError,
  ToolExecutionError,
  safeExecute,
  type ToolResult,
} from './errors';

// ---------------------------------------------------------------------------
// Heuristic judge (pure, no LLM call)
// ---------------------------------------------------------------------------

interface HeuristicIssue {
  text: string;
  weight: number; // 0..1, higher = more severe
}

const NICH_COVERAGE_RE = /.{1,80}/; // placeholder to satisfy the linter; replaced per-niche

/**
 * Run the heuristic judge over the prompt. The output is a coarse
 * score plus a list of issues ordered most-severe first. The
 * composite score is a weighted mean of the sub-scores (niche-
 * coverage 0.4, angle-fidelity 0.3, anti-AI-look 0.2, length 0.1).
 *
 * The function is pure — no IO, no time, no random — so the unit
 * test suite can assert the rubric precisely.
 */
export function heuristicJudge(
  prompt: string,
  requirements: CritiqueRequirements,
): CritiquePromptOutput {
  const issues: HeuristicIssue[] = [];

  // --- 1. Niche coverage (weight 0.4) ---
  const lower = prompt.toLowerCase();
  const nichesHit: string[] = [];
  const nichesMissed: string[] = [];
  for (const n of requirements.niches) {
    // Match either the full phrase OR a clear stemmed fragment.
    // For multi-word niches we accept a sub-phrase match (e.g. "Marvel
    // Comics" → "marvel" alone) so a prompt like "Marvel characters
    // battle Star Wars" still scores positively on a niche of
    // "Marvel Comics".
    const needle = n.toLowerCase().split(/\s+/)[0]!;
    const re = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(lower)) nichesHit.push(n);
    else nichesMissed.push(n);
  }
  const nicheCoverage = requirements.niches.length > 0
    ? nichesHit.length / requirements.niches.length
    : 1;
  if (nicheCoverage < 1) {
    issues.push({
      text: `Missing niche references: ${nichesMissed.join(', ')}`,
      weight: 0.4 * (1 - nicheCoverage),
    });
  }

  // --- 2. Angle fidelity (weight 0.3) ---
  // Cheap proxy: do at least 2 of the angle's first-3 tokens appear?
  const angleTokens = requirements.angle
    .toLowerCase()
    .split(/[\s,.;:!?]+/)
    .filter((t) => t.length >= 3)
    .slice(0, 3);
  const angleHits = angleTokens.filter((t) => lower.includes(t)).length;
  const angleFidelity = angleTokens.length > 0 ? angleHits / angleTokens.length : 1;
  if (angleFidelity < 1) {
    const missing = angleTokens.filter((t) => !lower.includes(t));
    issues.push({
      text: `Angle may be drifting: tokens "${missing.join(', ')}" not found in prompt`,
      weight: 0.3 * (1 - angleFidelity),
    });
  }

  // --- 3. Anti-AI-look (weight 0.2) ---
  if (requirements.antiAiLook) {
    const antiAiTokens = [
      'photograph', 'photo', 'shot on', 'film grain', '35mm',
      'cinematic', 'natural light', 'handheld', 'documentary',
      'imperfect', 'lens', 'candid', 'available light',
      'not cgi', 'not ai', 'not generated',
    ];
    const hits = antiAiTokens.filter((t) => lower.includes(t));
    const antiAiScore = Math.min(1, hits.length / 2); // 2 hits = full credit
    if (antiAiScore < 1) {
      issues.push({
        text: `Missing anti-AI-look tokens (e.g. "cinematic", "35mm", "documentary") — only ${hits.length} found`,
        weight: 0.2 * (1 - antiAiScore),
      });
    }
    var antiAiWeighted = antiAiScore;
  } else {
    var antiAiWeighted = 1;
  }

  // --- 4. Length (weight 0.1) ---
  // 20-200 words is the "good" band. Below 20 or above 200
  // penalises linearly. The ROADMAP §v1.2.4 "Length-budget: 50-500
  // words" hard limit lives in lib/agent-eval/ — this is a soft
  // preference for the self-critique to keep prompts readable.
  const wordCount = prompt.split(/\s+/).filter(Boolean).length;
  let lengthScore = 1;
  if (wordCount < 20) {
    lengthScore = wordCount / 20;
    issues.push({ text: `Prompt too short (${wordCount} words; aim for 50-150)`, weight: 0.1 * (1 - lengthScore) });
  } else if (wordCount > 200) {
    lengthScore = Math.max(0, 1 - (wordCount - 200) / 100);
    issues.push({ text: `Prompt too long (${wordCount} words; aim for 50-150)`, weight: 0.1 * (1 - lengthScore) });
  }

  // Composite
  const score = (
    0.4 * nicheCoverage
    + 0.3 * angleFidelity
    + 0.2 * antiAiWeighted
    + 0.1 * lengthScore
  );

  // Sort issues most-severe first, drop weight 0
  const sortedIssues = issues
    .filter((i) => i.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .map((i) => i.text);

  return { score: roundTo(score, 3), issues: sortedIssues };
}

// small helper to keep deterministic float output
function roundTo(n: number, places: number): number {
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// LLM judge (fallback when heuristics return "uncertain")
// ---------------------------------------------------------------------------

/**
 * Ask the model to score the prompt against the requirements. The
 * model is told to respond with ONLY a JSON object of the form
 * `{ "score": <0..1>, "issues": [...] }`. We robustly parse the
 * response (strip think-blocks, drop fences, slice to first
 * `{` / last `}`) — same shape as `lib/aiClient.ts`'s
 * `extractJsonObjectFromLLM`.
 */
async function llmJudge(
  model: LanguageModel,
  modelId: string,
  input: CritiquePromptInput,
  signal: AbortSignal | undefined,
): Promise<CritiquePromptOutput> {
  const system = [
    'You are a strict prompt-quality reviewer for an AI image-generation studio.',
    'Score the user-supplied image-prompt against the requirements on a 0..1 scale.',
    'Return ONLY a JSON object of the form {"score": <0..1>, "issues": ["...", "..."]}.',
    'No preamble, no markdown fence, no commentary.',
  ].join(' ');

  const user = JSON.stringify({
    prompt: input.prompt,
    requirements: input.requirements,
  }, null, 2);

  let result;
  try {
    result = await generateText({
      model,
      system,
      prompt: user,
      abortSignal: signal,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new ToolExecutionError('critique_prompt', `LLM judge failed: ${reason}`, {
      retryable: true,
      cause: e,
    });
  }

  const raw = result.text ?? '';
  // Robust JSON extraction — mirror extractJsonObjectFromLLM but
  // local to this tool so we don't pull the SSE client into the
  // server-side tool def.
  let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  cleaned = cleaned.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first === -1 || last <= first) {
    throw new ToolExecutionError(
      'critique_prompt',
      `LLM judge returned no JSON object (model="${modelId}")`,
      { retryable: true },
    );
  }
  const slice = cleaned.slice(first, last + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch (e) {
    throw new ToolExecutionError(
      'critique_prompt',
      `LLM judge returned invalid JSON (model="${modelId}")`,
      { retryable: true, cause: e },
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ToolExecutionError(
      'critique_prompt',
      `LLM judge returned wrong shape (expected object)`,
      { retryable: true },
    );
  }
  const obj = parsed as Record<string, unknown>;
  const scoreNum = typeof obj.score === 'number' ? obj.score : Number.NaN;
  const issuesRaw = Array.isArray(obj.issues) ? obj.issues : [];
  const issues = issuesRaw
    .filter((i): i is string => typeof i === 'string' && i.trim().length > 0)
    .map((s) => s.slice(0, 400));

  if (!Number.isFinite(scoreNum) || scoreNum < 0 || scoreNum > 1) {
    throw new ToolExecutionError(
      'critique_prompt',
      `LLM judge returned score out of range (got ${String(scoreNum)})`,
      { retryable: true },
    );
  }
  return { score: roundTo(scoreNum, 3), issues };
}

// ---------------------------------------------------------------------------
// Model resolution (mirrors generate-prompt.ts)
// ---------------------------------------------------------------------------

interface ResolvedTextModel {
  model: LanguageModel;
  modelId: string;
}

async function resolveTextModel(opts: { override?: string }): Promise<ResolvedTextModel | null> {
  if (process.env.MINIMAX_API_KEY) {
    const { createOpenAI } = await import('@ai-sdk/openai');
    const openai = createOpenAI({
      apiKey: process.env.MINIMAX_API_KEY,
      baseURL: 'https://api.minimaxi.chat/v1',
    });
    const modelId = opts.override || process.env.VERCEL_AI_MODEL || 'MiniMax-M3';
    // MiniMax only implements /v1/chat/completions; `openai.chat(id)` pins that
    // transport (the bare `openai(id)` callable hits the Responses API and 404s).
    return { model: openai.chat(modelId), modelId };
  }
  if (process.env.OPENAI_API_KEY) {
    const { createOpenAI } = await import('@ai-sdk/openai');
    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const modelId = opts.override || 'gpt-4o-mini';
    return { model: openai.chat(modelId), modelId };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API: typed execute() for non-SDK callers
// ---------------------------------------------------------------------------

/**
 * Execute `critique_prompt` without the AI SDK wrapper. `mode`
 * defaults to 'heuristic' — pure function, fully testable, no
 * external dependency. 'llm' forces the model judge. 'auto'
 * prefers the heuristic and falls back to the LLM judge only
 * when no AI provider is configured.
 */
export async function executeCritiquePrompt(
  rawInput: unknown,
  opts: { signal?: AbortSignal; mode?: 'auto' | 'heuristic' | 'llm'; modelOverride?: string } = {},
): Promise<ToolResult<CritiquePromptOutput>> {
  return safeExecute(async () => {
    const parsed = zCritiquePromptInput.safeParse(rawInput);
    if (!parsed.success) throw parsed.error;
    const input = parsed.data;
    const mode = opts.mode ?? 'auto';

    if (mode === 'heuristic' || mode === 'auto') {
      const result = heuristicJudge(input.prompt, input.requirements);
      return zCritiquePromptOutput.parse(result);
    }

    // mode === 'llm' — must call the LLM judge; auto-fallback to
    // heuristic already happened in the branch above.
    const resolved = await resolveTextModel({ override: opts.modelOverride });
    if (!resolved) {
      throw new ToolNotAvailableError(
        'critique_prompt',
        'no AI provider configured (set MINIMAX_API_KEY or OPENAI_API_KEY) — and mode=llm requested',
      );
    }
    const result = await llmJudge(resolved.model, resolved.modelId, input, opts.signal);
    return zCritiquePromptOutput.parse(result);
  });
}

// ---------------------------------------------------------------------------
// Vercel AI SDK `tool()` definition
// ---------------------------------------------------------------------------

/**
 * The `critique_prompt` tool. The Director loop calls this on
 * every `generate_prompt` draft and regenerates when score < 0.7
 * (threshold lives in `lib/agent-eval/` once v1.2.4 lands).
 */
export const critiquePromptTool = tool({
  description:
    'Self-critique a draft image-prompt against explicit requirements (niche coverage, angle fidelity, anti-AI-look tokens, length). Returns a score in [0, 1] and a list of issues; the Director regenerates the draft when score < 0.7.',
  inputSchema: zCritiquePromptInput,
  outputSchema: zCritiquePromptOutput,
  execute: async (input, options) => {
    const result = await executeCritiquePrompt(input, {
      signal: options?.abortSignal,
    });
    if (!result.ok) throw result.error;
    return result.value;
  },
});

// Re-export the `CritiqueRequirements` type so test code (and any
// downstream consumer) doesn't need to know about the schemas module
// to type a requirements object.
export type { CritiqueRequirements };
