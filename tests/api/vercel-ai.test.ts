/**
 * vercel-ai route tests — `app/api/ai/prompt` (LLM-INTEGRATION-0513).
 *
 * 0513-CONSOLIDATION: the v1.0 chain was MiniMax → OpenAI → Anthropic →
 * OpenRouter. Post-v1.0 cleanup cuts the secondary providers; the route
 * now resolves {MiniMax, OpenAI} only. These tests pin that contract.
 *
 * What we cover:
 *   1. resolveProvider() priority — MiniMax wins when both keys are
 *      present (project convention — MiniMax is the default).
 *   2. POST /api/ai/prompt returns 503 when no API key is configured
 *      with the new simpler error message.
 *   3. POST /api/ai/prompt 400s on missing/empty `message` (unchanged
 *      behaviour from the v1.0 cut).
 *   4. POST /api/ai/prompt streams SSE chunks in our wire format
 *      (`data: {"text":"<delta>"}\n\n` + `data: [DONE]\n\n`) when
 *      MiniMax is configured — exercises the MiniMax chat-completions
 *      direct-fetch branch.
 *   5. POST /api/ai/prompt picks OpenAI when only OPENAI_API_KEY is
 *      set — exercises the ai-sdk `streamText` branch and verifies
 *      the `X-AI-Provider: openai` response header.
 *   6. POST /api/ai/prompt honours the `model` body field as the
 *      top-priority model override (over VERCEL_AI_MODEL env and
 *      per-provider defaults).
 *
 * What we don't cover:
 *   - Anthropic / OpenRouter paths — those providers were removed.
 *     The test would have to mock @ai-sdk/anthropic.createAnthropic
 *     which is no longer in the dep graph; the spec stays as a
 *     regression guard for the chain shape.
 *   - Web-search enrichment (mode === 'idea' / 'chat') — best-effort
 *     network calls, mocked at a different layer. Not in scope for
 *     the chain-shape regression.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

// Mock the ai SDK's `streamText` so we don't need real provider creds.
// The MiniMax branch bypasses streamText entirely (chat-completions
// direct fetch), so we only mock this for the OpenAI path.
const streamTextMock = vi.fn();
vi.mock('ai', () => ({
  streamText: (args: unknown) => streamTextMock(args),
}));

// Mock @ai-sdk/openai.createOpenAI so the route gets a stub language
// model that doesn't try to reach the network for the OpenAI branch.
const openaiModelStub = vi.fn();
const openaiClientStub = vi.fn(() => openaiModelStub);
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: (config: unknown) => {
    // Capture the config so tests can assert baseURL behaviour.
    openaiClientStub.mockReturnValue(openaiModelStub);
    return (modelId: string) => {
      // Return a tagged object — vercel-ai's streamText accepts any
      // LanguageModelV1. We don't pass it to the real SDK in tests
      // because streamText itself is mocked.
      return { provider: 'openai-stub', modelId, config };
    };
  },
}));

// Capture the env keys we set per-test. We restore them after each
// test so the test order doesn't matter.
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Reset env to a known baseline before each test.
  process.env = { ...ORIGINAL_ENV };
  delete process.env.MINIMAX_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.VERCEL_AI_MODEL;
  delete process.env.MINIMAX_API_BASE_URL;
  streamTextMock.mockReset();
  openaiClientStub.mockClear();
  openaiModelStub.mockClear();

  // Default: streamText returns an object whose textStream is an async
  // iterable of text deltas — mirrors the real SDK's return shape.
  streamTextMock.mockImplementation(() => ({
    textStream: (async function* () {
      yield 'hello ';
      yield 'world';
    })(),
  }));

  // Default global fetch mock — the MiniMax branch reads SSE from
  // a fake chat-completions response. Individual tests override this
  // with the SSE payload they want.
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

// Helper: drain a ReadableStream<Uint8Array> Response into a string.
async function readSse(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
   
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe('POST /api/ai/prompt — chain shape (0513-CONSOLIDATION)', () => {
  it('rejects the request with 503 + new error message when no API key is configured', async () => {
    // POST the handler directly (no fetch round-trip — the route is a
    // pure function of the Request + env). Default env above has no
    // LLM keys.
    const { POST } = await import('@/app/api/ai/prompt/route');
    const res = await POST(
      new Request('http://x/api/ai/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      }),
    );
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toContain('MINIMAX_API_KEY');
    expect(json.error).toContain('OPENAI_API_KEY');
    // Regression guard — the v1.0 error string also mentioned
    // ANTHROPIC / OPENROUTER. Post-trim the message must NOT list
    // the removed providers.
    expect(json.error).not.toContain('ANTHROPIC');
    expect(json.error).not.toContain('OPENROUTER');
  });

  it('400s on missing message', async () => {
    const { POST } = await import('@/app/api/ai/prompt/route');
    const res = await POST(
      new Request('http://x/api/ai/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400s on whitespace-only message', async () => {
    const { POST } = await import('@/app/api/ai/prompt/route');
    const res = await POST(
      new Request('http://x/api/ai/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '   \n  ' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400s on invalid JSON body', async () => {
    const { POST } = await import('@/app/api/ai/prompt/route');
    const res = await POST(
      new Request('http://x/api/ai/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json{',
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/ai/prompt — provider resolution', () => {
  it('picks MiniMax when MINIMAX_API_KEY is set (default chain priority)', async () => {
    process.env.MINIMAX_API_KEY = 'test-minimax-key';
    // Mock fetch for the MiniMax chat-completions direct path.
    const ssePayload =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: [DONE]\n\n';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(makeSseStream(ssePayload), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    const { POST } = await import('@/app/api/ai/prompt/route');
    const res = await POST(
      new Request('http://x/api/ai/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'ping' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-AI-Provider')).toBe('minimax');
    // The fetch URL should be the MiniMax Chat Completions endpoint,
    // not the ai SDK's /v1/responses path that openai-sdk v6 normally
    // targets (which MiniMax doesn't implement).
    const fetchUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(fetchUrl).toContain('/v1/chat/completions');
  });

  it('falls back to OpenAI when only OPENAI_API_KEY is set (no MiniMax)', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';

    const { POST } = await import('@/app/api/ai/prompt/route');
    const res = await POST(
      new Request('http://x/api/ai/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'ping' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-AI-Provider')).toBe('openai');
    expect(res.headers.get('X-AI-Model')).toBe('gpt-4o-mini');
    // The OpenAI branch should use the ai SDK's streamText, not the
    // direct fetch path. So fetch must NOT be called.
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(streamTextMock).toHaveBeenCalledOnce();
  });

  it('falls back to OpenAI when both keys are set (MiniMax wins, then OpenAI)', async () => {
    process.env.MINIMAX_API_KEY = 'test-minimax-key';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    const ssePayload =
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n' +
      'data: [DONE]\n\n';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(makeSseStream(ssePayload), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    const { POST } = await import('@/app/api/ai/prompt/route');
    const res = await POST(
      new Request('http://x/api/ai/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'ping' }),
      }),
    );
    expect(res.headers.get('X-AI-Provider')).toBe('minimax');
  });

  it('honours the `model` body field as the top-priority model override', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.VERCEL_AI_MODEL = 'env-override';

    const { POST } = await import('@/app/api/ai/prompt/route');
    const res = await POST(
      new Request('http://x/api/ai/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'ping', model: 'gpt-4o-mini-custom' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-AI-Model')).toBe('gpt-4o-mini-custom');
  });

  it('falls back to VERCEL_AI_MODEL env when no per-request model is set', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.VERCEL_AI_MODEL = 'env-model';

    const { POST } = await import('@/app/api/ai/prompt/route');
    const res = await POST(
      new Request('http://x/api/ai/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'ping' }),
      }),
    );
    expect(res.headers.get('X-AI-Model')).toBe('env-model');
  });
});

describe('POST /api/ai/prompt — SSE wire shape', () => {
  it('emits the standard text/event-stream contract for the MiniMax path', async () => {
    process.env.MINIMAX_API_KEY = 'test-minimax-key';
    const ssePayload =
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
      'data: [DONE]\n\n';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(makeSseStream(ssePayload), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    const { POST } = await import('@/app/api/ai/prompt/route');
    const res = await POST(
      new Request('http://x/api/ai/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'ping' }),
      }),
    );
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    const text = await readSse(res);
    // Each MiniMax chunk should be re-emitted as our own `text` event.
    expect(text).toContain('data: {"text":"hello"}');
    expect(text).toContain('data: {"text":" world"}');
    // The outer [DONE] terminator must always be present, regardless
    // of whether the upstream response included one.
    expect(text).toContain('data: [DONE]');
  });

  it('emits the standard text/event-stream contract for the OpenAI path (streamText)', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    streamTextMock.mockImplementation(() => ({
      textStream: (async function* () {
        yield 'foo';
        yield 'bar';
      })(),
    }));

    const { POST } = await import('@/app/api/ai/prompt/route');
    const res = await POST(
      new Request('http://x/api/ai/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'ping' }),
      }),
    );
    const text = await readSse(res);
    expect(text).toContain('data: {"text":"foo"}');
    expect(text).toContain('data: {"text":"bar"}');
    expect(text).toContain('data: [DONE]');
  });
});

describe('GET /api/ai/status — chain shape (0513-CONSOLIDATION)', () => {
  it('reports minimax when only MINIMAX_API_KEY is set', async () => {
    process.env.MINIMAX_API_KEY = 'k';
    const { GET } = await import('@/app/api/ai/status/route');
    const res = await GET();
    const json = (await res.json()) as {
      provider?: string;
      model?: string;
      available?: boolean;
    };
    expect(json.provider).toBe('minimax');
    // V082-CATALOG: default is now M3 (the latest generation), not
    // the legacy M2.5. The picker UI + /api/ai/models both surface
    // M3 as the current default; status reports whatever the route
    // would use.
    expect(json.model).toBe('MiniMax-M3');
    expect(json.available).toBe(true);
  });

  it('reports openai when only OPENAI_API_KEY is set', async () => {
    process.env.OPENAI_API_KEY = 'k';
    const { GET } = await import('@/app/api/ai/status/route');
    const res = await GET();
    const json = (await res.json()) as { provider?: string; model?: string };
    expect(json.provider).toBe('openai');
    expect(json.model).toBe('gpt-4o-mini');
  });

  it('reports null when no key is set (regression: never returns anthropic/openrouter)', async () => {
    const { GET } = await import('@/app/api/ai/status/route');
    const res = await GET();
    const json = (await res.json()) as { provider?: string | null };
    expect(json.provider).toBeNull();
  });
});

/**
 * Build a Response whose body is a `text/event-stream` ReadableStream
 * built from the supplied payload. Mirrors the shape of MiniMax's
 * chat-completions SSE response (each line prefixed with `data: ` and
 * terminated with `\n\n`).
 */
function makeSseStream(payload: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}
