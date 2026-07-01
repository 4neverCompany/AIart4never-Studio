/**
 * AGENTIC-HARNESS — `runAgent`: the clean conversational agent core.
 *
 * This replaces the inherited single-shot `runDirectorLoop` (a
 * prompt-generator dressed as a chat) with a REAL multi-turn agent harness in
 * the spirit of Claude Code: messages-in, open-ended tool use, no artificial
 * caps. The model drives a token-level `streamText` turn; it stops NATURALLY
 * when it ends a turn with text and no tool call (finishReason `stop`). There
 * is NO `stepCountIs(8)` workflow cap — only a generous `stepCountIs(256)`
 * runaway safety net and a SOFT, visible budget meter (it records cost per
 * step and emits a marker, but NEVER throws mid-step).
 *
 * What is reused UNCHANGED from the old loop (so behaviour + identity are
 * byte-for-byte the same, just rebuilt per-request):
 *   - the system-prompt assembly: AGENT.md (cached, `loadAgentInstructions`) +
 *     `buildCanonSystemBlock` + `buildCharacterLockBlock` (via
 *     `buildDirectorChatSystemPrompt`) + the optional skill block
 *     (`buildSkillSystemBlock`) — the IDENTICAL stack the chat path built;
 *   - the MiniMax model seam: `resolveDirectorModel` returns
 *     `createOpenAI(...).chat(modelId)`. The OpenAI Responses API
 *     (`openai(modelId)`) 404s for tools on MiniMax — ONLY `.chat()` supports
 *     tool-calling, so we feed `streamText` that exact object;
 *   - the run context (`enterRunContext` / `exitRunContext`) so the HIL-gated
 *     `generate_image` / `generate_video` tools can read the run id, budget,
 *     character, and the client-threaded Higgsfield connector;
 *   - the budget tracker + `estimateStepCost` — but as a SOFT meter (we call
 *     `recordSoft`, which never throws).
 *
 * The function exposes the raw `streamText` `fullStream` plus telemetry
 * accessors; the route's `handleAgentStream` adapter maps the parts to the SSE
 * event shapes `AgentConsole` already consumes. History compaction /
 * sliding-window for very long conversations is a deliberate FOLLOW-UP — not
 * built here.
 */
import {
  streamText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type TextStreamPart,
} from 'ai';

import { AGENT_TOOLS_MAP } from '@/lib/agent-tools';
import type { SkillRef } from '@/lib/agent-tools/schemas';
import { buildSkillSystemBlock } from '@/lib/skill-loader';
import type { CharacterId } from '@/lib/canon';
import type { McpServerConfig } from '@/lib/mcp';

import { BudgetTracker, estimateStepCost } from '@/lib/agent-loop/budget';
import { buildDirectorChatSystemPrompt, type PlanContext } from '@/lib/agent-loop/plan';
import { loadAgentInstructions } from '@/lib/agent-loop/agent-md';
import { resolveDirectorModel, type RunDirectorLoopResult } from '@/lib/agent-loop';
import { resolveTextModel } from '@/lib/text-model-catalog';
import { compactMessages } from './compact';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Why a `runAgent` turn ended. A rich, human-readable stop reason. */
export type AgentStopReason =
  | 'natural' // model ended its turn with text + no tool call (task done)
  | 'safety_max_steps' // the stepCountIs(256) runaway net fired
  | 'wall_clock' // the server-side wall-clock guard tripped
  | 'aborted' // the caller's AbortSignal fired
  | 'error'; // the model / a tool threw

export interface RunAgentInput {
  /**
   * THE input: the conversation so far, as Vercel AI SDK `ModelMessage[]`. The
   * agent reads this directly — there is NO ideaConcept / niches / genres
   * brief. The last message is typically the operator's new turn.
   */
  messages: ModelMessage[];
  /**
   * The active Master4never canon character whose persona + locked look + hard
   * rules + Element anchor shape the system prompt. Defaults to 'kael'.
   */
  characterId?: CharacterId;
  /**
   * Optional active skills folded into the system stack (uncapped — no
   * artificial limit). Mirrors the old chat path's skill block.
   */
  skillContext?: SkillRef[];
  /**
   * The operator's resolved, enabled+trusted Higgsfield MCP connector. The
   * chat CLIENT supplies it (the registry is client-side); threaded into the
   * RunContext so `generate_image` can submit through Higgsfield. Omitted →
   * the tool errors with a clear "No Higgsfield connector configured" message.
   */
  higgsfieldConnector?: McpServerConfig;
  /** Storage partition key for telemetry / audit. */
  userId: string;
  /** Optional model id override (e.g. 'MiniMax-M3'). Falls back to env default. */
  modelId?: string;
  /**
   * SOFT budget meter (USD). Visible, NOT a hard kill: cost is recorded per
   * step and, when crossed, a budget marker is emitted and the CURRENT turn is
   * allowed to finish. NEVER throws mid-step. Omitted → the meter just totals.
   */
  softBudgetUsd?: number;
  /**
   * Runaway guard: the generous `stepCountIs` safety net. Default 256. This is
   * NOT a workflow cap — the agent normally stops naturally well before it.
   */
  safetyMaxSteps?: number;
  /** Abort signal forwarded to the SDK and the model. */
  signal?: AbortSignal;
  /** Optional per-chunk callback (telemetry / logging). Best-effort. */
  onChunk?: (part: TextStreamPart<ToolSet>) => void;

  /** @internal Test seam: pre-resolved model, bypassing env resolution. */
  _modelOverride?: { model: LanguageModel; modelId: string };
  /** @internal Test seam: a tool set with mocked execute(). */
  _toolsOverride?: ToolSet;
  /** @internal Test seam: deterministic run id. */
  _runIdOverride?: string;
  /** @internal Test seam: deterministic clock (epoch ms). */
  _clockOverride?: () => number;
  /** @internal Test seam: deterministic token estimator for history compaction. */
  _tokenCounterOverride?: (text: string) => number;
}

/**
 * The live handle a `runAgent` call returns. `stream` is the raw `streamText`
 * `fullStream` (the route adapter maps its parts to SSE); the accessors expose
 * the run telemetry the terminal `done` event needs.
 */
export interface RunAgentHandle {
  /** Stable id for this run. */
  runId: string;
  /** The resolved model id. */
  modelId: string;
  /** The resolved provider. */
  provider: RunDirectorLoopResult['provider'];
  /** The full token-level part stream from `streamText`. */
  stream: AsyncIterable<TextStreamPart<ToolSet>>;
  /** Current accumulated cost (USD). Read AFTER the stream drains. */
  cost(): number;
  /** Whether the soft budget has been crossed. Read AFTER the stream drains. */
  budgetCrossed(): boolean;
  /** Accumulated token usage. Read AFTER the stream drains. */
  tokensUsed(): { input: number; output: number };
  /** Tear down the run context. The adapter MUST call this when the stream ends. */
  dispose(): void;
}

/**
 * The system-prompt assembly is built when no model can be resolved, so the
 * adapter can still surface a clear "no provider" error. Distinct from a
 * live handle.
 */
export interface RunAgentNoProvider {
  runId: string;
  provider: 'unknown';
  noProvider: true;
}

export type RunAgentResult = RunAgentHandle | RunAgentNoProvider;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * The runaway safety net. Generous on purpose — a real agent task can take
 * many tool round-trips. This is NOT a workflow cap; the agent stops naturally
 * (finishReason `stop`) long before it in the common case.
 */
const DEFAULT_SAFETY_MAX_STEPS = 256;

// ---------------------------------------------------------------------------
// System-prompt assembly — IDENTICAL content to the old chat path, per-request
// ---------------------------------------------------------------------------

/**
 * Build the agent's whole system prompt. This is the SAME assembly the old
 * `buildDirectorChatSystemPrompt` produced — AGENT.md + the structured canon
 * block + the character/Element identity lock — plus the optional skill block
 * appended exactly the way the chat path did (`[base, skill].join('\n\n')`).
 *
 * Kept byte-for-byte so the agent identity / persona / canon framing never
 * drifts; we just build it per-request from a `characterId` + the cached
 * AGENT.md text instead of from a brief.
 */
export async function buildSystem(
  characterId: CharacterId,
  agentInstructions: string,
  skillContext?: SkillRef[],
): Promise<string> {
  // The PlanContext fields the chat builder reads are only `characterId`
  // (niches/genres/ideaConcept are unused by the chat assembly); we feed empty
  // placeholders so the shared builder stays untouched.
  const planContext: PlanContext = {
    niches: [],
    genres: [],
    ideaConcept: '',
    characterId,
  };
  const baseSystem = buildDirectorChatSystemPrompt(planContext, agentInstructions);
  const skillNames = (skillContext ?? []).map((s) => s.name);
  const skillBlock = await buildSkillSystemBlock(skillNames);
  return [baseSystem, skillBlock].filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------------------
// Stateful think-stripping transform
// ---------------------------------------------------------------------------

/**
 * Build a STATEFUL streaming transform that strips `<think>…</think>`
 * chain-of-thought across `text-delta` parts. A naive per-delta regex leaks
 * partial tags (the model can split `<thi` | `nk>` across two deltas, or open
 * a block in one delta and close it three deltas later), so we carry the
 * in/out-of-think state and a small pending buffer between deltas.
 *
 * Non-`text-delta` parts (tool calls, results, finish, error, reasoning-*) are
 * passed through untouched — only the visible assistant text is cleaned.
 *
 * Algorithm (per text-delta, appending to a carry buffer):
 *   - while inside a think block, drop everything up to and including the next
 *     `</think>`; if no close yet, keep buffering and emit nothing;
 *   - while outside, emit everything up to the next `<think>`; on an open tag
 *     flip to inside and drop the tag;
 *   - a trailing partial that could be the START of a tag (`<`, `<t`, …
 *     `<think`, or `</`, … `</think`) is held back in the buffer so the next
 *     delta can complete it — it is NEVER emitted as visible text.
 */
export function makeThinkStripTransform(): () => TransformStream<
  TextStreamPart<ToolSet>,
  TextStreamPart<ToolSet>
> {
  return () => {
    let inThink = false;
    let carry = '';

    const OPEN = '<think>';
    const CLOSE = '</think>';

    /**
     * Could `s` be a strict, non-empty prefix of `tag` (so we must hold it
     * back until the next delta completes or refutes it)?
     */
    const isPartialPrefix = (s: string, tag: string): boolean =>
      s.length > 0 && s.length < tag.length && tag.startsWith(s);

    /** Process the carry buffer, returning the visible text to emit now. */
    const drain = (flush: boolean): string => {
      let out = '';
      // Loop until we can make no further definite progress.
      for (;;) {
        if (inThink) {
          const closeIdx = carry.indexOf(CLOSE);
          if (closeIdx === -1) {
            // No close yet. On flush, the block was never terminated — drop
            // the rest. Otherwise keep buffering (emit nothing).
            if (flush) carry = '';
            break;
          }
          // Drop through the close tag, then continue outside.
          carry = carry.slice(closeIdx + CLOSE.length);
          inThink = false;
          continue;
        }
        // Outside a think block.
        const openIdx = carry.indexOf(OPEN);
        if (openIdx === -1) {
          // No full open tag. Emit everything EXCEPT a trailing partial that
          // could become an open tag on the next delta.
          if (flush) {
            out += carry;
            carry = '';
            break;
          }
          // Find the longest trailing substring that is a partial prefix of OPEN.
          let hold = 0;
          for (let k = 1; k < OPEN.length && k <= carry.length; k++) {
            const tail = carry.slice(carry.length - k);
            if (isPartialPrefix(tail, OPEN)) hold = k;
          }
          if (hold > 0) {
            out += carry.slice(0, carry.length - hold);
            carry = carry.slice(carry.length - hold);
          } else {
            out += carry;
            carry = '';
          }
          break;
        }
        // Emit text before the open tag, drop the tag, flip to inside.
        out += carry.slice(0, openIdx);
        carry = carry.slice(openIdx + OPEN.length);
        inThink = true;
        continue;
      }
      return out;
    };

    return new TransformStream<TextStreamPart<ToolSet>, TextStreamPart<ToolSet>>({
      transform(part, controller) {
        if (part.type !== 'text-delta') {
          controller.enqueue(part);
          return;
        }
        carry += part.text;
        const visible = drain(false);
        if (visible.length > 0) {
          controller.enqueue({ ...part, text: visible });
        }
        // Suppress an empty delta (all of it was think / held back).
      },
      flush(controller) {
        const visible = drain(true);
        if (visible.length > 0) {
          // Emit any held-back tail as a final synthetic text-delta. We reuse
          // a stable id so consumers treat it as part of the same text run.
          controller.enqueue({ type: 'text-delta', id: 'think-strip-flush', text: visible });
        }
      },
    });
  };
}

// ---------------------------------------------------------------------------
// runAgent
// ---------------------------------------------------------------------------

/**
 * Drive a real conversational agent turn over `input.messages`. Resolves the
 * MiniMax `.chat()` model, assembles the (byte-for-byte unchanged) system
 * prompt, enters the run context for the HIL-gated tools, and kicks off a
 * token-level `streamText` turn with the name-keyed `AGENT_TOOLS_MAP`.
 *
 * Returns a `RunAgentHandle` whose `stream` is the raw `fullStream` — the
 * route adapter maps parts to SSE and MUST call `handle.dispose()` when the
 * stream ends (to tear down the run context). When no provider is configured,
 * returns `{ noProvider: true }` so the adapter can emit a clear error.
 */
export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const clock = input._clockOverride ?? (() => Date.now());
  const runId = input._runIdOverride ?? makeRunId(clock);
  const characterId: CharacterId = input.characterId ?? 'kael';
  const safetyMaxSteps = input.safetyMaxSteps ?? DEFAULT_SAFETY_MAX_STEPS;

  // ---- Resolve the model (the #1 risk: MUST be the .chat() object). --------
  let resolved:
    | { model: LanguageModel; modelId: string; provider: RunDirectorLoopResult['provider'] }
    | null;
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
    return { runId, provider: 'unknown', noProvider: true };
  }

  // ---- Enter the run context for the HIL-gated tools. ----------------------
  // softBudgetUsd is a visible meter; the run-context budgetUsd mirrors it so
  // a tool's HIL guard can still compute "projected total after this call".
  // When no soft budget is set we pass a large sentinel so the meter never
  // gates (the agent decides when it is done, not a dollar cap).
  const softBudget = input.softBudgetUsd && input.softBudgetUsd > 0 ? input.softBudgetUsd : null;
  const budget = new BudgetTracker(softBudget ?? Number.MAX_SAFE_INTEGER);
  let budgetCrossed = false;
  const tokens = { input: 0, output: 0 };

  const { enterRunContext, exitRunContext, addToTotalCost } = await import(
    '@/lib/agent-loop/run-context'
  );
  enterRunContext({
    runId,
    stepCounter: 0,
    totalCostUsd: 0,
    budgetUsd: softBudget ?? Number.MAX_SAFE_INTEGER,
    characterId,
    ...(input.higgsfieldConnector ? { higgsfieldConnector: input.higgsfieldConnector } : {}),
  });

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    exitRunContext();
  };

  try {
    const agentInstructions = await loadAgentInstructions();
    const system = await buildSystem(characterId, agentInstructions, input.skillContext);

    const tools = (input._toolsOverride ?? AGENT_TOOLS_MAP) as ToolSet;
    const makeTransform = makeThinkStripTransform();

    // Story 10.5: token-budgeted sliding-window compaction so long sessions
    // don't overflow the model context window (FR-1). PURE + deterministic; the
    // canon system block (built above, passed separately) and RunContext
    // (active character / Element / approval state) are NOT in `messages`, so
    // trimming old turns cannot change identity-lock or approval behaviour. A
    // short conversation is returned unchanged (byte-for-byte).
    const estimateTokens = input._tokenCounterOverride ?? ((t: string) => Math.ceil(t.length / 4));
    // Alias-aware lookup so a persisted alias id (e.g. `M2.7-highspeed`) resolves
    // to its real context window instead of the conservative fallback.
    const catalogEntry = resolveTextModel(resolved.modelId);
    const messages = compactMessages(input.messages, {
      contextWindowTokens: catalogEntry?.contextWindow ?? 32_000,
      reserveTokens: catalogEntry?.defaultMaxTokens ?? 4_096,
      systemTokens: estimateTokens(system),
      estimateTokens,
    });

    const result = streamText({
      model: resolved.model,
      system,
      messages,
      tools,
      // No workflow cap. stepCountIs(256) is a pure runaway safety net; the
      // agent stops naturally (finishReason stop) when it ends its turn with
      // text and no tool call — exactly like Claude Code.
      stopWhen: [stepCountIs(safetyMaxSteps)],
      ...(input.signal ? { abortSignal: input.signal } : {}),
      maxRetries: 2,
      // STATEFUL think-stripping so partial <think> tags never leak.
      experimental_transform: makeTransform,
      // SOFT budget meter: record cost per step; NEVER throw mid-step. When the
      // soft budget is crossed we flip a flag the adapter surfaces as a visible
      // marker, but the current turn is allowed to finish.
      onStepFinish: (step) => {
        const stepCost = estimateStepCost(step.usage, resolved!.modelId);
        recordSoft(budget, stepCost);
        addToTotalCost(stepCost);
        if (softBudget !== null && budget.total >= softBudget) budgetCrossed = true;
        const i = step.usage?.inputTokens;
        const o = step.usage?.outputTokens;
        if (typeof i === 'number' && Number.isFinite(i) && i > 0) tokens.input += i;
        if (typeof o === 'number' && Number.isFinite(o) && o > 0) tokens.output += o;
      },
    });

    // Wrap fullStream so the optional onChunk callback fires per part without
    // forcing the adapter to thread it. Tee-free: we yield the same parts.
    const source = result.fullStream;
    const onChunk = input.onChunk;
    const stream: AsyncIterable<TextStreamPart<ToolSet>> = onChunk
      ? (async function* () {
          for await (const part of source) {
            try {
              onChunk(part);
            } catch {
              // Best-effort telemetry — a throwing callback never breaks the stream.
            }
            yield part;
          }
        })()
      : source;

    return {
      runId,
      modelId: resolved.modelId,
      provider: resolved.provider,
      stream,
      cost: () => budget.total,
      budgetCrossed: () => budgetCrossed,
      tokensUsed: () => ({ input: tokens.input, output: tokens.output }),
      dispose,
    };
  } catch (e) {
    // A synchronous failure before the stream started — tear down and rethrow
    // so the adapter can surface it as an error event.
    dispose();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Add `cost` to the soft-budget tracker WITHOUT throwing. The legacy
 * `BudgetTracker.record` throws `BudgetExceededError` when the cap is crossed
 * — fatal for a hard cap, wrong for a soft meter. We re-implement the additive
 * step against its public surface by catching the throw: the total is still
 * advanced (the throw happens AFTER the addition), so we swallow it and let
 * the meter keep counting past the limit.
 */
function recordSoft(budget: BudgetTracker, cost: number): void {
  try {
    budget.record(cost);
  } catch {
    // BudgetExceededError — the addition already happened; soft meter keeps
    // counting. NEVER propagate (no hard kill mid-step).
  }
}

function makeRunId(clock: () => number): string {
  const ts = clock().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `run_${ts}_${rand}`;
}
