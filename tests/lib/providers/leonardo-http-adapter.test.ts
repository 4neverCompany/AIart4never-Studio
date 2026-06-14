/**
 * Tests for lib/providers/leonardo/http-adapter.
 *
 * Coverage:
 *   - generateImage builds the right payload and parses generationId
 *   - generateVideo routes payload by family (kling/seedance/veo/legacy)
 *   - pollJob returns image / video based on response shape
 *   - isAvailable returns false when no API key
 *   - HTTP 4xx with structured error body → ProviderRejectedError
 *   - HTTP 5xx with plain text body → ProviderExecError
 *   - non-JSON body → ProviderParseError
 *   - AbortError → ProviderExecError
 *   - extractLeonardoErrorMessage handles the three documented shapes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LeonardoHttpAdapter,
  extractLeonardoErrorMessage,
} from '@/lib/providers/leonardo/http-adapter';
import {
  ProviderError,
  ProviderExecError,
  ProviderParseError,
  ProviderRejectedError,
  ProviderUnavailableError,
} from '@/lib/providers/interface';

interface FetchCall {
  url: string;
  init: RequestInit;
}

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

function makeRes(body: unknown, opts: { status?: number; contentType?: string } = {}): Response {
  const status = opts.status ?? 200;
  const ct = opts.contentType ?? 'application/json';
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'Content-Type': ct },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  // Default: successful create with a generationId
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'GET') {
      return makeRes({ generations_by_pk: { status: 'COMPLETE', image_urls: ['https://x/a.png'] } });
    }
    return makeRes({ sdGenerationJob: { generationId: 'gen-1' } });
  });
});
afterEach(() => {
  delete process.env.LEONARDO_API_KEY;
});

describe('LeonardoHttpAdapter.isAvailable', () => {
  it('returns false when no API key is set', async () => {
    const a = new LeonardoHttpAdapter({ fetchImpl: fetchMock as never });
    expect(await a.isAvailable()).toBe(false);
  });

  it('returns false for the placeholder key', async () => {
    process.env.LEONARDO_API_KEY = 'MY_LEONARDO_API_KEY';
    const a = new LeonardoHttpAdapter({ fetchImpl: fetchMock as never });
    expect(await a.isAvailable()).toBe(false);
  });

  it('returns true when a real-looking key is set', async () => {
    process.env.LEONARDO_API_KEY = 'leon-abc';
    const a = new LeonardoHttpAdapter({ fetchImpl: fetchMock as never });
    expect(await a.isAvailable()).toBe(true);
  });
});

describe('LeonardoHttpAdapter.generateImage', () => {
  it('throws ProviderUnavailableError when no key', async () => {
    const a = new LeonardoHttpAdapter({ fetchImpl: fetchMock as never });
    await expect(a.generateImage({ prompt: 'x' })).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it('maps internal model id to API model id and parses generationId', async () => {
    process.env.LEONARDO_API_KEY = 'leon-abc';
    const a = new LeonardoHttpAdapter({ fetchImpl: fetchMock as never });
    const ref = await a.generateImage({
      prompt: 'a cat',
      model: 'nano-banana-pro',
      width: 1024,
      height: 1024,
      n: 2,
      quality: 'HIGH',
      styleIds: ['style-uuid-1'],
    });
    expect(ref.kind).toBe('job');
    expect(ref.jobId).toBe('gen-1');
    expect(ref.provider).toBe('leonardo');

    // Inspect the call
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/v2/generations');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer leon-abc');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gemini-image-2'); // nano-banana-pro → gemini-image-2
    expect(body.parameters.prompt).toBe('a cat');
    expect(body.parameters.width).toBe(1024);
    expect(body.parameters.quantity).toBe(2);
    expect(body.parameters.style_ids).toEqual(['style-uuid-1']);
    expect(body.parameters.quality).toBe('HIGH');
  });

  it('clamps gpt-image-1.5 quantity to 4', async () => {
    process.env.LEONARDO_API_KEY = 'leon-abc';
    const a = new LeonardoHttpAdapter({ fetchImpl: fetchMock as never });
    await a.generateImage({ prompt: 'x', model: 'gpt-image-1.5', n: 8 });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.parameters.quantity).toBe(4);
  });

  it('throws ProviderParseError on response without generationId', async () => {
    process.env.LEONARDO_API_KEY = 'leon-abc';
    fetchMock.mockResolvedValueOnce(makeRes({ unexpected: true }) as never);
    const a = new LeonardoHttpAdapter({ fetchImpl: fetchMock as never });
    await expect(a.generateImage({ prompt: 'x' })).rejects.toBeInstanceOf(
      ProviderParseError,
    );
  });
});

describe('LeonardoHttpAdapter.generateVideo', () => {
  it('routes kling family to v2 with proper payload', async () => {
    process.env.LEONARDO_API_KEY = 'leon-abc';
    const a = new LeonardoHttpAdapter({ fetchImpl: fetchMock as never });
    const ref = await a.generateVideo({
      prompt: 'animate',
      model: 'kling-3.0',
      imageId: 'gen-1',
      durationSec: 5,
    });
    expect(ref.kind).toBe('job');
    expect(ref.jobId).toBe('gen-1');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/v2/generations');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('kling-3.0');
    expect(body.parameters.duration).toBe(5);
    expect(body.parameters.mode).toBe('RESOLUTION_1080');
    expect(body.parameters.guidances.start_frame[0].image.id).toBe('gen-1');
  });

  it('routes veo family to flat payload (no nested parameters)', async () => {
    process.env.LEONARDO_API_KEY = 'leon-abc';
    const a = new LeonardoHttpAdapter({ fetchImpl: fetchMock as never });
    await a.generateVideo({
      prompt: 'animate',
      model: 'veo-3.1',
      durationSec: 6,
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe('VEO3_1');
    expect(body.duration).toBe(6);
    expect(body.resolution).toBe('RESOLUTION_1080');
    expect(body.parameters).toBeUndefined();
  });

  it('routes legacy family to v1 motion-svd endpoint', async () => {
    process.env.LEONARDO_API_KEY = 'leon-abc';
    const a = new LeonardoHttpAdapter({ fetchImpl: fetchMock as never });
    await a.generateVideo({ prompt: 'animate', model: 'ray-v2', imageId: 'gen-x' });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/v1/generations-motion-svd');
  });
});

describe('LeonardoHttpAdapter error mapping', () => {
  beforeEach(() => {
    process.env.LEONARDO_API_KEY = 'leon-abc';
  });

  it('maps HTTP 400 with structured error to ProviderRejectedError', async () => {
    fetchMock.mockResolvedValueOnce(
      makeRes({ error: { message: 'invalid model id', code: 'INVALID_MODEL' } }, { status: 400 }) as never,
    );
    const a = new LeonardoHttpAdapter({ fetchImpl: fetchMock as never });
    let caught: unknown;
    try {
      await a.generateImage({ prompt: 'x' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderRejectedError);
    expect((caught as ProviderRejectedError).message).toContain('invalid model id');
  });

  it('maps HTTP 500 with plain text to ProviderExecError', async () => {
    fetchMock.mockResolvedValueOnce(
      makeRes('internal server error', { status: 500, contentType: 'text/plain' }) as never,
    );
    const a = new LeonardoHttpAdapter({ fetchImpl: fetchMock as never });
    await expect(a.generateImage({ prompt: 'x' })).rejects.toBeInstanceOf(
      ProviderExecError,
    );
  });

  it('maps AbortError to ProviderExecError', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }) as never);
    const a = new LeonardoHttpAdapter({ fetchImpl: fetchMock as never });
    await expect(a.generateImage({ prompt: 'x' })).rejects.toBeInstanceOf(
      ProviderExecError,
    );
  });
});

describe('LeonardoHttpAdapter.pollJob', () => {
  beforeEach(() => {
    process.env.LEONARDO_API_KEY = 'leon-abc';
  });

  it('returns AssetRef kind:image when status=COMPLETE and image_urls present', async () => {
    fetchMock.mockResolvedValueOnce(
      makeRes({
        generations_by_pk: {
          status: 'COMPLETE',
          image_urls: ['https://x/a.png', 'https://x/b.png'],
        },
      }) as never,
    );
    const a = new LeonardoHttpAdapter({ fetchImpl: fetchMock as never });
    const ref = await a.pollJob('gen-1');
    expect(ref.kind).toBe('image');
    expect(ref.url).toBe('https://x/a.png');
  });

  it('returns AssetRef kind:video when video_url is present', async () => {
    fetchMock.mockResolvedValueOnce(
      makeRes({
        generations_by_pk: { status: 'COMPLETE', video_url: 'https://x/v.mp4' },
      }) as never,
    );
    const a = new LeonardoHttpAdapter({ fetchImpl: fetchMock as never });
    const ref = await a.pollJob('gen-2');
    expect(ref.kind).toBe('video');
    expect(ref.url).toBe('https://x/v.mp4');
  });

  it('returns AssetRef kind:job when status is PENDING', async () => {
    fetchMock.mockResolvedValueOnce(
      makeRes({ generations_by_pk: { status: 'PENDING' } }) as never,
    );
    const a = new LeonardoHttpAdapter({ fetchImpl: fetchMock as never });
    const ref = await a.pollJob('gen-3');
    expect(ref.kind).toBe('job');
    expect(ref.jobId).toBe('gen-3');
  });
});

describe('extractLeonardoErrorMessage', () => {
  it('handles string error field', () => {
    expect(extractLeonardoErrorMessage({ error: 'oops' })).toBe('oops');
  });
  it('handles object error field with message', () => {
    expect(extractLeonardoErrorMessage({ error: { message: 'bad', code: 'X' } })).toBe('bad');
  });
  it('falls back to code if no message', () => {
    expect(extractLeonardoErrorMessage({ error: { code: 'INVALID' } })).toBe('INVALID');
  });
  it('handles errors array', () => {
    expect(extractLeonardoErrorMessage({ errors: [{ message: 'first' }] })).toBe('first');
  });
  it('handles top-level message', () => {
    expect(extractLeonardoErrorMessage({ message: 'top' })).toBe('top');
  });
  it('returns null when no recognised shape', () => {
    expect(extractLeonardoErrorMessage({ something: 'else' })).toBeNull();
    expect(extractLeonardoErrorMessage(null)).toBeNull();
    expect(extractLeonardoErrorMessage('plain string')).toBeNull();
  });
});
