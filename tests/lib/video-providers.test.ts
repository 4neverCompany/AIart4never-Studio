// V1.1.1-MULTI-PROVIDER-VIDEO: regression test for the
// submitAndPollVideo dispatch helper in lib/video-providers.ts.
//
// The Studio's Animate button fans out to every provider in
// settings.videoProviders via this helper. Each provider has its
// own submit endpoint, status endpoint, status response shape,
// and polling pattern. This test pins each of them.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  submitAndPollVideo,
  type VideoProviderId,
} from '@/lib/video-providers';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Convenience: returns a stub that recognizes submit URLs for a
 *  given provider and answers them with the provided body. The
 *  second-element tuple is the array of poll responses (consumed
 *  in order). */
function stubProvider(
  provider: VideoProviderId,
  submitBody: unknown,
  pollResponses: Array<{ status: number; body: unknown }>,
): void {
  let pollIdx = 0;
  fetchMock.mockImplementation(async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();
    // Submit endpoint detection (URL has no /<id> suffix on submit)
    if (
      (provider === 'minimax' && u.includes('/api/minimax-video') && !u.match(/minimax-video\/[^/?]+/)) ||
      (provider === 'higgsfield' && u.includes('/api/higgsfield/video')) ||
      (provider === 'mmx' && u.includes('/api/mmx/video'))
    ) {
      return new Response(JSON.stringify(submitBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Poll endpoint
    if (pollIdx < pollResponses.length) {
      const r = pollResponses[pollIdx];
      pollIdx++;
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Out of prepared responses: keep returning "still processing"
    // so the polling loop times out cleanly via timeoutMs.
    if (provider === 'minimax') {
      return new Response(JSON.stringify({ status: 'processing' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
}

const FAST = { pollIntervalMs: 5, timeoutMs: 500 };

describe('submitAndPollVideo — provider dispatch', () => {
  it('MiniMax: returns VideoResult on success status', async () => {
    stubProvider(
      'minimax',
      { taskId: 'task-1', status: 'pending' },
      [
        { status: 200, body: { status: 'processing' } },
        {
          status: 200,
          body: {
            status: 'success',
            videoUrl: 'https://cdn.minimax/hailuo.mp4',
            fileId: 'f1',
            filename: 'out.mp4',
          },
        },
      ],
    );
    const r = await submitAndPollVideo('minimax', {
      prompt: 'p',
      model: 'MiniMax-Hailuo-2.3',
      ...FAST,
    });
    expect(r.provider).toBe('minimax');
    expect(r.modelId).toBe('MiniMax-Hailuo-2.3');
    expect(r.modelName).toBe('Hailuo 2.3');
    expect(r.videoUrl).toBe('https://cdn.minimax/hailuo.mp4');
    expect(r.externalId).toBe('task-1');
  });

  it('MiniMax: throws on fail status', async () => {
    stubProvider(
      'minimax',
      { taskId: 't1' },
      [{ status: 200, body: { status: 'fail', error: 'sensitive content' } }],
    );
    await expect(
      submitAndPollVideo('minimax', { prompt: 'p', model: 'MiniMax-Hailuo-2.3', ...FAST }),
    ).rejects.toThrow(/sensitive/);
  });

  it('Higgsfield: completed+videoUrl -> VideoResult immediately', async () => {
    fetchMock.mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          completed: true,
          videoUrl: 'https://higgsfield.cdn/v.mp4',
          requestId: 'req-1',
        }),
        { status: 200 },
      );
    });
    const r = await submitAndPollVideo('higgsfield', { prompt: 'p', model: 'seedance_2_0' });
    expect(r.provider).toBe('higgsfield');
    expect(r.modelName).toBe('Seedance 2.0');
    expect(r.videoUrl).toBe('https://higgsfield.cdn/v.mp4');
  });

  it('Higgsfield: requestId-only -> throws (still generating)', async () => {
    fetchMock.mockImplementation(async () => {
      return new Response(
        JSON.stringify({ completed: false, requestId: 'req-2' }),
        { status: 200 },
      );
    });
    await expect(
      submitAndPollVideo('higgsfield', { prompt: 'p', model: 'seedance_2_0' }),
    ).rejects.toThrow(/still generating/);
  });

  it('mmx: returns error (async-only path)', async () => {
    fetchMock.mockImplementation(async () => {
      return new Response(JSON.stringify({ taskId: 'mmx-1', path: null }), { status: 200 });
    });
    await expect(
      submitAndPollVideo('mmx', { prompt: 'p', model: 'MiniMax-Hailuo-2.3' }),
    ).rejects.toThrow(/still generating/);
  });

  it('throws on submit HTTP 5xx', async () => {
    fetchMock.mockImplementation(async () => new Response('upstream down', { status: 502 }));
    await expect(
      submitAndPollVideo('minimax', { prompt: 'p', model: 'MiniMax-Hailuo-2.3' }),
    ).rejects.toThrow(/MiniMax submit failed/);
  });

  it('throws when submit returns no taskId / generationId', async () => {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ error: 'quota exceeded' }), { status: 200 }),
    );
    await expect(
      submitAndPollVideo('minimax', { prompt: 'p', model: 'MiniMax-Hailuo-2.3' }),
    ).rejects.toThrow(/quota/);
  });

  it('passes firstFrameUrl to the minimax route', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      const body = init?.body ? JSON.parse(init.body as string) : null;
      calls.push({ url: u, body });
      if (u.includes('/api/minimax-video') && !u.match(/minimax-video\/[^/?]+/)) {
        return new Response(JSON.stringify({ taskId: 't1' }), { status: 200 });
      }
      if (u.match(/minimax-video\/[^/?]+/)) {
        return new Response(JSON.stringify({ status: 'success', videoUrl: 'https://x/v.mp4' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    await submitAndPollVideo('minimax', {
      prompt: 'p',
      model: 'MiniMax-Hailuo-2.3',
      firstFrameUrl: 'https://cdn.example/seed.jpg',
      ...FAST,
    });
    const submit = calls.find(
      (c) => c.url.includes('/api/minimax-video') && !c.url.match(/minimax-video\/[^/?]+/),
    );
    expect(submit?.body).toMatchObject({
      options: { firstFrameUrl: 'https://cdn.example/seed.jpg' },
    });
  });
});
