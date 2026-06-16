/**
 * AGENTIC-CORE / PHASE 1: route test for `mode:'director', stream:true`.
 *
 * Pins the SSE EVENT SHAPE the agentic chat console consumes. Unlike the
 * default director path (one JSON envelope), the stream path forwards the
 * loop's onStep events:
 *   - {type:'text'}        — plan / final reasoning
 *   - {type:'tool-call'}   — tool + args
 *   - {type:'tool-result'} — tool + extracted assetRef
 *   - {type:'done'}        — final prompt + cost + runId + truncatedBy
 *   - {type:'error'}       — hard failure / no provider
 *   terminated by `data: [DONE]`.
 *
 * The AI SDK is mocked at the `ai` module level (same StubToolLoopAgent shape
 * as ai-prompt-director.test.ts) so we never hit a real LLM. The mock fires
 * two onStepFinish events (generate_prompt, generate_image → an AssetRef) and
 * returns a final text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { POST as promptPost } from '@/app/api/ai/prompt/route';

const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  class StubToolLoopAgent {
    constructor(_opts: unknown) {
      // ignore
    }
    generate = generateTextMock;
  }
  return { ...actual, ToolLoopAgent: StubToolLoopAgent };
});

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
  toolInput?: unknown;
  toolOutput?: unknown;
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
      ? [{ type: 'tool-call', toolCallId: `tc_${args.stepNumber}`, toolName: args.toolName, input: args.toolInput ?? {}, dynamic: false }]
      : [],
    staticToolCalls: [],
    dynamicToolCalls: [],
    toolResults: args.toolName
      ? [{ type: 'tool-result', toolCallId: `tc_${args.stepNumber}`, toolName: args.toolName, input: args.toolInput ?? {}, output: args.toolOutput, dynamic: false }]
      : [],
    staticToolResults: [],
    dynamicToolResults: [],
    finishReason: args.finishReason ?? 'stop',
    rawFinishReason: args.finishReason ?? 'stop',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      totalTokens: 15,
    },
    warnings: undefined,
    request: { body: undefined },
    response: { id: `resp_${args.stepNumber}`, timestamp: new Date(), modelId: 'MiniMax-M3', headers: undefined, messages: [] },
    providerMetadata: undefined,
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
  generateTextMock.mockReset();
  process.env.MINIMAX_API_KEY = 'sk-test-fake';
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.MINIMAX_API_KEY;
});

describe('POST /api/ai/prompt — director STREAM mode', () => {
  it('streams tool-call + tool-result(assetRef) + done events as SSE', async () => {
    generateTextMock.mockImplementation(async (opts: { onStepFinish?: (s: unknown) => Promise<void> | void }) => {
      const s0 = makeMockStepResult({
        stepNumber: 0,
        toolName: 'critique_prompt',
        toolInput: { prompt: 'a long enough canon scene draft for the variant reveal beat', requirements: { niches: ['Variant Reveal'], angle: 'Kael steps through a reality rift' } },
        toolOutput: { score: 0.82, issues: [] },
      });
      await opts.onStepFinish?.(s0);
      const s1 = makeMockStepResult({
        stepNumber: 1,
        text: 'Forging the beat.',
        toolName: 'generate_image',
        toolInput: { model: 'nano_banana_2' },
        toolOutput: { assetRef: { provider: 'higgsfield', id: 'job_1', url: 'https://img.example/1.png' }, creditsCharged: 4 },
      });
      await opts.onStepFinish?.(s1);
      return { text: 'Final on-canon prompt for the reveal.', steps: [s0, s1], finishReason: 'stop' };
    });

    const res = await promptPost(
      makePost({
        mode: 'director',
        stream: true,
        ideaConcept: 'Kael steps through a reality rift',
        niches: ['Variant Reveal'],
        genres: ['Cinematic'],
        userId: 'agent-console',
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/event-stream/);

    const events = await readEvents(res);
    const types = events.map((e) => e.type);

    // A tool-call event for generate_image carrying its args.
    const toolCall = events.find((e) => e.type === 'tool-call' && e.tool === 'generate_image');
    expect(toolCall).toBeDefined();
    expect((toolCall!.args as Record<string, unknown>).model).toBe('nano_banana_2');

    // A tool-result event with the extracted AssetRef.
    const toolResult = events.find((e) => e.type === 'tool-result' && e.tool === 'generate_image');
    expect(toolResult).toBeDefined();
    expect(toolResult!.assetRef).toEqual({ provider: 'higgsfield', id: 'job_1', url: 'https://img.example/1.png' });

    // A terminal done event with the final prompt + cost + runId.
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect(done!.prompt).toBe('Final on-canon prompt for the reveal.');
    expect(typeof done!.cost).toBe('number');
    expect(String(done!.runId)).toMatch(/^run_/);
    expect(done!.truncatedBy).toBe('natural');

    // AGENT.md REWIRE: the chat/stream path is an AGENT.md-driven agent — there
    // is NO rigid director-plan scaffold on the stream at all. The
    // conversational loop skips the pre-baked plan step entirely, so no
    // {type:'plan'} event is emitted, and the scaffold can never leak as text.
    const planEvents = events.filter((e) => e.type === 'plan');
    expect(planEvents.length).toBe(0);
    expect(types).not.toContain('plan');
    const planLeakedAsText = events.some(
      (e) =>
        e.type === 'text' &&
        (e.stepType === 'plan' ||
          /Director plan \(executed in this order/i.test(String(e.text ?? ''))),
    );
    expect(planLeakedAsText).toBe(false);
  });

  it('CHAT PATH: system prompt = AGENT.md + canon (no rigid scaffold) + the RAW operator message as the user turn', async () => {
    let captured: { system?: string; prompt?: string } = {};
    generateTextMock.mockImplementation(
      async (opts: { system?: string; prompt?: string; onStepFinish?: (s: unknown) => Promise<void> | void }) => {
        captured = { system: opts.system, prompt: opts.prompt };
        const s0 = makeMockStepResult({ stepNumber: 0, text: 'hey! want me to forge a beat?' });
        await opts.onStepFinish?.(s0);
        return { text: 'hey! want me to forge a beat?', steps: [s0], finishReason: 'stop' };
      },
    );

    const res = await promptPost(
      makePost({
        mode: 'director',
        stream: true,
        ideaConcept: 'hey',
        niches: ['Story-Beat'],
        userId: 'agent-console',
      }),
    );
    expect(res.status).toBe(200);
    await readEvents(res);

    // AGENT.md REWIRE: the system prompt is the AGENT.md instruction file
    // (identity + behavior + tools) + the STRUCTURED canon block — NOT the
    // rigid 6-step director scaffold.
    expect(captured.system).toMatch(/AIart4never Studio agent/i);
    expect(captured.system).toMatch(/Master4never/);
    expect(captured.system).toMatch(/Element-anchored/i);
    // The structured canon block (default character Kael) is injected.
    expect(captured.system).toMatch(/Master4never \(Kael\)/);
    expect(captured.system).toMatch(/cyberdeck/i);
    expect(captured.system).toMatch(/<<<[0-9a-f-]+>>>/i);
    // The rigid 6-step director plan scaffold is NOT present on the chat path.
    expect(captured.system).not.toMatch(/Director plan \(executed in this order/i);
    expect(captured.system).not.toMatch(/Determine the beat/);
    expect(captured.system).not.toMatch(/Execute the director plan/i);
    // The user turn is the RAW operator message — NOT "Beat: hey … Execute the
    // director plan".
    expect(captured.prompt).toBe('hey');
    expect(captured.prompt).not.toMatch(/Execute the director plan/i);
    expect(captured.prompt).not.toMatch(/^Beat:/);
  });

  it('emits a single error event when no AI provider is configured', async () => {
    delete process.env.MINIMAX_API_KEY;
    const res = await promptPost(
      makePost({ mode: 'director', stream: true, ideaConcept: 'x concept', niches: ['Variant Reveal'] }),
    );
    expect(res.status).toBe(200);
    const events = await readEvents(res);
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect(String(err!.error)).toMatch(/No AI provider configured/);
    // No done event on the no-provider path.
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('emits an error event on a validation failure (missing niches)', async () => {
    const res = await promptPost(
      makePost({ mode: 'director', stream: true, ideaConcept: 'has concept but no niches' }),
    );
    expect(res.status).toBe(200);
    const events = await readEvents(res);
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect(String(err!.error)).toMatch(/niches/);
  });
});
