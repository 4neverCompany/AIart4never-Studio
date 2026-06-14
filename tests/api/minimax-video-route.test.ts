// V1.1.1-MULTI-PROVIDER-VIDEO: regression test for the native
// MiniMax (Hailuo 2.3) video generation route + status route.
//
// The new /api/minimax-video + /api/minimax-video/[taskId] pair is
// the third video provider alongside /api/leonardo-video and
// /api/mmx/video. The user can select any combination of the three
// in Settings; the Studio fires parallel submissions to all
// selected providers on Animate.
//
// This test pins:
//   1. POST returns { taskId, status: 'pending', model } on success.
//   2. POST maps MiniMax's base_resp.status_code to a 4xx/5xx
//      with a human-readable error.
//   3. POST returns 503 when MINIMAX_API_KEY is not configured.
//   4. POST returns 400 on missing/empty prompt.
//   5. POST clamps duration / resolution / model to safe bounds.
//   6. GET /[taskId] maps MiniMax's PascalCase status to the
//      lowercased vocabulary the Studio expects.
//   7. GET /[taskId] on Success fetches the download_url from
//      /v1/files/retrieve.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as submitVideo } from '@/app/api/minimax-video/route';
import { GET as getVideoStatus } from '@/app/api/minimax-video/[taskId]/route';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  // Default to a configured API key; individual tests can override
  // by deleting process.env.MINIMAX_API_KEY.
  process.env.MINIMAX_API_KEY = 'sk-test-fake';
  delete process.env.MINIMAX_API_BASE_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MINIMAX_API_KEY;
  delete process.env.MINIMAX_API_BASE_URL;
});

function makePost(body: unknown): NextRequest {
  return new NextRequest('http://x/api/minimax-video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/minimax-video — submit (Hailuo 2.3)', () => {
  it('returns 400 on missing prompt', async () => {
    const res = await submitVideo(makePost({}));
    expect(res.status).toBe(400);
  });

  it('returns 400 on empty / whitespace prompt', async () => {
    const res = await submitVideo(makePost({ prompt: '   ' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid JSON', async () => {
    const req = new NextRequest('http://x/api/minimax-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const res = await submitVideo(req);
    expect(res.status).toBe(400);
  });

  it('returns 503 when MINIMAX_API_KEY is not set', async () => {
    delete process.env.MINIMAX_API_KEY;
    const res = await submitVideo(makePost({ prompt: 'A man reads a book' }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/MINIMAX_API_KEY/);
  });

  it('returns taskId on successful submission', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          task_id: '1234567890',
          base_resp: { status_code: 0, status_msg: 'success' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const res = await submitVideo(makePost({ prompt: 'A man reads a book' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.taskId).toBe('1234567890');
    expect(body.status).toBe('pending');
    // Default model is Hailuo 2.3.
    expect(body.model).toBe('MiniMax-Hailuo-2.3');
  });

  it('forwards custom model + duration + resolution + firstFrameUrl to the API', async () => {
    let capturedBody: unknown = null;
    fetchMock.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ task_id: '111', base_resp: { status_code: 0 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    await submitVideo(
      makePost({
        prompt: 'A robot painting',
        options: {
          model: 'MiniMax-Hailuo-02',
          duration: 10,
          resolution: '1080P',
          firstFrameUrl: 'https://example.com/first.jpg',
        },
      }),
    );
    const sent = capturedBody as Record<string, unknown>;
    expect(sent.model).toBe('MiniMax-Hailuo-02');
    expect(sent.duration).toBe(10);
    expect(sent.resolution).toBe('1080P');
    expect(sent.first_frame_url).toBe('https://example.com/first.jpg');
  });

  it('clamps duration and resolution to safe defaults when caller passes garbage', async () => {
    let capturedBody: unknown = null;
    fetchMock.mockImplementation(async (_url, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ task_id: '1', base_resp: { status_code: 0 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    await submitVideo(
      makePost({
        prompt: 'p',
        options: { duration: 'forever', resolution: 'uhd-8k' },
      }),
    );
    const sent = capturedBody as Record<string, unknown>;
    expect(typeof sent.duration).toBe('number');
    expect(sent.resolution).toBe('768P');
  });

  it('truncates prompts longer than 2000 chars', async () => {
    let capturedBody: unknown = null;
    fetchMock.mockImplementation(async (_url, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ task_id: '1', base_resp: { status_code: 0 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const longPrompt = 'x'.repeat(5000);
    await submitVideo(makePost({ prompt: longPrompt }));
    const sent = capturedBody as Record<string, unknown>;
    expect((sent.prompt as string).length).toBe(2000);
  });

  it('maps base_resp.status_code 1026 to a 400 with a content-filter message', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          base_resp: { status_code: 1026, status_msg: 'sensitive content' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const res = await submitVideo(makePost({ prompt: 'flagged' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.toLowerCase()).toContain('content filter');
  });

  it('maps base_resp.status_code 1004 to a 502 with an auth message', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          base_resp: { status_code: 1004, status_msg: 'auth failed' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const res = await submitVideo(makePost({ prompt: 'p' }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/authentication/i);
  });
});

describe('GET /api/minimax-video/[taskId] — status polling', () => {
  it('returns 503 when MINIMAX_API_KEY is not set', async () => {
    delete process.env.MINIMAX_API_KEY;
    const res = await getVideoStatus(
      new NextRequest('http://x/api/minimax-video/abc'),
      { params: Promise.resolve({ taskId: 'abc' }) },
    );
    expect(res.status).toBe(503);
  });

  it('returns 400 when taskId is missing', async () => {
    const res = await getVideoStatus(new NextRequest('http://x/api/minimax-video/'), {
      params: Promise.resolve({ taskId: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('maps "Processing" to status:processing (still in flight)', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          task_id: '1',
          status: 'Processing',
          base_resp: { status_code: 0 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const res = await getVideoStatus(new NextRequest('http://x/api/minimax-video/1'), {
      params: Promise.resolve({ taskId: '1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('processing');
    expect(body.videoUrl).toBeUndefined();
  });

  it('maps "Success" and resolves download_url via /v1/files/retrieve', async () => {
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/query/video_generation')) {
        return new Response(
          JSON.stringify({
            task_id: '1',
            status: 'Success',
            file_id: '98765',
            video_width: 1280,
            video_height: 720,
            base_resp: { status_code: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (u.includes('/files/retrieve')) {
        return new Response(
          JSON.stringify({
            file: {
              file_id: 98765,
              bytes: 1234567,
              filename: 'output.mp4',
              purpose: 'video_generation',
              download_url: 'https://cdn.example/video.mp4?sig=xyz',
            },
            base_resp: { status_code: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    });
    const res = await getVideoStatus(new NextRequest('http://x/api/minimax-video/1'), {
      params: Promise.resolve({ taskId: '1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('success');
    expect(body.videoUrl).toBe('https://cdn.example/video.mp4?sig=xyz');
    expect(body.width).toBe(1280);
    expect(body.height).toBe(720);
    expect(body.filename).toBe('output.mp4');
  });

  it('maps "Fail" to status:fail with no download', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          task_id: '1',
          status: 'Fail',
          base_resp: { status_code: 1026, status_msg: 'sensitive content' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const res = await getVideoStatus(new NextRequest('http://x/api/minimax-video/1'), {
      params: Promise.resolve({ taskId: '1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('fail');
    expect(body.videoUrl).toBeUndefined();
  });

  it('returns 502 when Success is reported but no file_id is present', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          task_id: '1',
          status: 'Success',
          base_resp: { status_code: 0 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const res = await getVideoStatus(new NextRequest('http://x/api/minimax-video/1'), {
      params: Promise.resolve({ taskId: '1' }),
    });
    expect(res.status).toBe(502);
  });
});
