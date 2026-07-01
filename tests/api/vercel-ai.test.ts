/**
 * vercel-ai route tests — `app/api/ai/prompt` (LLM-INTEGRATION-0513).
 *
 * 4NE-20: the route is MiniMax-only. Earlier revisions chained
 * MiniMax → OpenAI (and, before that, Anthropic / OpenRouter); those
 * are all gone. These tests pin the MiniMax-only contract.
 *
 * What we cover:
 *   1. POST /api/ai/prompt returns 503 (with a MiniMax-only error
 *      message) when MINIMAX_API_KEY is unset — even when a stray
 *      OPENAI_API_KEY is present (no fallback).
 *   2. POST /api/ai/prompt 400s on missing/empty `message`.
 *   3. POST /api/ai/prompt streams SSE chunks in our wire format
 *      (`data: {"text":"<delta>"}\n\n` + `data: [DONE]\n\n`) when
 *      MiniMax is configured — exercises the MiniMax chat-completions
 *      direct-fetch branch (the only streaming path now).
 *   4. POST /api/ai/prompt honours the `model` body field as the
 *      top-priority model override (over VERCEL_AI_MODEL env and the
 *      MiniMax default).
 *
 * What we don't cover:
 *   - Web-search enrichment (mode === 'idea' / 'chat') — best-effort
 *     network calls, mocked at a different layer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

describe('POST /api/ai/prompt — MiniMax-only chain (4NE-20)', () => {
  it('rejects the request with 503 + MiniMax-only error message when no API key is configured', async () => {
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
    // Regression guard — the error string must NOT mention any removed
    // fallback provider (OpenAI / Anthropic / OpenRouter).
    expect(json.error).not.toContain('OPENAI');
    expect(json.error).not.toContain('ANTHROPIC');
    expect(json.error).not.toContain('OPENROUTER');
  });

  it('503s when only OPENAI_API_KEY is set (no OpenAI fallback)', async () => {
    process.env.OPENAI_API_KEY = 'stray-openai-key';
    const { POST } = await import('@/app/api/ai/prompt/route');
    const res = await POST(
      new Request('http://x/api/ai/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      }),
    );
    expect(res.status).toBe(503);
    // The MiniMax-only route ignores a stray OpenAI key entirely.
    expect(globalThis.fetch).not.toHaveBeenCalled();
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

  it('ignores a stray OPENAI_API_KEY when MiniMax is set (MiniMax-only, no fallback)', async () => {
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
    process.env.MINIMAX_API_KEY = 'test-minimax-key';
    process.env.VERCEL_AI_MODEL = 'env-override';
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
        body: JSON.stringify({ message: 'ping', model: 'MiniMax-M3-custom' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-AI-Model')).toBe('MiniMax-M3-custom');
  });

  it('falls back to VERCEL_AI_MODEL env when no per-request model is set', async () => {
    process.env.MINIMAX_API_KEY = 'test-minimax-key';
    process.env.VERCEL_AI_MODEL = 'env-model';
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

});

// ---------------------------------------------------------------------------
// M1 CANON-WIRING: the Master4never canon block is injected into the text-mode
// system stack, right after BASE_SYSTEM_PROMPT, for the active character.
// ---------------------------------------------------------------------------

/** Pull the MiniMax request's `system` message out of the mocked fetch call. */
function systemFromFetchCall(): string {
  const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
  const init = call[1] as RequestInit;
  const parsed = JSON.parse(init.body as string) as {
    messages?: Array<{ role: string; content: string }>;
  };
  return parsed.messages?.find((m) => m.role === 'system')?.content ?? '';
}

describe('POST /api/ai/prompt — canon system block injection (M1)', () => {
  beforeEach(() => {
    process.env.MINIMAX_API_KEY = 'test-minimax-key';
    const ssePayload =
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n' + 'data: [DONE]\n\n';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(makeSseStream(ssePayload), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
  });

  it("injects the Kael canon block (structural, live-lookup) when activeCharacterId='kael'", async () => {
    const { POST } = await import('@/app/api/ai/prompt/route');
    const res = await POST(
      new Request('http://x/api/ai/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'write a caption', mode: 'caption', activeCharacterId: 'kael' }),
      }),
    );
    expect(res.status).toBe(200);
    const system = systemFromFetchCall();
    expect(system).toContain('Master4never');
    // Story 2.8: the block is STRUCTURAL and instructs the live lookup — no hardcoded lore.
    expect(system).toMatch(/show_reference_elements/);
    // The canon block sits AFTER the base system prompt (authoritative persona).
    const baseIdx = system.indexOf('creative AI engine for AIart4never Studio');
    const canonIdx = system.indexOf('Canon character');
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(canonIdx).toBeGreaterThan(baseIdx);
  });

  it('defaults to the Kael canon block when no activeCharacterId is supplied', async () => {
    const { POST } = await import('@/app/api/ai/prompt/route');
    await POST(
      new Request('http://x/api/ai/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hi', mode: 'caption' }),
      }),
    );
    const system = systemFromFetchCall();
    expect(system).toContain('Master4never (Kael)');
  });

  it('injects the requested variant canon (Kaelus Vorne, structural) on a valid activeCharacterId', async () => {
    const { POST } = await import('@/app/api/ai/prompt/route');
    await POST(
      new Request('http://x/api/ai/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hi', mode: 'caption', activeCharacterId: 'kaelus-vorne' }),
      }),
    );
    const system = systemFromFetchCall();
    expect(system).toContain('Kaelus Vorne');
    expect(system).toMatch(/show_reference_elements/);
  });

  it('falls back to Kael when activeCharacterId is invalid', async () => {
    const { POST } = await import('@/app/api/ai/prompt/route');
    await POST(
      new Request('http://x/api/ai/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hi', mode: 'caption', activeCharacterId: 'not-a-real-id' }),
      }),
    );
    const system = systemFromFetchCall();
    expect(system).toContain('Master4never (Kael)');
  });
});

describe('GET /api/ai/status — MiniMax-only chain (4NE-20)', () => {
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

  it('reports null when only OPENAI_API_KEY is set (no OpenAI fallback)', async () => {
    process.env.OPENAI_API_KEY = 'k';
    const { GET } = await import('@/app/api/ai/status/route');
    const res = await GET();
    const json = (await res.json()) as { provider?: string | null; available?: boolean };
    expect(json.provider).toBeNull();
    expect(json.available).toBe(false);
  });

  it('reports null when no key is set (regression: never returns openai/anthropic/openrouter)', async () => {
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
