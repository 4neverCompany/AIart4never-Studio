/**
 * v1.2 — Director Route 2.0 main loop.
 *
 * The "Director" pattern from ROADMAP §v1.2.2. Given a
 * brief (niches, genres, ideaConcept, skills) the loop
 * drives a single Vercel AI SDK `ToolLoopAgent` (v6.0.197+)
 * with the `AGENT_TOOLS` array plugged in and a
 * `stepCountIs(8)` hard cap. The SDK handles the multi-step
 * tool-use loop internally; we wrap it with:
 *
 *   - **step logging** — every `onStepFinish` event becomes
 *     one (or more) `Step` records in the run log, so the
 *     Replay UI can show "the model searched, drafted,
 *     critiqued, refined, finalized" without re-parsing the
 *     SDK's generic `StepResult` shape.
 *
 *   - **budget hard-stop** — accumulated cost is tracked
 *     per step using the SDK's `LanguageModelUsage` and a
 *     per-model pricing table. A custom `stopWhen` condition
 *     watches the running total and stops the loop the
 *     moment a step's cost would push it past the cap.
 *     The route tolerates a one-step overshoot (see the
 *     `makeBudgetStopCondition` comment) — a fully hard
 *     stop would require predicting the next step's cost,
 *     which the SDK doesn't expose.
 *
 *   - **persistence** — the run is written through
 *     `lib/agent-loop/persistence.ts` to idb-keyval on the
 *     client (or no-op'd on the server). The route can
 *     later fetch the log by `runId` to feed the Replay UI.
 *
 * v1.2.6 migration note: the previous v1.2.0 implementation
 * called `generateText({ tools: AGENT_TOOLS, stopWhen: ... })`
 * directly. v6.0.197 of the Vercel AI SDK ships the new
 * first-class `ToolLoopAgent` class (https://ai-sdk.dev/docs/
 * agents/building-agents) which is exactly the pattern we
 * hand-rolled. We now construct one agent per call (model
 * resolution is per-request, so the agent instance is too)
 * and call `agent.generate({ prompt, system, onStepFinish })`
 * on it. The behaviour is identical to the hand-rolled
 * version; the code is just declarative now.
 *
 * The function is the **only** exported entry point; every
 * other module in `lib/agent-loop/` is internal. Tests
 * import the function directly and mock the SDK's
 * `ToolLoopAgent.prototype.generate` to assert on the step
 * log. (Before v1.2.6 the tests mocked `generateText`
 * directly — the test suite was updated to mock the agent's
 * `.generate` method instead.)
 */
import {
  ToolLoopAgent,
  stepCountIs,
  type LanguageModel,
  type StopCondition,
  type Tool,
  type ToolSet,
} from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';

import { AGENT_TOOLS } from '@/lib/agent-tools';
import type { SkillRef } from '@/lib/agent-tools/schemas';
import { buildSkillSystemBlock } from '@/lib/skill-loader';
import { stripModelCommentary } from '@/lib/agent-tools/prompt-extract';

import { StepLogger, truncateForLog, type Step } from './log';
import { BudgetTracker, estimateStepCost } from './budget';
import {
  buildDirectorSystemPrompt,
  buildInitialPlanStep,
  buildUserPrompt,
  type PlanContext,
} from './plan';
import { saveRun, type AgentRun, type TruncatedBy } from './persistence';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunDirectorLoopInput {
  /** 1-6 user content pillars. Forwarded to every tool that needs them. */
  niches: string[];
  /** 0-10 style tags. */
  genres: string[];
  /** The crossover concept to realise. Becomes the `angle` for generate_prompt. */
  ideaConcept: string;
  /** Optional: list of active skills to fold into the prompt template. */
  skillContext?: SkillRef[];
  /** Storage partition key. Required for `persistence.listRunsForUser`. */
  userId: string;
  /** Optional: model id override (e.g. 'MiniMax-M3'). Falls back to env-driven default. */
  modelId?: string;
  /** Optional: hard step cap. Default 8 (matches ROADMAP §v1.2.2). */
  maxSteps?: number;
  /** Optional: USD cap for this run. Default $0.50 (configurable per request). */
  budgetUsd?: number;
  /** Optional: abort signal forwarded to the SDK and the model. */
  signal?: AbortSignal;
  /** Optional: per-step callback. Useful for streaming the log to the client. */
  onStep?: (step: Step) => void;
  /**
   * Test hook. Pass a pre-resolved `LanguageModel` to bypass env-var
   * resolution. Production callers should leave this unset.
   *
   * Wrapped in an object so the test can also pin the
   * `modelId` string (the AI SDK's `LanguageModel` is a
   * union that includes string-literal provider ids, so
   * reading `modelId` off the value directly triggers a
   * TS error).
   *
   * @internal
   */
  _modelOverride?: { model: LanguageModel; modelId: string };
  /**
   * Test hook. Pass a tool set (e.g. one where execute() is mocked) to
   * exercise the loop without hitting real providers.
   *
   * @internal
   */
  _toolsOverride?: ToolSet;
  /**
   * Test hook. Pin a deterministic run id (e.g. 'run_test_001').
   *
   * @internal
   */
  _runIdOverride?: string;
  /**
   * Test hook. Pin a deterministic clock (epoch ms) so log
   * timestamps are reproducible across runs.
   *
   * @internal
   */
  _clockOverride?: () => number;
}

export interface RunDirectorLoopResult {
  /** Stable id for the run, written through `lib/agent-loop/persistence`. */
  runId: string;
  /** The final prompt draft. Empty string when the loop errored before producing one. */
  finalPrompt: string;
  /** Chronological log of every step. The first entry is always the `plan` step. */
  steps: readonly Step[];
  /** Sum of `step.cost` across the log. */
  totalCost: number;
  /** Why the loop stopped. */
  truncatedBy: TruncatedBy;
  /** The model id that was used. */
  modelId: string;
  /** The model provider that was used. */
  provider: 'minimax' | 'openai' | 'mock' | 'unknown';
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_STEPS = 8;
/**
 * Default per-request budget. Hard-coded to $0.50 — the
 * ROADMAP §v1.2.2 number. Overridable per-call via
 * `input.budgetUsd` and (eventually) per-user via the
 * Director settings UI.
 */
const DEFAULT_BUDGET_USD = 0.5;

// ---------------------------------------------------------------------------
// Input validation — keep this here, not in a Zod schema, because the
// route already validates the request body and we want the loop to
// throw clearly-typed errors when called directly (e.g. from tests).
// ---------------------------------------------------------------------------

const PlanContextInputSchema = z.object({
  niches: z.array(z.string().min(1).max(80)).min(1).max(6),
  genres: z.array(z.string().min(1).max(80)).max(10),
  ideaConcept: z.string().min(3).max(400),
  skillContext: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        version: z.string().max(20).optional(),
      }),
    )
    .max(20)
    .optional(),
  userId: z.string().min(1).max(120),
  modelId: z.string().min(1).max(120).optional(),
  maxSteps: z.number().int().min(1).max(32).optional(),
  budgetUsd: z.number().positive().max(100).optional(),
});

function validateInput(input: RunDirectorLoopInput): void {
  const result = PlanContextInputSchema.safeParse({
    niches: input.niches,
    genres: input.genres,
    ideaConcept: input.ideaConcept,
    skillContext: input.skillContext,
    userId: input.userId,
    modelId: input.modelId,
    maxSteps: input.maxSteps,
    budgetUsd: input.budgetUsd,
  });
  if (!result.success) {
    const msg = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`runDirectorLoop: invalid input — ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

interface ResolvedModel {
  model: LanguageModel;
  modelId: string;
  provider: 'minimax' | 'openai' | 'mock' | 'unknown';
}

/**
 * Pick a Vercel AI SDK `LanguageModel` from env vars + an
 * optional per-request model id. Same precedence as the
 * route handler (MINIMAX_API_KEY wins over OPENAI_API_KEY)
 * so the Director loop and the streaming route pick the
 * same model when no override is given.
 *
 * Returns `null` when no API key is configured. The caller
 * turns that into a 503-style `RunDirectorLoopResult` with
 * `truncatedBy: 'error'` rather than a hard throw — the
 * route layer can detect the `provider: 'unknown'` and
 * respond with a clear "no provider configured" error.
 */
export async function resolveDirectorModel(
  modelOverride: string | undefined,
): Promise<ResolvedModel | null> {
  if (modelOverride === 'mock') {
    return { modelId: 'mock', provider: 'mock', model: makeMockLanguageModel() };
  }

  if (process.env.MINIMAX_API_KEY) {
    const openai = createOpenAI({
      apiKey: process.env.MINIMAX_API_KEY,
      baseURL: 'https://api.minimaxi.chat/v1',
    });
    const modelId = modelOverride || process.env.VERCEL_AI_MODEL || 'MiniMax-M3';
    // V1.5-DIRECTOR-MINIMAX-TOOLCALL: use `.chat()` (chat completions),
    // NOT the default callable. The @ai-sdk/openai v6 default callable
    // targets the OpenAI Responses API (/v1/responses), which MiniMax
    // does NOT implement — so `openai(modelId)` 404s on the very first
    // model call and the ToolLoopAgent never executes a single tool
    // (this was the root cause of "the AI can't tool-call"). MiniMax
    // implements /v1/chat/completions WITH function/tool-calling
    // (MiniMax-M3 supports tools/tool_choice), which is exactly what
    // `.chat(modelId)` targets. The streaming route's hand-rolled
    // streamMinimaxChat hits the same endpoint but passes no tools;
    // here we keep the SDK so the agent loop gets real tool-calling.
    return { model: openai.chat(modelId), modelId, provider: 'minimax' };
  }
  if (process.env.OPENAI_API_KEY) {
    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const modelId = modelOverride || 'gpt-4o-mini';
    // OpenAI also goes through chat completions for consistent
    // tool-calling behaviour across both providers.
    return { model: openai.chat(modelId), modelId, provider: 'openai' };
  }
  return null;
}

/**
 * A trivial `LanguageModel` that never gets called. We
 * construct it for the `'mock'` provider case so the test
 * suite can validate the loop without touching the
 * network. The real mock work happens at the `generateText`
 * level — the test suite monkey-patches the SDK's
 * `generateText` directly via `_modelOverride` and
 * `_toolsOverride`.
 */
function makeMockLanguageModel(): LanguageModel {
  // The route never actually invokes a mock model — when
  // tests pass `_modelOverride`, the SDK's mocked
  // `generateText` returns the canned result before any
  // model call happens. So we can return a sentinel
  // object; the AI SDK's call to `doGenerate` on it
  // would throw, which is the right behaviour for a
  // misconfigured test.
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock',
    defaultObjectGenerationMode: undefined,
    doGenerate: () => {
      throw new Error('mock language model called outside of test scope');
    },
    doStream: () => {
      throw new Error('mock language model called outside of test scope');
    },
  } as unknown as LanguageModel;
}

// ---------------------------------------------------------------------------
// The custom budget stop condition
// ---------------------------------------------------------------------------

/**
 * Build a `StopCondition` that returns `true` when the
 * accumulated cost recorded on the `BudgetTracker` has
 * reached the cap. The closure is the bridge between the
 * SDK's per-step event (`onStepFinish` mutates the
 * tracker) and the SDK's per-loop check (`stopWhen`
 * reads the total).
 *
 * Note on overshoot: `stopWhen` is checked BEFORE the next
 * step, not DURING the current one. So the loop can
 * overshoot the cap by one step's cost. With a $0.50
 * default cap and an average step cost of ~$0.05, the
 * realistic overshoot is < $0.10. A truly hard cap would
 * need to estimate the next step's cost (impossible
 * without invoking it) or to use `stopWhen` to abort
 * mid-step, which the SDK doesn't support. We document
 * this in `RunDirectorLoopResult.truncatedBy` so the
 * caller can spot the case.
 */
function makeBudgetStopCondition(
  budget: BudgetTracker,
): StopCondition<ToolSet> {
  return () => budget.total >= budget.limit;
}

// ---------------------------------------------------------------------------
// Step extraction
// ---------------------------------------------------------------------------

/**
 * Pull the final prompt text out of the SDK's `GenerateTextResult`.
 *
 * V1.7.0-DIRECTOR-PROMPT-FIX: the LAST `generate_prompt` tool draft is
 * now the canonical source — NOT `result.text`. The draft is the clean,
 * <think>-stripped, length-validated prompt that critique scored and the
 * loop approved. `result.text` is the model's terminal *commentary*,
 * which in practice is a whole report: a `<think>` block, an iteration
 * log, "Final prompt (copy-paste ready):", "Niches anchored", and a
 * "Ready to feed to generate_image — just say the word" sign-off. Feeding
 * THAT to the image model (the old precedence) dumped the entire report
 * into the prompt. We only fall back to a sanitized `result.text` when
 * the model never produced a draft (text-only response).
 */
function extractFinalPrompt(args: {
  resultText: string;
  stepResults: ReadonlyArray<{
    toolResults: ReadonlyArray<{ toolName: string; output: unknown }>;
  }>;
}): string {
  // 1. Canonical: the most recent `generate_prompt` tool draft.
  for (let i = args.stepResults.length - 1; i >= 0; i--) {
    const tr = args.stepResults[i]?.toolResults ?? [];
    for (const r of tr) {
      if (r.toolName !== 'generate_prompt') continue;
      const out = r.output as { draft?: unknown } | null | undefined;
      if (out && typeof out.draft === 'string' && out.draft.trim().length > 0) {
        return out.draft.trim();
      }
    }
  }
  // 2. Fallback: a text-only response. Strip the <think> reasoning so a
  //    reasoning model's chain-of-thought never reaches the image model.
  return stripDirectorReasoning(args.resultText ?? '');
}

/**
 * Strip `<think>…</think>` reasoning (terminated or truncated-leading)
 * AND the model's own commentary around the draft (V1.7.0-PRE-PROD-FIX)
 * from a Director text response. Mirrors `cleanModelOutput` in
 * `generate-prompt.ts`; the commentary-stripping is delegated to
 * `lib/agent-tools/prompt-extract.ts` so the two callers stay in
 * lock-step.
 */
function stripDirectorReasoning(raw: string): string {
  let out = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const openIdx = out.indexOf('<think>');
  if (openIdx !== -1 && !out.slice(openIdx).includes('</think>')) {
    out = out.slice(0, openIdx).trim();
  }
  // V1.7.0-PRE-PROD-FIX: without this, the model output's commentary
  // ("Let me build a final draft…", "Niches anchored. Ready to feed
  // to generate_image…") leaked into the image prompt verbatim.
  return stripModelCommentary(out);
}

// ---------------------------------------------------------------------------
// runDirectorLoop
// ---------------------------------------------------------------------------

/**
 * Execute the Director loop. Returns a
 * `RunDirectorLoopResult` with the final prompt, the
 * chronological step log, the total cost, and the
 * truncation reason. The function does NOT throw for
 * provider or budget issues — those are folded into
 * `truncatedBy: 'error' | 'budget'` and the route can
 * decide whether to surface a 4xx/5xx.
 *
 * The only throws are programmer errors: invalid input
 * shape, unrecognised provider, or a budget limit <= 0
 * (the `BudgetTracker` constructor throws on its own).
 */
export async function runDirectorLoop(
  input: RunDirectorLoopInput,
): Promise<RunDirectorLoopResult> {
  validateInput(input);

  const clock = input._clockOverride ?? (() => Date.now());
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
  const budgetLimit = input.budgetUsd ?? DEFAULT_BUDGET_USD;
  const logger = new StepLogger({ clock });
  const budget = new BudgetTracker(budgetLimit);
  const runId = input._runIdOverride ?? makeRunId(clock);

  // v1.2.3 HIL: set the run context BEFORE any tool call so
  // `generate_image` / `generate_video` can read it. Cleared
  // in the `finally` so a thrown tool error doesn't leave
  // stale state in the module-scope slot for the NEXT run.
  const { enterRunContext, exitRunContext, addToTotalCost } = await import('./run-context');
  enterRunContext({
    runId,
    stepCounter: 0,
    totalCostUsd: 0,
    budgetUsd: budgetLimit,
  });

  // -----------------------------------------------------------------------
  // 1. Resolve the model. If no provider is configured, return an
  //    `error` result so the route can map it to a 503.
  // -----------------------------------------------------------------------
  let resolved: ResolvedModel | null;
  if (input._modelOverride) {
    resolved = {
      model: input._modelOverride.model,
      modelId: input._modelOverride.modelId,
      provider: 'unknown',
    };
  } else {
    resolved = await resolveDirectorModel(input.modelId);
  }
  if (!resolved) {
    const errStep: Step = logger.append({
      type: 'error',
      reasoning:
        'No AI provider configured for the Director loop. Set MINIMAX_API_KEY (preferred) or OPENAI_API_KEY.',
      cost: 0,
      timestamp: clock(),
    });
    input.onStep?.(errStep);
    // v1.2.3 HIL: early-return path doesn't hit the
    // outer try/finally, so clear the run context here.
    exitRunContext();
    return {
      runId,
      finalPrompt: '',
      steps: logger.getAll(),
      totalCost: 0,
      truncatedBy: 'error',
      modelId: '',
      provider: 'unknown',
    };
  }

  // -----------------------------------------------------------------------
  // 2. Plan step — recorded BEFORE the model runs so the Replay UI
  //    has the rationale on frame 1.
  // -----------------------------------------------------------------------
  const planStep: Step = logger.append({
    ...buildInitialPlanStep(
      {
        niches: input.niches,
        genres: input.genres,
        ideaConcept: input.ideaConcept,
        skillContext: input.skillContext ?? [],
      },
      { clock },
    ),
  });
  input.onStep?.(planStep);

  // -----------------------------------------------------------------------
  // 3. Build the system + user prompts.
  // -----------------------------------------------------------------------
  const planContext: PlanContext = {
    niches: input.niches,
    genres: input.genres,
    ideaConcept: input.ideaConcept,
    skillContext: input.skillContext ?? [],
  };
  const baseSystem = buildDirectorSystemPrompt(planContext);
  // Skill block is appended to the system stack (mirrors the
  // existing route's behaviour).
  const skillNames = (input.skillContext ?? []).map((s) => s.name);
  const skillBlock = await buildSkillSystemBlock(skillNames);
  const system = [baseSystem, skillBlock].filter(Boolean).join('\n\n') || undefined;
  const userPrompt = buildUserPrompt(planContext);

  // -----------------------------------------------------------------------
  // 4. Run the SDK loop. We capture `onStepFinish` events into
  //    the logger; the budget stop condition is wired into
  //    `stopWhen` alongside `stepCountIs(maxSteps)`.
  //
  //    v1.2.6: wrap the v6 `ToolLoopAgent` class. The agent is
  //    a thin container for `model` + `tools` + `stopWhen` +
  //    `instructions` — everything we configured per-call. The
  //    `generate()` call below accepts the per-step overrides
  //    (`system`, `prompt`, `onStepFinish`, `abortSignal`).
  // -----------------------------------------------------------------------
  let truncatedBy: TruncatedBy = 'natural';
  const stepResults: Array<{
    stepNumber: number;
    text: string;
    toolCalls: ReadonlyArray<{ toolName: string; input: unknown }>;
    toolResults: ReadonlyArray<{ toolName: string; input: unknown; output: unknown }>;
    usage: { inputTokens?: number; outputTokens?: number } | undefined;
    finishReason: string;
  }> = [];

  const start = clock();
  try {
    // Construct a fresh ToolLoopAgent per call. Model resolution
    // is per-request (different modelId, different model
    // object), so the agent instance has to be per-call too.
    // For the tools array, we accept the test override (mock
    // tools) or the full AGENT_TOOLS barrel.
    const directorAgent = new ToolLoopAgent({
      model: resolved.model,
      tools: (input._toolsOverride ?? AGENT_TOOLS) as unknown as ToolSet,
      stopWhen: [stepCountIs(maxSteps), makeBudgetStopCondition(budget)],
    });

    const result = await directorAgent.generate({
      ...(system ? { system } : {}),
      prompt: userPrompt,
      ...(input.signal ? { abortSignal: input.signal } : {}),
      onStepFinish: async (stepResult) => {
        // Push the raw step into our local accumulator for
        // the final `extractFinalPrompt` pass.
        stepResults.push({
          stepNumber: stepResult.stepNumber,
          text: stepResult.text,
          toolCalls: stepResult.toolCalls.map((c) => ({
            toolName: c.toolName,
            input: c.input,
          })),
          toolResults: stepResult.toolResults.map((r) => ({
            toolName: r.toolName,
            input: r.input,
            output: r.output,
          })),
          usage: {
            ...(typeof stepResult.usage?.inputTokens === 'number'
              ? { inputTokens: stepResult.usage.inputTokens }
              : {}),
            ...(typeof stepResult.usage?.outputTokens === 'number'
              ? { outputTokens: stepResult.usage.outputTokens }
              : {}),
          },
          finishReason: String(stepResult.finishReason),
        });

        // Log the LLM step (one record per LLM call). If
        // the model emitted a tool call, the step is
        // `tool_call`; if the model emitted pure text, it
        // is `final`; otherwise it's a free-form
        // `error`-shaped step.
        const stepCost = estimateStepCost(stepResult.usage, resolved.modelId);
        const stepType: Step['type'] = stepResult.toolCalls.length > 0
          ? 'tool_call'
          : (stepResult.text && stepResult.text.trim().length > 0 ? 'final' : 'error');

        const llmStep = logger.append({
          type: stepType,
          ...(stepResult.toolCalls[0]?.toolName
            ? { tool: stepResult.toolCalls[0].toolName }
            : {}),
          ...(stepResult.toolCalls[0]?.input !== undefined
            ? { input: truncateForLog(stepResult.toolCalls[0].input) }
            : {}),
          ...(stepResult.text && stepResult.text.trim().length > 0
            ? { reasoning: stepResult.text.trim().slice(0, 1000) }
            : {}),
          cost: stepCost,
          timestamp: clock(),
        });
        input.onStep?.(llmStep);

        // Log every tool result as a separate `tool_result` step
        // so the Replay UI can render "model called X, tool
        // returned Y" on consecutive frames. The cost is 0 for
        // results — the LLM call already paid for them.
        for (const tr of stepResult.toolResults) {
          const resultStep = logger.append({
            type: 'tool_result',
            tool: tr.toolName,
            input: truncateForLog(tr.input),
            output: truncateForLog(tr.output),
            cost: 0,
            timestamp: clock(),
          });
          input.onStep?.(resultStep);
        }

        // Record this step's cost on the budget. Throws
        // BudgetExceededError when the cap is hit — the
        // SDK propagates the throw to our outer try/catch.
        budget.record(stepCost);
        // v1.2.3 HIL: mirror the running cost into the
        // run-context so a tool's HIL guard can compute
        // "projected total after this call" without
        // reaching back into the budget tracker.
        addToTotalCost(stepCost);
      },
    });

    // The SDK's `result.steps` is the canonical record. Use
    // it as a tie-breaker when our accumulator (which only
    // sees the onStepFinish snapshots) disagrees.
    const finalPrompt = extractFinalPrompt({
      resultText: result.text,
      stepResults: result.steps as unknown as Array<{
        toolResults: ReadonlyArray<{ toolName: string; output: unknown }>;
      }>,
    });

    return finalizeResult({
      runId,
      logger,
      budget,
      finalPrompt,
      truncatedBy: detectTruncation(result.finishReason, maxSteps, budget),
      modelId: resolved.modelId,
      provider: resolved.provider,
      userId: input.userId,
      niches: input.niches,
      genres: input.genres,
      ideaConcept: input.ideaConcept,
      stepLimit: maxSteps,
      start,
      finish: clock(),
    });
  } catch (e: unknown) {
    // The SDK wraps most provider errors. We branch on the
    // budget error to set the right `truncatedBy`; every
    // other error is `error`.
    if (e instanceof Error && e.name === 'BudgetExceededError') {
      truncatedBy = 'budget';
    } else if (e instanceof Error && e.name === 'AbortError') {
      truncatedBy = 'error';
    } else if (e instanceof Error) {
      truncatedBy = 'error';
    } else {
      truncatedBy = 'error';
    }
    const errStep = logger.append({
      type: 'error',
      reasoning: e instanceof Error ? e.message : String(e),
      cost: 0,
      timestamp: clock(),
    });
    input.onStep?.(errStep);

    const finalPrompt = extractFinalPrompt({
      resultText: '',
      stepResults: stepResults.map((s) => ({
        toolResults: s.toolResults,
      })),
    });

    return finalizeResult({
      runId,
      logger,
      budget,
      finalPrompt,
      truncatedBy,
      modelId: resolved.modelId,
      provider: resolved.provider,
      userId: input.userId,
      niches: input.niches,
      genres: input.genres,
      ideaConcept: input.ideaConcept,
      stepLimit: maxSteps,
      start,
      finish: clock(),
    });
  } finally {
    // v1.2.3 HIL: clear the run context so the next call to
    // `runDirectorLoop` doesn't see this run's leftover
    // runId / cost. Order matters: clear BEFORE returning
    // so the route layer's response object is the LAST
    // thing the caller sees.
    exitRunContext();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine the truncation reason from the SDK's
 * `finishReason` and the budget state. The model returns
 * `stop` when the loop completed naturally,
 * `length` / `content-filter` when the provider cut it
 * off, and `tool-calls` (or similar) when it ran a tool.
 * The SDK's `stopWhen` is the one that ultimately decides
 * whether the loop is done — when the model returns
 * `stop` AND we hit `stepCountIs`, we report
 * `step_limit`.
 */
function detectTruncation(
  finishReason: string | undefined,
  maxSteps: number,
  budget: BudgetTracker,
): TruncatedBy {
  if (budget.total >= budget.limit) return 'budget';
  if (finishReason === 'length' || finishReason === 'content-filter') return 'error';
  // The SDK exposes the number of steps via the result
  // (we have it as `result.steps.length`) but the
  // function-scope `truncatedBy` default is `natural`
  // — the caller can override by inspecting the
  // step-count against `maxSteps`.
  void maxSteps;
  return 'natural';
}

function makeRunId(clock: () => number): string {
  // Two sources of uniqueness: the wall clock (the route
  // can pin this in tests) and a 6-char base36 random
  // suffix (collision-free for a single user across
  // generations).
  const ts = clock().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `run_${ts}_${rand}`;
}

/**
 * Persist + freeze the result into a `RunDirectorLoopResult`.
 * Centralises the persistence side-effect so the happy
 * path and the catch block produce the same shape.
 */
async function finalizeResult(args: {
  runId: string;
  logger: StepLogger;
  budget: BudgetTracker;
  finalPrompt: string;
  truncatedBy: TruncatedBy;
  modelId: string;
  provider: RunDirectorLoopResult['provider'];
  userId: string;
  niches: string[];
  genres: string[];
  ideaConcept: string;
  stepLimit: number;
  start: number;
  finish: number;
}): Promise<RunDirectorLoopResult> {
  const result: RunDirectorLoopResult = {
    runId: args.runId,
    finalPrompt: args.finalPrompt,
    steps: args.logger.getAll(),
    totalCost: args.budget.total,
    truncatedBy: args.truncatedBy,
    modelId: args.modelId,
    provider: args.provider,
  };
  // Best-effort persistence. On the server, `saveRun`
  // no-ops, so this is a fast no-op. On the client, the
  // run lands in idb-keyval for the Replay UI to fetch.
  try {
    const run: AgentRun = {
      runId: args.runId,
      userId: args.userId,
      startedAt: args.start,
      finishedAt: args.finish,
      niches: args.niches,
      genres: args.genres,
      ideaConcept: args.ideaConcept,
      steps: args.logger.getAll(),
      totalCost: args.budget.total,
      truncatedBy: args.truncatedBy,
      modelId: args.modelId,
      ...(args.finalPrompt ? { finalPrompt: args.finalPrompt } : {}),
    };
    await saveRun(run);
  } catch {
    // Persistence failures are non-fatal; the route
    // already has the result in memory and can stream it
    // back to the client.
  }
  return result;
}

// ---------------------------------------------------------------------------
// Re-exports — the test suite imports the building blocks too
// ---------------------------------------------------------------------------

export type { Step, StepType } from './log';
export { StepLogger, truncateForLog } from './log';
export {
  BudgetTracker,
  BudgetExceededError,
  estimateStepCost,
  getPricing,
  DEFAULT_PRICING,
  MODEL_PRICING,
} from './budget';
export {
  buildDirectorPlan,
  buildDirectorSystemPrompt,
  buildUserPrompt,
  buildInitialPlanStep,
} from './plan';
export type { PlanContext } from './plan';
export {
  saveRun,
  loadRun,
  listRunsForUser,
  updateRun,
  deleteRun,
  listAllRuns,
  runKey,
  userIndexKey,
} from './persistence';
export type { AgentRun, TruncatedBy } from './persistence';
