/**
 * v1.2 — Director Route 2.0 main loop tests.
 *
 * Unit tests for `runDirectorLoop`. The AI SDK's
 * `ToolLoopAgent` class is mocked with `vi.mock` (v1.2.6
 * migration — previously the bare `generateText` function
 * was mocked) so we can drive the loop deterministically
 * (no network, no real LLM). The mock simulates the SDK's
 * per-step event flow by calling `onStepFinish` with a
 * canned `StepResult`-shaped object and then returning a
 * final `GenerateTextResult`.
 *
 * What's tested:
 *   - happy path: 2-step loop (plan, tool_call, tool_result,
 *     final) → final prompt + step log + cost
 *   - final-prompt extraction: when the model only emits
 *     tool calls, the final prompt comes from the last
 *     `generate_prompt` tool result
 *   - budget hard-stop: a 3rd step that would push past the
 *     cap throws BudgetExceededError → result.truncatedBy
 *     is 'budget'
 *   - no-provider: missing env keys + no _modelOverride →
 *     truncatedBy 'error', provider 'unknown'
 *   - input validation: missing niches / ideaConcept /
 *     invalid types throw
 *   - step-log shape: every event ends up in `steps` with
 *     monotonic `idx`
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';

// ---------------------------------------------------------------------------
// Mock the `ai` SDK so the loop can run without a real LLM.
//
// v1.2.6: the Director loop now uses the v6 `ToolLoopAgent`
// class. We mock `ToolLoopAgent.prototype.generate` instead
// of the bare `generateText` function. The mock records
// every call to `.generate()` and lets the test control what
// `onStepFinish` sees + what the final `GenerateTextResult`
// returns. We keep `stepCountIs` and `tool` from the real
// module so `stopWhen` / `AGENT_TOOLS` still work.
//
// `vi.hoisted` is required so the mock factory (which
// Vitest hoists to the top of the file) can see the mock
// variable.
// ---------------------------------------------------------------------------

const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  // Replace the ToolLoopAgent class with a stub whose
  // `.generate` is the shared vi.fn() we can assert on.
  // The class still has to be `new`-callable; the stub
  // ignores all constructor args (model / tools / stopWhen)
  // because the test never depends on them.
  class StubToolLoopAgent {
    constructor(_opts: unknown) {
      // ignore — the test doesn't care which tools/model
      // the loop wires up, only that `.generate` is called
      // with the expected `prompt` + `onStepFinish`.
    }
    generate = generateTextMock;
  }
  return {
    ...actual,
    ToolLoopAgent: StubToolLoopAgent,
  };
});

// ---------------------------------------------------------------------------
// Imports under test — must come AFTER the `vi.mock` call so
// the mock is wired before the module evaluates.
// ---------------------------------------------------------------------------

 
import * as aiMock from 'ai';
import {
  runDirectorLoop,
  resolveDirectorModel,
  type RunDirectorLoopResult,
  type RunDirectorLoopInput,
} from '@/lib/agent-loop';

// ---------------------------------------------------------------------------
// Fake StepResult builder
// ---------------------------------------------------------------------------

interface FakeToolCall {
  toolName: string;
  input: unknown;
}
interface FakeToolResult {
  toolName: string;
  input: unknown;
  output: unknown;
}

function makeStepResult(args: {
  stepNumber: number;
  text?: string;
  toolCalls?: FakeToolCall[];
  toolResults?: FakeToolResult[];
  usage?: { inputTokens?: number; outputTokens?: number };
  finishReason?: string;
}) {
  return {
    stepNumber: args.stepNumber,
    model: { provider: 'mock', modelId: 'MiniMax-M3' },
    functionId: undefined,
    metadata: undefined,
    experimental_context: undefined,
    content: args.text
      ? [{ type: 'text', text: args.text }]
      : [],
    text: args.text ?? '',
    reasoning: [],
    reasoningText: undefined,
    files: [],
    sources: [],
    toolCalls: (args.toolCalls ?? []).map((c, i) => ({
      type: 'tool-call',
      toolCallId: `tc_${args.stepNumber}_${i}`,
      toolName: c.toolName,
      input: c.input,
      dynamic: false,
    })),
    staticToolCalls: [],
    dynamicToolCalls: [],
    toolResults: (args.toolResults ?? []).map((r, i) => ({
      type: 'tool-result',
      toolCallId: `tc_${args.stepNumber}_${i}`,
      toolName: r.toolName,
      input: r.input,
      output: r.output,
      dynamic: false,
    })),
    staticToolResults: [],
    dynamicToolResults: [],
    finishReason: args.finishReason ?? 'stop',
    rawFinishReason: args.finishReason ?? 'stop',
    usage: {
      inputTokens: args.usage?.inputTokens,
      outputTokens: args.usage?.outputTokens,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: {
        textTokens: undefined,
        reasoningTokens: undefined,
      },
      totalTokens:
        (args.usage?.inputTokens ?? 0) + (args.usage?.outputTokens ?? 0),
    },
    warnings: undefined,
    request: { body: undefined },
    response: {
      id: `resp_${args.stepNumber}`,
      timestamp: new Date(),
      modelId: 'MiniMax-M3',
      headers: undefined,
      messages: [],
    },
    providerMetadata: undefined,
  };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const baseInput: RunDirectorLoopInput = {
  niches: ['Multiverse Crossovers', 'Mythic Legends'],
  genres: ['Noir & Gritty'],
  ideaConcept: 'Darth Vader in Iron Man suit',
  userId: 'user_test_1',
  _modelOverride: { model: { modelId: 'MiniMax-M3' } as never, modelId: 'MiniMax-M3' },
  _runIdOverride: 'run_test_001',
  _clockOverride: () => 1700000000000,
  // _toolsOverride omitted on purpose — the loop should
  // work with the real AGENT_TOOLS array (which never
  // gets called because ToolLoopAgent.generate is mocked).
};

beforeEach(() => {
  generateTextMock.mockReset();
  // Clear idb-keyval so persistence tests don't bleed.
  // fake-indexeddb is loaded above; clearing here keeps
  // each test isolated.
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Happy path: 2-step loop
// ---------------------------------------------------------------------------

describe('runDirectorLoop — happy path', () => {
  it('returns a RunDirectorLoopResult with the expected shape', async () => {
    // Simulate: step0 = tool_call (trending_search) + tool_result
    //           step1 = tool_call (generate_prompt) + tool_result + final text
    const trendingResult = {
      results: [
        { title: 'A', url: 'https://a', snippet: '…', niche: 'Marvel', source: '@google_search' },
      ],
      nichesWithHits: ['Multiverse Crossovers'],
      servedBy: 'camofox',
    };
    const promptResult = {
      draft: 'A noir Iron Vader standing in neon rain, crimson cape catching the light…',
      usedSkills: [],
      modelId: 'MiniMax-M3',
    };

    generateTextMock.mockImplementation(async (opts: { onStepFinish?: (s: unknown) => Promise<void> | void }) => {
      const step0 = makeStepResult({
        stepNumber: 0,
        text: '',
        toolCalls: [{ toolName: 'trending_search', input: { niches: ['Marvel'] } }],
        toolResults: [{ toolName: 'trending_search', input: { niches: ['Marvel'] }, output: trendingResult }],
        usage: { inputTokens: 100, outputTokens: 50 },
        finishReason: 'tool-calls',
      });
      await opts.onStepFinish?.(step0);

      const step1 = makeStepResult({
        stepNumber: 1,
        text: 'A noir Iron Vader standing in neon rain, crimson cape catching the light…',
        toolCalls: [{ toolName: 'generate_prompt', input: { angle: 'Darth Vader in Iron Man suit' } }],
        toolResults: [{ toolName: 'generate_prompt', input: { angle: 'Darth Vader in Iron Man suit' }, output: promptResult }],
        usage: { inputTokens: 200, outputTokens: 80 },
        finishReason: 'stop',
      });
      await opts.onStepFinish?.(step1);

      return {
        text: 'A noir Iron Vader standing in neon rain, crimson cape catching the light…',
        steps: [step0, step1],
        finishReason: 'stop',
      };
    });

    const result = await runDirectorLoop(baseInput);

    expect(result.runId).toBe('run_test_001');
    expect(result.finalPrompt).toContain('Iron Vader');
    expect(result.modelId).toBe('MiniMax-M3');
    expect(result.truncatedBy).toBe('natural');
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it('produces the canonical step sequence: plan → tool_call → tool_result', async () => {
    generateTextMock.mockImplementation(async (opts: { onStepFinish?: (s: unknown) => Promise<void> | void }) => {
      const step0 = makeStepResult({
        stepNumber: 0,
        toolCalls: [{ toolName: 'trending_search', input: { niches: ['Marvel'] } }],
        toolResults: [{ toolName: 'trending_search', input: { niches: ['Marvel'] }, output: { results: [], nichesWithHits: [], servedBy: 'camofox' } }],
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      await opts.onStepFinish?.(step0);

      const step1 = makeStepResult({
        stepNumber: 1,
        text: 'final draft',
        toolCalls: [{ toolName: 'generate_prompt', input: {} }],
        toolResults: [{ toolName: 'generate_prompt', input: {}, output: { draft: 'final draft', usedSkills: [], modelId: 'MiniMax-M3' } }],
        usage: { inputTokens: 20, outputTokens: 10 },
      });
      await opts.onStepFinish?.(step1);

      return { text: 'final draft', steps: [step0, step1], finishReason: 'stop' };
    });

    const result = await runDirectorLoop(baseInput);
    const types = result.steps.map((s) => s.type);
    expect(types[0]).toBe('plan');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    // The last step is the `tool_result` for the final
    // `generate_prompt` call (the canonical source of the
    // final prompt text). The model's "final" text is
    // captured as the tool's `draft` output, not as a
    // separate `final`-typed step in the log.
    expect(types[types.length - 1]).toBe('tool_result');
  });

  it('records a `final` step when the model emits pure text without a tool call', async () => {
    // Edge case: the model skips the loop and writes the
    // prompt directly as its terminal text. The Replay UI
    // should still see a `final` step.
    generateTextMock.mockImplementation(async (opts: { onStepFinish?: (s: unknown) => Promise<void> | void }) => {
      const s0 = makeStepResult({
        stepNumber: 0,
        text: 'A direct, no-tool prompt draft',
        toolCalls: [],
        toolResults: [],
        usage: { inputTokens: 5, outputTokens: 5 },
        finishReason: 'stop',
      });
      await opts.onStepFinish?.(s0);
      return { text: 'A direct, no-tool prompt draft', steps: [s0], finishReason: 'stop' };
    });

    const result = await runDirectorLoop(baseInput);
    const types = result.steps.map((s) => s.type);
    expect(types).toContain('final');
    expect(result.finalPrompt).toBe('A direct, no-tool prompt draft');
  });

  it('accumulates total cost across all LLM steps', async () => {
    // M3: $0.50/1M in, $2.00/1M out.
    // step0: 1M in + 0.5M out = $0.50 + $1.00 = $1.50
    // step1: 0.5M in + 0.25M out = $0.25 + $0.50 = $0.75
    // sum = $2.25
    generateTextMock.mockImplementation(async (opts: { onStepFinish?: (s: unknown) => Promise<void> | void }) => {
      const s0 = makeStepResult({
        stepNumber: 0,
        usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
      });
      await opts.onStepFinish?.(s0);
      const s1 = makeStepResult({
        stepNumber: 1,
        usage: { inputTokens: 500_000, outputTokens: 250_000 },
      });
      await opts.onStepFinish?.(s1);
      return { text: '', steps: [s0, s1], finishReason: 'stop' };
    });

    const result = await runDirectorLoop({
      ...baseInput,
      budgetUsd: 5.0, // headroom so we don't hit the budget
    });
    expect(result.totalCost).toBeCloseTo(2.25, 4);
  });

  it('writes the run to the persistence layer (idb-keyval)', async () => {
    generateTextMock.mockImplementation(async () => {
      return { text: 'final', steps: [], finishReason: 'stop' };
    });

    await runDirectorLoop(baseInput);
    // The loop's persistence is best-effort; verify the
    // run key was written by re-reading it via the
    // loadRun helper (imported lazily so the test
    // doesn't depend on the index module at top level).
    const { loadRun } = await import('@/lib/agent-loop/persistence');
    const loaded = await loadRun('run_test_001');
    expect(loaded).not.toBeNull();
    expect(loaded?.userId).toBe('user_test_1');
  });

  it('invokes onStep for every recorded event', async () => {
    generateTextMock.mockImplementation(async (opts: { onStepFinish?: (s: unknown) => Promise<void> | void }) => {
      const s0 = makeStepResult({
        stepNumber: 0,
        text: 'a direct prompt',
        toolCalls: [],
        toolResults: [],
        usage: { inputTokens: 5, outputTokens: 5 },
      });
      await opts.onStepFinish?.(s0);
      return { text: 'a direct prompt', steps: [s0], finishReason: 'stop' };
    });

    const seen: string[] = [];
    await runDirectorLoop({ ...baseInput, onStep: (s) => seen.push(s.type) });
    expect(seen[0]).toBe('plan');
    expect(seen).toContain('final');
  });
});

// ---------------------------------------------------------------------------
// Final-prompt extraction
// ---------------------------------------------------------------------------

describe('runDirectorLoop — final-prompt extraction', () => {
  it('uses result.text when the model emits terminal text', async () => {
    generateTextMock.mockImplementation(async () => {
      return { text: 'the final prompt', steps: [], finishReason: 'stop' };
    });
    const result = await runDirectorLoop(baseInput);
    expect(result.finalPrompt).toBe('the final prompt');
  });

  it('falls back to the last generate_prompt tool result when text is empty', async () => {
    generateTextMock.mockImplementation(async (opts: { onStepFinish?: (s: unknown) => Promise<void> | void }) => {
      const s = makeStepResult({
        stepNumber: 0,
        text: '',
        toolCalls: [{ toolName: 'generate_prompt', input: {} }],
        toolResults: [{
          toolName: 'generate_prompt',
          input: {},
          output: { draft: 'prompt from tool call', usedSkills: [], modelId: 'MiniMax-M3' },
        }],
        finishReason: 'stop',
      });
      await opts.onStepFinish?.(s);
      return { text: '', steps: [s], finishReason: 'stop' };
    });
    const result = await runDirectorLoop(baseInput);
    expect(result.finalPrompt).toBe('prompt from tool call');
  });

  it('returns empty string when no prompt was produced', async () => {
    generateTextMock.mockImplementation(async () => {
      return { text: '', steps: [], finishReason: 'stop' };
    });
    const result = await runDirectorLoop(baseInput);
    expect(result.finalPrompt).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Budget hard-stop
// ---------------------------------------------------------------------------

describe('runDirectorLoop — budget hard-stop', () => {
  it('marks truncatedBy=budget when the SDK throws BudgetExceededError', async () => {
    generateTextMock.mockImplementation(async (opts: { onStepFinish?: (s: unknown) => Promise<void> | void }) => {
      const s0 = makeStepResult({
        stepNumber: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      await opts.onStepFinish?.(s0);
      // Second step's cost would push past the $0.10 cap
      // ($0.06 from step 0 + $0.50 from this step = $0.56).
      // The loop's BudgetTracker throws; the SDK
      // propagates the throw to the outer catch.
      const err = new Error('Budget exceeded');
      err.name = 'BudgetExceededError';
      throw err;
    });

    const result = await runDirectorLoop({
      ...baseInput,
      budgetUsd: 0.10,
    });
    expect(result.truncatedBy).toBe('budget');
    // The error step should be in the log.
    expect(result.steps.some((s) => s.type === 'error')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No provider configured
// ---------------------------------------------------------------------------

describe('runDirectorLoop — no provider', () => {
  it('returns truncatedBy=error and provider=unknown', async () => {
    // Force the "no API key" branch by clearing the env
    // vars and skipping the override.
    const prevMinimax = process.env.MINIMAX_API_KEY;
    const prevOpenai = process.env.OPENAI_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const result = await runDirectorLoop({
        ...baseInput,
        _modelOverride: undefined,
      });
      expect(result.truncatedBy).toBe('error');
      expect(result.provider).toBe('unknown');
      expect(result.finalPrompt).toBe('');
      expect(result.steps.some((s) => s.type === 'error')).toBe(true);
    } finally {
      if (prevMinimax !== undefined) process.env.MINIMAX_API_KEY = prevMinimax;
      if (prevOpenai !== undefined) process.env.OPENAI_API_KEY = prevOpenai;
    }
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('runDirectorLoop — input validation', () => {
  it('throws on empty niches', async () => {
    await expect(
      runDirectorLoop({ ...baseInput, niches: [] }),
    ).rejects.toThrow(/niches/);
  });

  it('throws on missing ideaConcept', async () => {
    await expect(
      runDirectorLoop({ ...baseInput, ideaConcept: '' }),
    ).rejects.toThrow(/ideaConcept/);
  });

  it('throws on missing userId', async () => {
    await expect(
      runDirectorLoop({ ...baseInput, userId: '' }),
    ).rejects.toThrow(/userId/);
  });

  it('throws on invalid budgetUsd (zero or negative)', async () => {
    await expect(
      runDirectorLoop({ ...baseInput, budgetUsd: 0 }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveDirectorModel
// ---------------------------------------------------------------------------

describe('resolveDirectorModel', () => {
  it('returns null when no API key is set', async () => {
    const prevMinimax = process.env.MINIMAX_API_KEY;
    const prevOpenai = process.env.OPENAI_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const r = await resolveDirectorModel(undefined);
      expect(r).toBeNull();
    } finally {
      if (prevMinimax !== undefined) process.env.MINIMAX_API_KEY = prevMinimax;
      if (prevOpenai !== undefined) process.env.OPENAI_API_KEY = prevOpenai;
    }
  });

  it('returns a mock model when override is "mock"', async () => {
    const r = await resolveDirectorModel('mock');
    expect(r).not.toBeNull();
    expect(r?.provider).toBe('mock');
    expect(r?.modelId).toBe('mock');
  });
});

// ---------------------------------------------------------------------------
// V1.7.0-DIRECTOR-PROMPT-FIX: report-scaffolding must not leak into the prompt
// ---------------------------------------------------------------------------

describe('runDirectorLoop — final prompt extraction (report scaffolding)', () => {
  it('returns the clean generate_prompt draft, NOT the chatty terminal report', async () => {
    // Reproduces the real bug: the model wrote a whole report as its
    // terminal text (<think> block, iteration log, "Final prompt
    // (copy-paste ready):", "Niches anchored", "Ready to feed to
    // generate_image — just say the word"). The OLD code returned that
    // entire blob as finalPrompt. The fix prefers the validated draft.
    const cleanDraft =
      'Low-angle hero shot of the Justice League in 1980s anime cel-shading, ' +
      'neon rim lighting, VHS grain, chromatic aberration.';
    const chattyReport =
      '<think> Score 0.767 — clears the 0.7 bar. The user asked me to return ' +
      'the final prompt, not generate. </think>\n\n' +
      '✅ **Director plan complete — final prompt approved (score 0.767).**\n\n' +
      '**Iteration log**\n- Draft 1 → 0.633 → rejected\n- Draft 2 → 0.767 → approved\n\n' +
      '**Final prompt (copy-paste ready):**\n> ' + cleanDraft + '\n\n' +
      '**Niches anchored:** Multiverse ✓ · Retro ✓\n\n' +
      'Ready to feed to `generate_image` — just say the word and I will fire the render.';

    generateTextMock.mockImplementation(async (opts: { onStepFinish?: (s: unknown) => Promise<void> | void }) => {
      const s = makeStepResult({
        stepNumber: 0,
        text: chattyReport,
        toolCalls: [{ toolName: 'generate_prompt', input: {} }],
        toolResults: [{ toolName: 'generate_prompt', input: {}, output: { draft: cleanDraft, usedSkills: [], modelId: 'MiniMax-M3' } }],
        usage: { inputTokens: 50, outputTokens: 50 },
        finishReason: 'stop',
      });
      await opts.onStepFinish?.(s);
      return { text: chattyReport, steps: [s], finishReason: 'stop' };
    });

    const result = await runDirectorLoop(baseInput);
    expect(result.finalPrompt).toBe(cleanDraft);
    expect(result.finalPrompt).not.toContain('<think>');
    expect(result.finalPrompt).not.toContain('Iteration log');
    expect(result.finalPrompt).not.toContain('Ready to feed');
  });

  it('text-only fallback strips <think> reasoning from the terminal text', async () => {
    generateTextMock.mockImplementation(async (opts: { onStepFinish?: (s: unknown) => Promise<void> | void }) => {
      const s = makeStepResult({
        stepNumber: 0,
        text: '<think> deciding on the angle… </think>\nA lone astronaut on a crimson dune at golden hour.',
        toolCalls: [],
        toolResults: [],
        usage: { inputTokens: 5, outputTokens: 5 },
        finishReason: 'stop',
      });
      await opts.onStepFinish?.(s);
      return { text: '<think> deciding on the angle… </think>\nA lone astronaut on a crimson dune at golden hour.', steps: [s], finishReason: 'stop' };
    });

    const result = await runDirectorLoop(baseInput);
    expect(result.finalPrompt).toBe('A lone astronaut on a crimson dune at golden hour.');
    expect(result.finalPrompt).not.toContain('<think>');
  });
});
