/**
 * AGENTIC-HARNESS / STEP 3: route test for `mode:'director', stream:true,
 * agentCore:true`.
 *
 * Pins the SSE event shape the agent-core path emits — the SAME typed events
 * AgentConsole consumes, mapped from the token-level `streamText` `fullStream`:
 *   - {type:'text', text}        — token-level visible delta
 *   - {type:'tool-call'}         — tool + args + idx
 *   - {type:'tool-result'}       — tool + extracted assetRef + output + idx
 *   - {type:'done'}              — prompt (back-compat) + text + cost + runId +
 *                                  tokensUsed + truncatedBy
 *   - {type:'error'}             — no provider / hard failure
 *   terminated by `data: [DONE]`.
 *
 * `streamText` (the agent-core seam) is mocked at the `ai` module level so we
 * never hit a real LLM. The mock returns a canned `fullStream` of
 * `TextStreamPart`s and fires `onStepFinish` so the soft-budget meter records.
 * There is NO {type:'plan'} event on this path (no rigid scaffold).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { POST as promptPost } from '@/app/api/ai/prompt/route';

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, streamText: streamTextMock };
});

function makePost(body: unknown): Request {
  return new Request('http://x/api/ai/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function asyncIterable<T>(parts: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const p of parts) yield p;
    },
  };
}

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

/** Parse an SSE body into the array of decoded JSON events (drops [DONE]). */
async function readEvents(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  const events: Array<Record<string, unknown>> = [];
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    events.push(JSON.parse(data));
  }
  return events;
}

beforeEach(() => {
  streamTextMock.mockReset();
  process.env.MINIMAX_API_KEY = 'sk-test-fake';
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.MINIMAX_API_KEY;
});

describe('POST /api/ai/prompt — agent-core STREAM mode', () => {
  it('maps the fullStream parts to text/tool-call/tool-result/done SSE events', async () => {
    let captured: Record<string, unknown> = {};
    streamTextMock.mockImplementation((opts: Record<string, unknown>) => {
      captured = opts;
      const onStepFinish = opts.onStepFinish as ((s: unknown) => void) | undefined;
      onStepFinish?.(makeStep({ inputTokens: 100, outputTokens: 50 }));
      return {
        fullStream: asyncIterable([
          { type: 'text-delta', id: 't1', text: 'Forging ' },
          { type: 'text-delta', id: 't1', text: 'the beat.' },
          {
            type: 'tool-result',
            toolCallId: 'tc0',
            toolName: 'generate_prompt',
            input: {},
            output: { draft: 'A long on-canon scene draft for the variant reveal.' },
          },
          {
            type: 'tool-call',
            toolCallId: 'tc1',
            toolName: 'generate_image',
            input: { model: 'nano_banana_2' },
          },
          {
            type: 'tool-result',
            toolCallId: 'tc1',
            toolName: 'generate_image',
            input: { model: 'nano_banana_2' },
            output: { assetRef: { provider: 'higgsfield', id: 'job_1', url: 'https://img.example/1.png' }, creditsCharged: 4 },
          },
          { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } },
        ]),
      };
    });

    const res = await promptPost(
      makePost({
        mode: 'director',
        stream: true,
        agentCore: true,
        messages: [{ role: 'user', content: 'Forge a Kael variant reveal' }],
        userId: 'agent-console',
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/event-stream/);

    // Drain the SSE body FIRST — the ReadableStream's start() (which calls the
    // mocked streamText) runs lazily, only once the body is consumed.
    const events = await readEvents(res);

    // The agent-core seam received messages-in (no brief / prompt field).
    expect(captured.messages).toEqual([{ role: 'user', content: 'Forge a Kael variant reveal' }]);
    expect(captured.prompt).toBeUndefined();

    // Token-level text deltas pass straight through.
    const textEvents = events.filter((e) => e.type === 'text');
    expect(textEvents.map((e) => e.text)).toEqual(['Forging ', 'the beat.']);

    // tool-call event for generate_image carrying its args.
    const toolCall = events.find((e) => e.type === 'tool-call' && e.tool === 'generate_image');
    expect(toolCall).toBeDefined();
    expect((toolCall!.args as Record<string, unknown>).model).toBe('nano_banana_2');

    // tool-result event with the extracted AssetRef.
    const toolResult = events.find((e) => e.type === 'tool-result' && e.tool === 'generate_image');
    expect(toolResult).toBeDefined();
    expect(toolResult!.assetRef).toEqual({ provider: 'higgsfield', id: 'job_1', url: 'https://img.example/1.png' });

    // Terminal done event: prompt (back-compat draft) + text (accumulated) + cost + runId.
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect(done!.prompt).toBe('A long on-canon scene draft for the variant reveal.');
    expect(done!.text).toBe('Forging the beat.');
    expect(typeof done!.cost).toBe('number');
    expect(String(done!.runId)).toMatch(/^run_/);
    expect(done!.truncatedBy).toBe('natural');
    expect(done!.tokensUsed).toEqual({ input: 100, output: 50 });

    // NO plan event on the agent-core path (no rigid scaffold).
    expect(events.some((e) => e.type === 'plan')).toBe(false);
  });

  it('emits a single error event when no AI provider is configured', async () => {
    delete process.env.MINIMAX_API_KEY;
    const res = await promptPost(
      makePost({
        mode: 'director',
        stream: true,
        agentCore: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    );
    expect(res.status).toBe(200);
    const events = await readEvents(res);
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect(String(err!.error)).toMatch(/No AI provider configured/);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('emits an error event when messages is missing', async () => {
    const res = await promptPost(
      makePost({ mode: 'director', stream: true, agentCore: true }),
    );
    expect(res.status).toBe(200);
    const events = await readEvents(res);
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect(String(err!.error)).toMatch(/messages is required/);
  });

  it('reports a crossed soft budget as truncatedBy:soft_budget without stopping the stream', async () => {
    streamTextMock.mockImplementation((opts: Record<string, unknown>) => {
      const onStepFinish = opts.onStepFinish as (s: unknown) => void;
      // M3: $0.50/1M in, $2.00/1M out → 1M in + 0.5M out = $1.50/step > $0.50.
      onStepFinish(makeStep({ inputTokens: 1_000_000, outputTokens: 500_000 }));
      return {
        fullStream: asyncIterable([
          { type: 'text-delta', id: 't1', text: 'done' },
          { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: { inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 } },
        ]),
      };
    });
    const res = await promptPost(
      makePost({
        mode: 'director',
        stream: true,
        agentCore: true,
        messages: [{ role: 'user', content: 'spendy' }],
        budgetUsd: 0.5,
      }),
    );
    const events = await readEvents(res);
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect(done!.truncatedBy).toBe('soft_budget');
    expect((done!.cost as number)).toBeGreaterThan(0.5);
    // The stream still fully drained (the visible text arrived).
    expect(events.some((e) => e.type === 'text' && e.text === 'done')).toBe(true);
  });
});
