/**
 * AGENTIC-HARNESS — `runAgent` core tests.
 *
 * Unit tests for the clean conversational agent harness. `streamText` from the
 * `ai` SDK is mocked (no network, no real LLM); the mock returns a canned
 * `fullStream` of `TextStreamPart`s and invokes `onStepFinish` so we can assert
 * on:
 *   - messages-in: the loop passes `input.messages` straight to `streamText`
 *     (NO ideaConcept / niches / genres brief);
 *   - the system assembly: AGENT.md identity + the structured canon block + the
 *     Element lock, with NO rigid director scaffold;
 *   - NO caps: `stopWhen` is exactly `[stepCountIs(256)]` (a runaway net, not a
 *     workflow cap) and `maxRetries` is 2;
 *   - the MiniMax `.chat()` seam: the resolved model object is forwarded
 *     verbatim to `streamText`;
 *   - the SOFT budget meter: cost is recorded per step and NEVER throws — the
 *     stream drains fully even past the soft budget;
 *   - the stateful think-stripping transform (tested directly).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';

// ---------------------------------------------------------------------------
// Mock the `ai` SDK so the harness runs without a real LLM. We keep
// `stepCountIs` real (so we can assert the stopWhen identity) and replace
// `streamText` with a shared spy. `vi.hoisted` lets the mock factory see the
// spy variable.
// ---------------------------------------------------------------------------

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, streamText: streamTextMock };
});

import type { ModelMessage, TextStreamPart, ToolSet } from 'ai';
import {
  runAgent,
  buildSystem,
  makeThinkStripTransform,
  type RunAgentInput,
  type RunAgentHandle,
} from '@/lib/agent-core';
import { __setCurrentRunContextForTests } from '@/lib/agent-loop/run-context';

// ---------------------------------------------------------------------------
// Fake fullStream builder
// ---------------------------------------------------------------------------

function asyncIterable(
  parts: Array<TextStreamPart<ToolSet>>,
): AsyncIterable<TextStreamPart<ToolSet>> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const p of parts) yield p;
    },
  };
}

/** A canned step result carrying usage, for the onStepFinish meter. */
function makeStep(usage: { inputTokens?: number; outputTokens?: number }) {
  return {
    stepNumber: 0,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    },
    finishReason: 'stop',
    text: '',
    toolCalls: [],
    toolResults: [],
  };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const baseInput: RunAgentInput = {
  messages: [{ role: 'user', content: 'hey' }] as ModelMessage[],
  userId: 'user_test_1',
  _modelOverride: { model: { modelId: 'MiniMax-M3' } as never, modelId: 'MiniMax-M3' },
  _runIdOverride: 'run_test_001',
  _clockOverride: () => 1700000000000,
};

/** Drain a handle's stream fully (so onStepFinish + telemetry settle). */
async function drain(handle: RunAgentHandle): Promise<TextStreamPart<ToolSet>[]> {
  const out: TextStreamPart<ToolSet>[] = [];
  for await (const part of handle.stream) out.push(part);
  return out;
}

function isHandle(r: unknown): r is RunAgentHandle {
  return !!r && typeof r === 'object' && 'stream' in (r as Record<string, unknown>);
}

beforeEach(() => {
  streamTextMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
  // Story 10.6: never leak an active RunContext between tests — a runAgent test
  // that threw before dispose() would otherwise trip the enterRunContext guard
  // and cascade into the next test.
  __setCurrentRunContextForTests(null);
});

// ---------------------------------------------------------------------------
// messages-in + system assembly + no caps + the .chat() seam
// ---------------------------------------------------------------------------

describe('runAgent — wiring', () => {
  /** Capture the options streamText receives. */
  function capture(): { current: Record<string, unknown> } {
    const holder: { current: Record<string, unknown> } = { current: {} };
    streamTextMock.mockImplementation((opts: Record<string, unknown>) => {
      holder.current = opts;
      // Fire one step so the meter records, then expose a tiny fullStream.
      const onStepFinish = opts.onStepFinish as
        | ((s: unknown) => void)
        | undefined;
      onStepFinish?.(makeStep({ inputTokens: 100, outputTokens: 50 }));
      return {
        fullStream: asyncIterable([
          { type: 'text-delta', id: 't1', text: 'hello' } as TextStreamPart<ToolSet>,
          {
            type: 'finish',
            finishReason: 'stop',
            rawFinishReason: 'stop',
            totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          } as TextStreamPart<ToolSet>,
        ]),
      };
    });
    return holder;
  }

  it('forwards input.messages verbatim (messages-in, no brief)', async () => {
    const captured = capture();
    const handle = await runAgent({
      ...baseInput,
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'forge a beat' },
      ] as ModelMessage[],
    });
    if (!isHandle(handle)) throw new Error('expected a handle');
    await drain(handle);
    handle.dispose();
    expect(captured.current.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'forge a beat' },
    ]);
    // No brief fields leaked into the call.
    expect(captured.current.prompt).toBeUndefined();
  });

  it('Story 10.5: compacts an over-budget history — keeps the newest turn + last user intent (AC1/AC4)', async () => {
    const captured = capture();
    const many: ModelMessage[] = [
      { role: 'user', content: 'old turn 1' },
      { role: 'assistant', content: 'reply 1' },
      { role: 'user', content: 'old turn 2' },
      { role: 'assistant', content: 'reply 2' },
      { role: 'user', content: 'CURRENT: forge a beat' },
    ];
    const handle = await runAgent({
      ...baseInput,
      messages: many,
      // Force over-budget: every message + the system estimate to 50k tokens, so
      // against M3's 128k window (16k reserve) only the newest turn survives.
      _tokenCounterOverride: () => 50_000,
    });
    if (!isHandle(handle)) throw new Error('expected a handle');
    await drain(handle);
    handle.dispose();
    const sent = captured.current.messages as ModelMessage[];
    expect(sent.length).toBeLessThan(many.length); // trimmed (AC1)
    expect(sent[0].role).toBe('user'); // valid slice start (no orphaned tool)
    expect(sent[sent.length - 1].content).toBe('CURRENT: forge a beat'); // operator intent kept
  });

  it('Story 10.5: leaves a short conversation unchanged — no compaction (AC2)', async () => {
    const captured = capture();
    const short: ModelMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'forge' },
    ];
    const handle = await runAgent({ ...baseInput, messages: short });
    if (!isHandle(handle)) throw new Error('expected a handle');
    await drain(handle);
    handle.dispose();
    expect(captured.current.messages).toEqual(short);
    // AC2 byte-for-byte: the SAME array reference is passed through (not a copy).
    expect(captured.current.messages).toBe(short);
  });

  it('builds the system from AGENT.md + canon block + Element lock (no rigid scaffold)', async () => {
    const captured = capture();
    const handle = await runAgent(baseInput);
    if (!isHandle(handle)) throw new Error('expected a handle');
    await drain(handle);
    handle.dispose();
    const system = String(captured.current.system ?? '');
    expect(system).toMatch(/AIart4never Studio agent/i);
    expect(system).toMatch(/Master4never/);
    // Story 2.8: the agent resolves canon live — the prompt names the lookup tool
    // and carries no hardcoded lore or a build-time Element anchor.
    expect(system).toMatch(/show_reference_elements/);
    expect(system).toMatch(/Master4never \(Kael\)/);
    expect(system).not.toMatch(/<<<[0-9a-f-]+>>>/i);
    // No rigid 6-step director scaffold.
    expect(system).not.toMatch(/Director plan \(executed in this order/i);
    expect(system).not.toMatch(/Execute the director plan/i);
  });

  it('sets stopWhen to exactly [stepCountIs(256)] and maxRetries 2 (no workflow cap)', async () => {
    const captured = capture();
    const handle = await runAgent(baseInput);
    if (!isHandle(handle)) throw new Error('expected a handle');
    await drain(handle);
    handle.dispose();
    expect(Array.isArray(captured.current.stopWhen)).toBe(true);
    expect((captured.current.stopWhen as unknown[]).length).toBe(1);
    expect(captured.current.maxRetries).toBe(2);
    // A stateful think-stripping transform is wired.
    expect(typeof captured.current.experimental_transform).toBe('function');
  });

  it('honours a custom safetyMaxSteps but keeps a single-element stopWhen', async () => {
    const captured = capture();
    const handle = await runAgent({ ...baseInput, safetyMaxSteps: 512 });
    if (!isHandle(handle)) throw new Error('expected a handle');
    await drain(handle);
    handle.dispose();
    expect((captured.current.stopWhen as unknown[]).length).toBe(1);
  });

  it('forwards the resolved model object to streamText (the .chat() seam)', async () => {
    const captured = capture();
    const sentinel = { modelId: 'MiniMax-M3', __chatSeam: true } as never;
    const handle = await runAgent({
      ...baseInput,
      _modelOverride: { model: sentinel, modelId: 'MiniMax-M3' },
    });
    if (!isHandle(handle)) throw new Error('expected a handle');
    await drain(handle);
    handle.dispose();
    expect(captured.current.model).toBe(sentinel);
  });
});

// ---------------------------------------------------------------------------
// No provider
// ---------------------------------------------------------------------------

describe('runAgent — no provider', () => {
  it('returns { noProvider: true } when MINIMAX_API_KEY is unset and no override', async () => {
    const prev = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    try {
      const r = await runAgent({ ...baseInput, _modelOverride: undefined });
      expect('noProvider' in r && r.noProvider).toBe(true);
      expect(r.provider).toBe('unknown');
    } finally {
      if (prev !== undefined) process.env.MINIMAX_API_KEY = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Soft budget meter — records, never throws
// ---------------------------------------------------------------------------

describe('runAgent — soft budget meter', () => {
  it('accumulates cost across steps and surfaces it AFTER drain', async () => {
    streamTextMock.mockImplementation((opts: Record<string, unknown>) => {
      const onStepFinish = opts.onStepFinish as (s: unknown) => void;
      // M3: $0.50/1M in, $2.00/1M out. 1M in + 0.5M out = $1.50; ×2 steps = $3.00.
      onStepFinish(makeStep({ inputTokens: 1_000_000, outputTokens: 500_000 }));
      onStepFinish(makeStep({ inputTokens: 1_000_000, outputTokens: 500_000 }));
      return {
        fullStream: asyncIterable([
          { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: { inputTokens: 2_000_000, outputTokens: 1_000_000, totalTokens: 3_000_000 } } as TextStreamPart<ToolSet>,
        ]),
      };
    });
    const handle = await runAgent({ ...baseInput, softBudgetUsd: 0.5 });
    if (!isHandle(handle)) throw new Error('expected a handle');
    await drain(handle);
    handle.dispose();
    expect(handle.cost()).toBeCloseTo(3.0, 4);
    // The soft budget ($0.50) was crossed but the stream still drained fully.
    expect(handle.budgetCrossed()).toBe(true);
    expect(handle.tokensUsed()).toEqual({ input: 2_000_000, output: 1_000_000 });
  });

  it('does NOT mark budgetCrossed when no soft budget is set, even on a big run', async () => {
    streamTextMock.mockImplementation((opts: Record<string, unknown>) => {
      const onStepFinish = opts.onStepFinish as (s: unknown) => void;
      onStepFinish(makeStep({ inputTokens: 5_000_000, outputTokens: 5_000_000 }));
      return {
        fullStream: asyncIterable([
          { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: { inputTokens: 5_000_000, outputTokens: 5_000_000, totalTokens: 10_000_000 } } as TextStreamPart<ToolSet>,
        ]),
      };
    });
    const handle = await runAgent(baseInput);
    if (!isHandle(handle)) throw new Error('expected a handle');
    await drain(handle);
    handle.dispose();
    expect(handle.budgetCrossed()).toBe(false);
    expect(handle.cost()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// onChunk telemetry
// ---------------------------------------------------------------------------

describe('runAgent — onChunk', () => {
  it('fires onChunk for every part and a throwing callback never breaks the stream', async () => {
    streamTextMock.mockImplementation(() => ({
      fullStream: asyncIterable([
        { type: 'text-delta', id: 't1', text: 'a' } as TextStreamPart<ToolSet>,
        { type: 'text-delta', id: 't1', text: 'b' } as TextStreamPart<ToolSet>,
      ]),
    }));
    const seen: string[] = [];
    const handle = await runAgent({
      ...baseInput,
      onChunk: (p) => {
        seen.push(p.type);
        throw new Error('boom'); // must be swallowed
      },
    });
    if (!isHandle(handle)) throw new Error('expected a handle');
    const parts = await drain(handle);
    handle.dispose();
    expect(seen).toEqual(['text-delta', 'text-delta']);
    expect(parts.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildSystem — identical assembly, fed by characterId (not a brief)
// ---------------------------------------------------------------------------

describe('buildSystem', () => {
  it('assembles AGENT.md + canon + Element lock for the default character', async () => {
    const { loadAgentInstructions } = await import('@/lib/agent-loop/agent-md');
    const system = await buildSystem('kael', await loadAgentInstructions());
    expect(system).toMatch(/AIart4never Studio agent/i);
    expect(system).toMatch(/Master4never \(Kael\)/);
    expect(system).toMatch(/show_reference_elements/);
    expect(system).not.toMatch(/<<<[0-9a-f-]+>>>/i);
    expect(system).not.toMatch(/Director plan \(executed in this order/i);
  });
});

// ---------------------------------------------------------------------------
// makeThinkStripTransform — stateful, buffers across deltas
// ---------------------------------------------------------------------------

describe('makeThinkStripTransform', () => {
  /** Push deltas through a fresh transform and collect the visible text. */
  async function runDeltas(deltas: string[]): Promise<string> {
    const factory = makeThinkStripTransform();
    const ts = factory();
    const reader = ts.readable.getReader();
    const writer = ts.writable.getWriter();
    let out = '';
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === 'text-delta') out += value.text;
      }
    })();
    for (let i = 0; i < deltas.length; i++) {
      await writer.write({ type: 'text-delta', id: 't', text: deltas[i] } as TextStreamPart<ToolSet>);
    }
    await writer.close();
    await pump;
    return out;
  }

  it('strips a think block contained in one delta', async () => {
    expect(await runDeltas(['<think>secret</think>Hello'])).toBe('Hello');
  });

  it('strips a think block split across multiple deltas', async () => {
    expect(await runDeltas(['<thi', 'nk>rea', 'soning</thi', 'nk>Reply'])).toBe('Reply');
  });

  it('keeps text emitted before the think block', async () => {
    expect(await runDeltas(['Hi ', '<think>x</think>', ' there'])).toBe('Hi  there');
  });

  it('holds back a trailing partial open tag until refuted', async () => {
    // The "<th" looks like a partial <think>; the next delta refutes it.
    expect(await runDeltas(['Hi <th', 'is is fine'])).toBe('Hi <this is fine');
  });

  it('drops an unterminated think block on flush', async () => {
    expect(await runDeltas(['before <think>never closes'])).toBe('before ');
  });

  it('passes through non-think text unchanged (stray < and brackets)', async () => {
    expect(await runDeltas(['1 < 2 and <b>bold</b>'])).toBe('1 < 2 and <b>bold</b>');
  });

  it('passes tool-call / finish parts through untouched', async () => {
    const factory = makeThinkStripTransform();
    const ts = factory();
    const reader = ts.readable.getReader();
    const writer = ts.writable.getWriter();
    const types: string[] = [];
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        types.push(value.type);
      }
    })();
    await writer.write({ type: 'tool-call', toolCallId: 'tc1', toolName: 'generate_image', input: {} } as unknown as TextStreamPart<ToolSet>);
    await writer.write({ type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as TextStreamPart<ToolSet>);
    await writer.close();
    await pump;
    expect(types).toEqual(['tool-call', 'finish']);
  });
});
