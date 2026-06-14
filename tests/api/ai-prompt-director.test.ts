/**
 * v1.2.2-DIRECTOR: route tests for `mode: 'director'`.
 *
 * Pins the wire shape that the Studio frontend will consume:
 *   - 400 on missing fields
 *   - 200 on a happy-path Director run (mocked ToolLoopAgent)
 *   - 503 when no AI provider is configured
 *   - The 200 body must contain {prompt, steps, cost, runId,
 *     modelId, provider, truncatedBy}
 *   - The 200 headers must include X-Director-Run-Id,
 *     X-AI-Provider, X-AI-Model
 *
 * The AI SDK is mocked at the `ai` module level so we
 * never hit a real LLM. v1.2.6: we now mock
 * `ToolLoopAgent.prototype.generate` (replaces the bare
 * `generateText` mock from v1.2.0-v1.2.5). The mock
 * simulates two `onStepFinish` events (trending_search,
 * generate_prompt) and returns a `text` value that becomes
 * the `finalPrompt`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { POST as promptPost } from '@/app/api/ai/prompt/route';

const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  // v1.2.6: stub ToolLoopAgent so the route's
  // `new ToolLoopAgent(...).generate(...)` chain ends in
  // our vi.fn(). The class has to be `new`-callable; the
  // stub ignores all constructor args (model / tools /
  // stopWhen) because the test never depends on them.
  class StubToolLoopAgent {
    constructor(_opts: unknown) {
      // ignore
    }
    generate = generateTextMock;
  }
  return {
    ...actual,
    ToolLoopAgent: StubToolLoopAgent,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePost(body: unknown): Request {
  return new Request('http://x/api/ai/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeMockStepResult(args: {
  stepNumber: number;
  text?: string;
  toolName?: string;
  toolOutput?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
  finishReason?: string;
}) {
  return {
    stepNumber: args.stepNumber,
    model: { provider: 'mock', modelId: 'MiniMax-M3' },
    content: args.text ? [{ type: 'text', text: args.text }] : [],
    text: args.text ?? '',
    reasoning: [],
    reasoningText: undefined,
    files: [],
    sources: [],
    toolCalls: args.toolName
      ? [{
          type: 'tool-call',
          toolCallId: `tc_${args.stepNumber}`,
          toolName: args.toolName,
          input: {},
          dynamic: false,
        }]
      : [],
    staticToolCalls: [],
    dynamicToolCalls: [],
    toolResults: args.toolName
      ? [{
          type: 'tool-result',
          toolCallId: `tc_${args.stepNumber}`,
          toolName: args.toolName,
          input: {},
          output: args.toolOutput,
          dynamic: false,
        }]
      : [],
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
      totalTokens: (args.usage?.inputTokens ?? 0) + (args.usage?.outputTokens ?? 0),
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

beforeEach(() => {
  generateTextMock.mockReset();
  process.env.MINIMAX_API_KEY = 'sk-test-fake';
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.MINIMAX_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('POST /api/ai/prompt — director mode', () => {
  it('returns the canonical {prompt, steps, cost, runId, modelId, provider, truncatedBy} shape', async () => {
    generateTextMock.mockImplementation(async (opts: { onStepFinish?: (s: unknown) => Promise<void> | void }) => {
      const s0 = makeMockStepResult({
        stepNumber: 0,
        toolName: 'trending_search',
        toolOutput: { results: [], nichesWithHits: ['Marvel'], servedBy: 'camofox' },
        usage: { inputTokens: 50, outputTokens: 10 },
      });
      await opts.onStepFinish?.(s0);
      const s1 = makeMockStepResult({
        stepNumber: 1,
        text: 'Iron Vader in neon rain…',
        toolName: 'generate_prompt',
        toolOutput: { draft: 'Iron Vader in neon rain…', usedSkills: [], modelId: 'MiniMax-M3' },
        usage: { inputTokens: 100, outputTokens: 40 },
      });
      await opts.onStepFinish?.(s1);
      return { text: 'Iron Vader in neon rain…', steps: [s0, s1], finishReason: 'stop' };
    });

    const res = await promptPost(
      makePost({
        mode: 'director',
        ideaConcept: 'Darth Vader in Iron Man suit',
        niches: ['Multiverse Crossovers'],
        genres: ['Noir & Gritty'],
        userId: 'studio_test_user',
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.prompt).toBe('Iron Vader in neon rain…');
    expect(Array.isArray(body.steps)).toBe(true);
    expect((body.steps as unknown[]).length).toBeGreaterThan(0);
    expect(typeof body.cost).toBe('number');
    expect(typeof body.runId).toBe('string');
    expect((body.runId as string).startsWith('run_')).toBe(true);
    expect(body.modelId).toBe('MiniMax-M3');
    expect(body.provider).toBe('minimax');
    expect(body.truncatedBy).toBe('natural');
  });

  it('exposes X-Director-Run-Id, X-AI-Provider, X-AI-Model headers', async () => {
    generateTextMock.mockImplementation(async () => {
      return { text: 'final', steps: [], finishReason: 'stop' };
    });
    const res = await promptPost(
      makePost({
        mode: 'director',
        ideaConcept: 'Darth Vader in Iron Man suit',
        niches: ['Marvel'],
      }),
    );
    expect(res.headers.get('X-Director-Run-Id')).toMatch(/^run_/);
    expect(res.headers.get('X-AI-Provider')).toBe('minimax');
    expect(res.headers.get('X-AI-Model')).toBe('MiniMax-M3');
  });

  it('records the plan step as the first entry in the step log', async () => {
    generateTextMock.mockImplementation(async () => {
      return { text: 'final', steps: [], finishReason: 'stop' };
    });
    const res = await promptPost(
      makePost({
        mode: 'director',
        ideaConcept: 'Darth Vader in Iron Man suit',
        niches: ['Marvel'],
      }),
    );
    const body = (await res.json()) as { steps: Array<{ idx: number; type: string }> };
    expect(body.steps[0]?.type).toBe('plan');
    expect(body.steps[0]?.idx).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe('POST /api/ai/prompt — director mode validation', () => {
  it('returns 400 when ideaConcept is missing', async () => {
    const res = await promptPost(
      makePost({ mode: 'director', niches: ['Marvel'] }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/ideaConcept/);
  });

  it('returns 400 when niches is missing', async () => {
    const res = await promptPost(
      makePost({ mode: 'director', ideaConcept: 'x' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/niches/);
  });

  it('returns 400 when niches is an empty array', async () => {
    const res = await promptPost(
      makePost({ mode: 'director', ideaConcept: 'x', niches: [] }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when niches contains only empty strings', async () => {
    const res = await promptPost(
      makePost({ mode: 'director', ideaConcept: 'x', niches: ['', '   '] }),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// No-provider error
// ---------------------------------------------------------------------------

describe('POST /api/ai/prompt — director mode no provider', () => {
  it('returns 503 when no AI provider is configured', async () => {
    delete process.env.MINIMAX_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const res = await promptPost(
      makePost({
        mode: 'director',
        ideaConcept: 'Darth Vader in Iron Man suit',
        niches: ['Marvel'],
      }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/No AI provider configured/);
  });
});

// ---------------------------------------------------------------------------
// Provider error surfacing (M1.1) — a configured provider that errors out
// must NOT return a silent 200 {prompt:''}; it returns a 502 carrying the
// loop's real error message so the UI can show what actually failed.
// ---------------------------------------------------------------------------

describe('POST /api/ai/prompt — director mode provider error', () => {
  it('returns 502 when the model finalizes with the DIRECTOR_FAILED sentinel', async () => {
    // The system prompt instructs the model to finalize unrecoverable
    // tool failures with "DIRECTOR_FAILED: <reason>". Such a run ends
    // "naturally" (finishReason stop, non-empty text) — the route must
    // still refuse to hand it to the client as a usable prompt.
    generateTextMock.mockImplementation(async () => {
      return {
        text: 'DIRECTOR_FAILED: trending_search unavailable after two attempts.',
        steps: [],
        finishReason: 'stop',
      };
    });

    const res = await promptPost(
      makePost({
        mode: 'director',
        ideaConcept: 'Darth Vader in Iron Man suit',
        niches: ['Marvel'],
      }),
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Director failed/);
    expect(body.error).toMatch(/trending_search unavailable/);
  });

  it('returns 502 with the real error when the provider throws and no prompt is produced', async () => {
    generateTextMock.mockImplementation(async () => {
      // Simulate a provider failure (e.g. MiniMax 404 on a bad
      // model id / Responses-API mismatch). The loop catches this,
      // records an `error` step, and returns an empty finalPrompt.
      throw new Error('MiniMax 404: model not found');
    });

    const res = await promptPost(
      makePost({
        mode: 'director',
        ideaConcept: 'Darth Vader in Iron Man suit',
        niches: ['Marvel'],
      }),
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: string;
      provider: string;
      truncatedBy: string;
    };
    expect(body.error).toMatch(/Director failed/);
    expect(body.error).toMatch(/MiniMax 404/);
    expect(body.provider).toBe('minimax');
    expect(body.truncatedBy).toBe('error');
    // The run id is still exposed so the client can fetch the step log.
    expect(res.headers.get('X-Director-Run-Id')).toMatch(/^run_/);
  });
});
