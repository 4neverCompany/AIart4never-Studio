/**
 * Higgsfield image route tests — the foundation of the generation realignment
 * (Leonardo OUT, Higgsfield IN, canon Element-anchored).
 *
 * `@/lib/mcp` is mocked so `connectMcp`/`callMcpTool` are fully controllable and
 * never hit the network (mirrors tests/lib/publish/dispatch.test.ts). The
 * MiniMax enhance fetch is mocked via `globalThis.fetch` returning an SSE stream
 * (mirrors tests/api/vercel-ai.test.ts).
 *
 * We assert (submit):
 *   - the canon `<<<element>>>` for `kael` is prepended (anchored:true) and the
 *     model + aspect_ratio are forwarded to `generate_image`,
 *   - the jobId comes from `results[0].id`,
 *   - the MCP client is ALWAYS closed (success AND tool-error),
 *   - a missing connector → 400 ("Add a Higgsfield connector in Customize"),
 *   - a missing MINIMAX_API_KEY → 503,
 *   - skipEnhance bypasses MiniMax (no fetch),
 *   - a tool error surfaces as 502,
 *   - the submitted model is reported (NOT the server's nano_banana_flash remap).
 * And (poll):
 *   - `parseJobDisplay` maps `results[0].results.{rawUrl,minUrl}` when completed,
 *   - an invalid job id → 400, a missing connector → 400.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- mock the MCP primitive --------------------------------------------------
const connectSpy = vi.fn();
const callMcpToolSpy = vi.fn();
const closeSpy = vi.fn();

// A minimal McpError stand-in so the route's `instanceof McpError` checks work.
// Defined INSIDE the vi.mock factory (the call is hoisted above module top-level
// declarations, so it can't reference an outer class). Re-derived below for the
// tests via a local copy with the identical prototype chain.
vi.mock('@/lib/mcp', () => {
  class McpError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'McpError';
      this.code = code;
      Object.setPrototypeOf(this, McpError.prototype);
    }
  }
  return {
    connectMcp: (...args: unknown[]) => connectSpy(...args),
    callMcpTool: (...args: unknown[]) => callMcpToolSpy(...args),
    McpError,
  };
});

import { POST } from '@/app/api/higgsfield/image/route';
import { GET } from '@/app/api/higgsfield/image/[id]/route';
import { getElementRef } from '@/lib/canon';
import { McpError as FakeMcpError } from '@/lib/mcp';

const ORIGINAL_ENV = { ...process.env };

const CONNECTOR = {
  id: 'hf-1',
  name: 'Higgsfield',
  transport: 'http' as const,
  url: 'https://higgsfield.example.com/mcp',
  headers: { Authorization: 'Bearer secret' },
  enabled: true,
  trusted: true,
  addedAt: 0,
};

const JOB_ID = 'b266078a-1ceb-4938-815e-4d2c5a1d0647';

/** Build the Response whose body is a MiniMax-style SSE chat-completions stream. */
function makeSseStream(payload: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

/** Make `globalThis.fetch` (MiniMax enhance) return `enhanced` as the delta. */
function mockMinimaxReturns(enhanced: string) {
  const sse =
    `data: ${JSON.stringify({ choices: [{ delta: { content: enhanced } }] })}\n\n` +
    'data: [DONE]\n\n';
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
    new Response(makeSseStream(sse), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  );
}

/** The confirmed `generate_image` submit echo — job id at results[0].id. */
function submitEcho(id = JOB_ID) {
  return {
    results: [
      {
        id,
        type: 'image',
        status: 'pending',
        // Server remaps the requested model to its internal name in the echo.
        model: 'nano_banana_flash',
        params: { prompt: 'x', aspect_ratio: '4:5', resolution: '1k' },
      },
    ],
    adjustments: {},
  };
}

function postReq(body: Record<string, unknown>): Request {
  return new Request('http://x/api/higgsfield/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  process.env.MINIMAX_API_KEY = 'test-minimax-key';
  delete process.env.MINIMAX_API_BASE_URL;
  delete process.env.VERCEL_AI_MODEL;

  closeSpy.mockResolvedValue(undefined);
  connectSpy.mockResolvedValue({ client: { __fake: true }, close: closeSpy });
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('POST /api/higgsfield/image — submit', () => {
  it('400s on invalid JSON body', async () => {
    const res = await POST(
      new Request('http://x/api/higgsfield/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400s on missing idea', async () => {
    const res = await POST(postReq({ connector: CONNECTOR }));
    expect(res.status).toBe(400);
  });

  it('400s with the Customize hint when the connector is missing', async () => {
    const res = await POST(postReq({ idea: 'kael on a neon rooftop' }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/Higgsfield connector/i);
    // Never connected.
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('503s when MINIMAX_API_KEY is missing (enhance path)', async () => {
    delete process.env.MINIMAX_API_KEY;
    const res = await POST(postReq({ idea: 'kael on a neon rooftop', connector: CONNECTOR }));
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/MINIMAX_API_KEY/);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('injects the canon <<<element>>> for kael, forwards model/aspect_ratio, returns jobId, closes the client', async () => {
    mockMinimaxReturns('a vivid cyberpunk rooftop scene');
    callMcpToolSpy.mockResolvedValue(submitEcho());

    const res = await POST(
      postReq({
        idea: 'kael on a neon rooftop',
        connector: CONNECTOR,
        aspectRatio: '9:16',
        count: 2,
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      jobId: string;
      prompt: string;
      characterId: string;
      anchored: boolean;
      model: string;
      provider: string;
    };

    expect(json.jobId).toBe(JOB_ID);
    expect(json.characterId).toBe('kael');
    expect(json.anchored).toBe(true);
    expect(json.provider).toBe('higgsfield');
    // The model we SUBMITTED — NOT the echoed nano_banana_flash remap.
    expect(json.model).toBe('nano_banana_2');

    // Canon anchor: the prompt starts with kael's Element placeholder.
    const elementRef = getElementRef('kael');
    expect(elementRef).toBeTruthy();
    expect(json.prompt.startsWith(elementRef as string)).toBe(true);
    expect(json.prompt).toContain('a vivid cyberpunk rooftop scene');

    // The generate_image call shape: { params: { model, prompt, aspect_ratio, count } }.
    expect(callMcpToolSpy).toHaveBeenCalledTimes(1);
    const [, toolName, args] = callMcpToolSpy.mock.calls[0] as [
      unknown,
      string,
      { params: Record<string, unknown> },
    ];
    expect(toolName).toBe('generate_image');
    expect(args.params.model).toBe('nano_banana_2');
    expect(args.params.aspect_ratio).toBe('9:16');
    expect(args.params.count).toBe(2);
    expect(String(args.params.prompt)).toContain(elementRef as string);

    // Client always closed.
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('skipEnhance bypasses MiniMax (no fetch) and submits the idea verbatim (still anchored)', async () => {
    callMcpToolSpy.mockResolvedValue(submitEcho());
    const res = await POST(
      postReq({ idea: 'raw prompt text', connector: CONNECTOR, skipEnhance: true }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { prompt: string; anchored: boolean };
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const elementRef = getElementRef('kael') as string;
    expect(json.prompt).toBe(`${elementRef} raw prompt text`);
    expect(json.anchored).toBe(true);
  });

  it('proceeds unanchored (anchored:false) for a character with no Element (kaelus-alt)', async () => {
    callMcpToolSpy.mockResolvedValue(submitEcho());
    const res = await POST(
      postReq({
        idea: 'a design study',
        connector: CONNECTOR,
        characterId: 'kaelus-alt',
        skipEnhance: true,
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { prompt: string; anchored: boolean };
    expect(json.anchored).toBe(false);
    expect(json.prompt).toBe('a design study');
    expect(json.prompt).not.toContain('<<<');
  });

  it('400s on an unknown canon character', async () => {
    const res = await POST(
      postReq({ idea: 'x', connector: CONNECTOR, characterId: 'nobody', skipEnhance: true }),
    );
    expect(res.status).toBe(400);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('surfaces a tool error as 502 AND still closes the client', async () => {
    mockMinimaxReturns('enhanced');
    callMcpToolSpy.mockRejectedValue(new FakeMcpError('tool-error', 'tool "generate_image" returned an error result'));
    const res = await POST(postReq({ idea: 'kael', connector: CONNECTOR }));
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/Higgsfield submit failed/);
    // Connected, then closed even on failure.
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('502s when the submit echo carries no job id', async () => {
    mockMinimaxReturns('enhanced');
    callMcpToolSpy.mockResolvedValue({ results: [], adjustments: {} });
    const res = await POST(postReq({ idea: 'kael', connector: CONNECTOR }));
    expect(res.status).toBe(502);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/higgsfield/image/[id] — poll', () => {
  function getReq(headers?: Record<string, string>): Request {
    return new Request(`http://x/api/higgsfield/image/${JOB_ID}`, {
      method: 'GET',
      headers: headers ?? {},
    });
  }
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it('400s on an invalid (non-UUID) job id', async () => {
    const res = await GET(getReq({ 'x-mcp-connector': JSON.stringify(CONNECTOR) }), params('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('400s when the connector header is missing', async () => {
    const res = await GET(getReq(), params(JOB_ID));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/Higgsfield connector/i);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('returns status in_progress with empty images before completion', async () => {
    callMcpToolSpy.mockResolvedValue({
      results: [{ id: JOB_ID, status: 'in_progress', params: {} }],
    });
    const res = await GET(getReq({ 'x-mcp-connector': JSON.stringify(CONNECTOR) }), params(JOB_ID));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string; images: string[] };
    expect(json.status).toBe('in_progress');
    expect(json.images).toEqual([]);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('maps results[0].results.{rawUrl,minUrl} when completed, calling job_display with the UUID', async () => {
    callMcpToolSpy.mockResolvedValue({
      results: [
        {
          id: JOB_ID,
          status: 'completed',
          // The finished-media object — distinct from the input Element image.
          results: {
            rawUrl: 'https://cdn.higgsfield/out.jpeg',
            minUrl: 'https://cdn.higgsfield/out_min.webp',
          },
          params: {
            reference_elements: [{ medias: [{ url: 'https://cdn/INPUT-element.png' }] }],
          },
        },
      ],
    });
    const res = await GET(getReq({ 'x-mcp-connector': JSON.stringify(CONNECTOR) }), params(JOB_ID));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string; images: string[] };
    expect(json.status).toBe('completed');
    expect(json.images).toEqual([
      'https://cdn.higgsfield/out.jpeg',
      'https://cdn.higgsfield/out_min.webp',
    ]);
    // Must NOT read the INPUT element image.
    expect(json.images).not.toContain('https://cdn/INPUT-element.png');

    // job_display called with exactly the one UUID.
    const [, toolName, args] = callMcpToolSpy.mock.calls[0] as [unknown, string, { id: string }];
    expect(toolName).toBe('job_display');
    expect(args.id).toBe(JOB_ID);
  });

  it('502s when the poll tool errors AND still closes the client', async () => {
    callMcpToolSpy.mockRejectedValue(new FakeMcpError('tool-error', 'boom'));
    const res = await GET(getReq({ 'x-mcp-connector': JSON.stringify(CONNECTOR) }), params(JOB_ID));
    expect(res.status).toBe(502);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
