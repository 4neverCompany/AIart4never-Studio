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
  stripThinkBlocks,
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
  // M1 CANON-NATIVE: canon content pillars + style + an on-canon beat.
  niches: ['Variant Reveal', 'Cyberpunk PRIME'],
  genres: ['Cinematic'],
  ideaConcept: 'Kael steps into the W40K reality and meets Kaelus Vorne',
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
    // M1 CANON-NATIVE: the canon beat flow has NO trending_search.
    // Simulate: step0 = tool_call (generate_prompt) + tool_result
    //           step1 = tool_call (generate_image) + tool_result + final text
    const promptResult = {
      draft: 'Kael, ashen netrunner, faces Kaelus Vorne in a candle-lit nave, cyan circuitry meeting the Iron Halo…',
      usedSkills: [],
      modelId: 'MiniMax-M3',
    };
    const imageResult = {
      assetRef: { provider: 'higgsfield', id: 'img-1', url: 'https://h/img-1.png' },
      creditsCharged: 60,
    };

    generateTextMock.mockImplementation(async (opts: { onStepFinish?: (s: unknown) => Promise<void> | void }) => {
      const step0 = makeStepResult({
        stepNumber: 0,
        text: '',
        toolCalls: [{ toolName: 'generate_prompt', input: { angle: 'Kael meets Kaelus Vorne' } }],
        toolResults: [{ toolName: 'generate_prompt', input: { angle: 'Kael meets Kaelus Vorne' }, output: promptResult }],
        usage: { inputTokens: 100, outputTokens: 50 },
        finishReason: 'tool-calls',
      });
      await opts.onStepFinish?.(step0);

      const step1 = makeStepResult({
        stepNumber: 1,
        text: 'Kael, ashen netrunner, faces Kaelus Vorne in a candle-lit nave, cyan circuitry meeting the Iron Halo…',
        toolCalls: [{ toolName: 'generate_image', input: { model: 'nano_banana_2' } }],
        toolResults: [{ toolName: 'generate_image', input: { model: 'nano_banana_2' }, output: imageResult }],
        usage: { inputTokens: 200, outputTokens: 80 },
        finishReason: 'stop',
      });
      await opts.onStepFinish?.(step1);

      return {
        text: 'Kael, ashen netrunner, faces Kaelus Vorne in a candle-lit nave, cyan circuitry meeting the Iron Halo…',
        steps: [step0, step1],
        finishReason: 'stop',
      };
    });

    const result = await runDirectorLoop(baseInput);

    expect(result.runId).toBe('run_test_001');
    expect(result.finalPrompt).toContain('Kaelus Vorne');
    expect(result.modelId).toBe('MiniMax-M3');
    expect(result.truncatedBy).toBe('natural');
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it('produces the canonical step sequence: tool_call → tool_result (no plan scaffold step)', async () => {
    generateTextMock.mockImplementation(async (opts: { onStepFinish?: (s: unknown) => Promise<void> | void }) => {
      const step0 = makeStepResult({
        stepNumber: 0,
        toolCalls: [{ toolName: 'generate_prompt', input: { niches: ['Variant Reveal'] } }],
        toolResults: [{ toolName: 'generate_prompt', input: { niches: ['Variant Reveal'] }, output: { draft: 'a long enough canon scene draft for the variant reveal beat', usedSkills: [], modelId: 'MiniMax-M3' } }],
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
    // MASHUPFORGE-RIP: the rigid pre-baked plan-scaffold step is gone — the
    // loop is always the AGENT.md-driven agent. The first recorded step is the
    // model's first tool call, not a 'plan' step.
    expect(types[0]).not.toBe('plan');
    expect(types).not.toContain('plan');
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
    // MASHUPFORGE-RIP: no pre-baked 'plan' scaffold step — onStep now fires
    // only for the model's recorded events (here, the terminal 'final' text).
    expect(seen).not.toContain('plan');
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
  it('returns truncatedBy=error and provider=unknown when MINIMAX_API_KEY is unset (4NE-20: no OpenAI fallback)', async () => {
    // Force the "no MiniMax key" branch. A stray OPENAI_API_KEY must
    // NOT rescue the run — MiniMax is the only text/agent provider now.
    const prevMinimax = process.env.MINIMAX_API_KEY;
    const prevOpenai = process.env.OPENAI_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    process.env.OPENAI_API_KEY = 'stray-openai-key';
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
      else delete process.env.OPENAI_API_KEY;
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
  it('returns null when MINIMAX_API_KEY is unset, even with a stray OPENAI_API_KEY (4NE-20)', async () => {
    const prevMinimax = process.env.MINIMAX_API_KEY;
    const prevOpenai = process.env.OPENAI_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    process.env.OPENAI_API_KEY = 'stray-openai-key';
    try {
      const r = await resolveDirectorModel(undefined);
      expect(r).toBeNull();
    } finally {
      if (prevMinimax !== undefined) process.env.MINIMAX_API_KEY = prevMinimax;
      if (prevOpenai !== undefined) process.env.OPENAI_API_KEY = prevOpenai;
      else delete process.env.OPENAI_API_KEY;
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

// ---------------------------------------------------------------------------
// AGENT.md REWIRE: the CHAT/STREAM path (`conversational: true`) is an
// AGENT.md-driven intelligent agent. Its system prompt = AGENT.md identity +
// the STRUCTURED canon block, with NO rigid 6-step scaffold; its user turn is
// the operator's RAW message (not "Beat: … Execute the director plan"); and it
// does NOT emit a plan-step scaffold on the stream.
// ---------------------------------------------------------------------------

describe('runDirectorLoop — conversational (AGENT.md) chat path plumbing', () => {
  /** Capture the `system` + `prompt` the loop hands to the agent. */
  function captureGenerateArgs(): { current: { system?: string; prompt?: string } } {
    const holder: { current: { system?: string; prompt?: string } } = { current: {} };
    generateTextMock.mockImplementation(
      async (opts: { system?: string; prompt?: string; onStepFinish?: (s: unknown) => Promise<void> | void }) => {
        holder.current = { system: opts.system, prompt: opts.prompt };
        const s = makeStepResult({
          stepNumber: 0,
          text: 'hey — what beat do you want to forge?',
          toolCalls: [],
          toolResults: [],
          usage: { inputTokens: 5, outputTokens: 5 },
          finishReason: 'stop',
        });
        await opts.onStepFinish?.(s);
        return { text: 'hey — what beat do you want to forge?', steps: [s], finishReason: 'stop' };
      },
    );
    return holder;
  }

  it('builds the system prompt from AGENT.md + the canon block (no rigid scaffold)', async () => {
    const captured = captureGenerateArgs();
    await runDirectorLoop({ ...baseInput, conversational: true, ideaConcept: 'hey' });

    const system = captured.current.system ?? '';
    // AGENT.md identity is present.
    expect(system).toMatch(/AIart4never Studio agent/i);
    expect(system).toMatch(/Master4never/);
    expect(system).toMatch(/Element-anchored/i);
    // The STRUCTURED canon block (default character Kael) is present.
    expect(system).toMatch(/Master4never \(Kael\)/);
    expect(system).toMatch(/cyberdeck/i);
    expect(system).toMatch(/<<<[0-9a-f-]+>>>/i);
    // The rigid 6-step director scaffold is NOT present.
    expect(system).not.toMatch(/Director plan \(executed in this order/i);
    expect(system).not.toMatch(/Determine the beat/);
    expect(system).not.toMatch(/Execute the director plan/i);
  });

  it('uses the operator RAW message as the user turn (no Beat: wrapper)', async () => {
    const captured = captureGenerateArgs();
    await runDirectorLoop({ ...baseInput, conversational: true, ideaConcept: 'hey' });
    expect(captured.current.prompt).toBe('hey');
    expect(captured.current.prompt).not.toMatch(/^Beat:/);
    expect(captured.current.prompt).not.toMatch(/Execute the director plan/i);
  });

  it('does NOT emit a plan step on the conversational stream', async () => {
    captureGenerateArgs();
    const seen: string[] = [];
    await runDirectorLoop({
      ...baseInput,
      conversational: true,
      ideaConcept: 'hey',
      onStep: (s) => seen.push(s.type),
    });
    // The first (and every) step is NOT a 'plan' scaffold step.
    expect(seen).not.toContain('plan');
    expect(seen[0]).not.toBe('plan');
  });

  it('strips the model <think> chain-of-thought from the streamed reasoning bubble', async () => {
    // THINK-LEAK FIX: on a greeting the model emits a <think> reasoning block
    // before its actual reply. The per-step `reasoning` that feeds the chat
    // bubble must carry ONLY the natural reply, never the chain-of-thought.
    const reply = 'Hey! 👋 What beat do you want to forge?';
    const withThink =
      '<think>\nThe user just said "hey" — a casual greeting. Keep it short and inviting.\n</think>\n\n' +
      reply;
    generateTextMock.mockImplementation(
      async (opts: { onStepFinish?: (s: unknown) => Promise<void> | void }) => {
        const s = makeStepResult({
          stepNumber: 0,
          text: withThink,
          toolCalls: [],
          toolResults: [],
          usage: { inputTokens: 5, outputTokens: 5 },
          finishReason: 'stop',
        });
        await opts.onStepFinish?.(s);
        return { text: withThink, steps: [s], finishReason: 'stop' };
      },
    );
    const steps: Array<{ type: string; reasoning?: string }> = [];
    await runDirectorLoop({
      ...baseInput,
      conversational: true,
      ideaConcept: 'hey',
      onStep: (s) => steps.push(s as unknown as { type: string; reasoning?: string }),
    });
    const finalStep = steps.find((s) => s.type === 'final');
    expect(finalStep).toBeDefined();
    expect(finalStep?.reasoning).toBe(reply);
    expect(finalStep?.reasoning).not.toContain('<think>');
    expect(finalStep?.reasoning).not.toContain('casual greeting');
  });

  it('MASHUPFORGE-RIP: a call WITHOUT conversational behaves identically (no plan scaffold, no Beat: turn)', async () => {
    // The one-shot pipeline scaffold has been removed: the `conversational`
    // flag no longer branches behaviour, so a call that omits it resolves the
    // SAME AGENT.md chat prompt + raw user turn and emits NO plan step.
    const holder: { current: { system?: string; prompt?: string } } = { current: {} };
    generateTextMock.mockImplementation(
      async (opts: { system?: string; prompt?: string; onStepFinish?: (s: unknown) => Promise<void> | void }) => {
        holder.current = { system: opts.system, prompt: opts.prompt };
        const s = makeStepResult({ stepNumber: 0, text: 'a draft', usage: { inputTokens: 5, outputTokens: 5 } });
        await opts.onStepFinish?.(s);
        return { text: 'a draft', steps: [s], finishReason: 'stop' };
      },
    );
    const seen: string[] = [];
    await runDirectorLoop({ ...baseInput, ideaConcept: 'hey', onStep: (s) => seen.push(s.type) });
    // No pre-baked plan scaffold step.
    expect(seen).not.toContain('plan');
    // Raw operator message as the user turn — no "Beat:" wrapper.
    expect(holder.current.prompt).toBe('hey');
    expect(holder.current.prompt).not.toMatch(/^Beat:/);
    // AGENT.md chat system prompt — NOT the rigid director scaffold.
    expect(holder.current.system).not.toMatch(/Director plan \(executed in this order/i);
    expect(holder.current.system).toMatch(/AIart4never Studio agent/i);
  });
});

describe('stripThinkBlocks', () => {
  it('removes a terminated <think>…</think> block and keeps the reply', () => {
    expect(stripThinkBlocks('<think>reasoning here</think>\n\nThe reply.')).toBe('The reply.');
  });

  it('removes a multiline <think> block', () => {
    expect(stripThinkBlocks('<think>\nline one\nline two\n</think>\nReply.')).toBe('Reply.');
  });

  it('removes multiple <think> blocks', () => {
    expect(stripThinkBlocks('<think>a</think>X<think>b</think>Y')).toBe('XY');
  });

  it('drops a truncated leading <think> with no close (cut-off reasoning)', () => {
    expect(stripThinkBlocks('<think>still reasoning, never closed')).toBe('');
  });

  it('keeps text before a truncated <think>', () => {
    expect(stripThinkBlocks('A reply.\n<think>then it started thinking')).toBe('A reply.');
  });

  it('passes through text with no think tags unchanged', () => {
    expect(stripThinkBlocks('Just a normal reply with <brackets> and 1 < 2.')).toBe(
      'Just a normal reply with <brackets> and 1 < 2.',
    );
  });

  it('returns empty for empty input', () => {
    expect(stripThinkBlocks('')).toBe('');
  });
});
