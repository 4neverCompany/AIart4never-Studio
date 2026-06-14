/**
 * 4NE-21 / Story 1.5: streaming-route token-usage emission.
 *
 * The streaming path of `/api/ai/prompt` asks MiniMax for a terminal usage
 * chunk (`stream_options: { include_usage: true }`). When MiniMax honours
 * it, the route must re-emit ONE extra SSE event
 * `data: {"usage":{"input":..,"output":..}}` before `[DONE]`, without
 * disturbing the existing `{text:...}` delta path. When MiniMax does NOT
 * send a usage chunk (best-effort), the route must emit no usage event.
 *
 * We mock global fetch to return a canned MiniMax SSE body so no network /
 * real provider is touched. The request body is asserted to carry the
 * include_usage flag.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST as promptPost } from '@/app/api/ai/prompt/route';

function makePost(body: unknown): Request {
  return new Request('http://x/api/ai/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Build a ReadableStream<Uint8Array> from raw SSE text. */
function sseBody(raw: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(raw));
      controller.close();
    },
  });
}

/** Read the whole SSE Response into a single string. */
async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

beforeEach(() => {
  process.env.MINIMAX_API_KEY = 'sk-test-fake';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MINIMAX_API_KEY;
  delete process.env.VERCEL_AI_MODEL;
});

describe('POST /api/ai/prompt — streaming usage (4NE-21)', () => {
  it('emits a usage SSE event when MiniMax returns a usage chunk, before [DONE]', async () => {
    // Canned MiniMax SSE: two text deltas, then the terminal usage chunk
    // (empty choices + usage), then [DONE].
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] })}`,
      '',
      `data: ${JSON.stringify({ choices: [{ delta: { content: ' world' } }] })}`,
      '',
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 321, completion_tokens: 123, total_tokens: 444 } })}`,
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');

    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(sseBody(body), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await promptPost(makePost({ message: 'hi', mode: 'chat' }));
    expect(res.status).toBe(200);
    const text = await drain(res);

    // The request body must carry include_usage.
    const init = fetchMock.mock.calls[0]?.[1];
    const sentBody = JSON.parse(String(init?.body)) as {
      stream_options?: { include_usage?: boolean };
    };
    expect(sentBody.stream_options?.include_usage).toBe(true);

    // The text deltas still flow.
    expect(text).toContain('"text":"Hello"');
    expect(text).toContain('"text":" world"');

    // Exactly one usage event, carrying the mapped { input, output }.
    const usageEvents = text
      .split('\n\n')
      .map((b) => b.replace(/^data:\s*/, '').trim())
      .filter((p) => p && p !== '[DONE]')
      .map((p) => {
        try {
          return JSON.parse(p) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((o): o is Record<string, unknown> => !!o && 'usage' in o);

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].usage).toEqual({ input: 321, output: 123 });

    // The usage event precedes the terminal [DONE].
    expect(text.indexOf('"usage"')).toBeLessThan(text.lastIndexOf('[DONE]'));
  });

  it('emits NO usage event when MiniMax omits the usage chunk (best-effort)', async () => {
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'only text' } }] })}`,
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(sseBody(body), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      ),
    );

    const res = await promptPost(makePost({ message: 'hi', mode: 'chat' }));
    const text = await drain(res);
    expect(text).toContain('"text":"only text"');
    expect(text).not.toContain('"usage"');
    expect(text).toContain('[DONE]');
  });
});
