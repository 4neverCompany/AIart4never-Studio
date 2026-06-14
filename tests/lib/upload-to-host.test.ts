import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ensureHostedUrl, ensureHostedUrls, uploadBase64ToHost } from '@/lib/upload-to-host';

// Smallest possible base64 — a 1x1 transparent PNG. Used for shape
// assertions; the actual bytes never leave the mock.
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_B64}`;

// /api/upload (our proxy) returns `{ url }` after re-hosting to uguu
// server-side. The proxy shields the browser from uguu's missing CORS
// headers and translates uguu's `{ success, files: [{ url }] }` shape
// into a simpler `{ url }` for the client.
function mockProxySuccess(hostedUrl = 'https://n.uguu.se/Abc12345.jpg') {
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ url: hostedUrl }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
}

describe('ensureHostedUrl', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('passes through https URLs unchanged', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const result = await ensureHostedUrl('https://cdn.leonardo.ai/img/abc.jpg');
    expect(result).toBe('https://cdn.leonardo.ai/img/abc.jpg');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('passes through http URLs unchanged (no upload roundtrip)', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const result = await ensureHostedUrl('http://example.com/img.jpg');
    expect(result).toBe('http://example.com/img.jpg');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uploads data: URL through /api/upload proxy and returns the hosted URL', async () => {
    const fetchSpy = mockProxySuccess('https://n.uguu.se/Hosted1.png');
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const result = await ensureHostedUrl(TINY_PNG_DATA_URL);
    expect(result).toBe('https://n.uguu.se/Hosted1.png');
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/upload');
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it('throws with a readable message when /api/upload returns non-JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Request Enqueued', { status: 429, headers: { 'content-type': 'text/plain' } }),
    ) as unknown as typeof globalThis.fetch;
    await expect(ensureHostedUrl(TINY_PNG_DATA_URL)).rejects.toThrow(/\/api\/upload returned non-JSON \(HTTP 429\): Request Enqueued/);
  });

  it('throws when /api/upload returns an error payload', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'uguu upload failed: No input file(s)' }), { status: 502 }),
    ) as unknown as typeof globalThis.fetch;
    await expect(ensureHostedUrl(TINY_PNG_DATA_URL)).rejects.toThrow(/\/api\/upload failed \(HTTP 502\): uguu upload failed: No input file/);
  });

  it('throws when source is neither http/https nor data:', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof globalThis.fetch;
    await expect(ensureHostedUrl('ftp://something/weird.jpg')).rejects.toThrow(/unsupported source/);
  });
});

describe('ensureHostedUrls (array)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('mixes pass-through and uploads in one call, preserving order', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount += 1;
      return new Response(
        JSON.stringify({ url: `https://n.uguu.se/Mixed${callCount}.jpg` }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const input = [
      'https://cdn.leonardo.ai/already-hosted.jpg',
      TINY_PNG_DATA_URL,
      'https://cdn.leonardo.ai/also-hosted.jpg',
      TINY_PNG_DATA_URL,
    ];
    const result = await ensureHostedUrls(input);

    expect(result[0]).toBe('https://cdn.leonardo.ai/already-hosted.jpg');
    expect(result[1]).toMatch(/^https:\/\/n\.uguu\.se\/Mixed/);
    expect(result[2]).toBe('https://cdn.leonardo.ai/also-hosted.jpg');
    expect(result[3]).toMatch(/^https:\/\/n\.uguu\.se\/Mixed/);
    // Only the two data: URLs incurred uploads.
    expect(callCount).toBe(2);
  });

  it('rejects the whole array if one upload fails', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      if (n === 2) return new Response('Server Error', { status: 500 });
      return new Response(JSON.stringify({ url: 'https://n.uguu.se/Ok.jpg' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await expect(ensureHostedUrls([TINY_PNG_DATA_URL, TINY_PNG_DATA_URL, TINY_PNG_DATA_URL])).rejects.toThrow();
  });
});

describe('uploadBase64ToHost (raw base64, no data: prefix)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('uploads a raw base64 string and returns the hosted URL', async () => {
    globalThis.fetch = mockProxySuccess('https://n.uguu.se/Raw.jpg') as unknown as typeof globalThis.fetch;
    const result = await uploadBase64ToHost(TINY_PNG_B64, 'image/jpeg');
    expect(result).toBe('https://n.uguu.se/Raw.jpg');
  });
});
