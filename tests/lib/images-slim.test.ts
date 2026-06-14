/**
 * M3.2 (V1.8) — store slimming. Pins the contract that keeps the
 * 217 MB mashupforge.json from ever coming back:
 *   - hasEmbeddedPixels matches data-URLs and big legacy base64 only;
 *   - slimImageRecord persists pixels and returns a record whose `url`
 *     is the webview-loadable asset URL (render sites + posting flows
 *     keep working) with base64 dropped;
 *   - off-Tauri / failed writes return null (caller keeps fat record);
 *   - slimForBackup never strips pixels that exist NOWHERE else
 *     (no localPath → payload stays);
 *   - isAssetUrl recognizes both convertFileSrc forms, because
 *     ensureHostedUrl must intercept `http://asset.localhost/...`
 *     BEFORE the http passthrough (a localhost URL handed to Instagram
 *     would 404 server-side).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { persistMock, displayMock } = vi.hoisted(() => ({
  persistMock: vi.fn(),
  displayMock: vi.fn(),
}));

vi.mock('@/lib/images/storage', () => ({
  persistImageToDisk: persistMock,
  displayUrlAsync: displayMock,
}));

import {
  hasEmbeddedPixels,
  isAssetUrl,
  slimImageRecord,
  slimForBackup,
} from '@/lib/images/slim';
import type { GeneratedImage } from '@/types/mashup';

const DATA_URL = `data:image/jpeg;base64,${'A'.repeat(2000)}`;

function img(over: Partial<GeneratedImage>): GeneratedImage {
  return {
    id: 'img-1',
    prompt: 'p',
    url: 'https://cdn.example/x.jpg',
    status: 'ready',
    savedAt: 1718000000000,
    ...over,
  } as GeneratedImage;
}

beforeEach(() => {
  persistMock.mockReset();
  displayMock.mockReset();
});

describe('hasEmbeddedPixels', () => {
  it('matches data: URLs', () => {
    expect(hasEmbeddedPixels(img({ url: DATA_URL }))).toBe(true);
  });
  it('matches big legacy base64 fields', () => {
    expect(hasEmbeddedPixels(img({ base64: 'B'.repeat(5000) }))).toBe(true);
  });
  it('ignores https URLs, small base64 stubs, and slim records', () => {
    expect(hasEmbeddedPixels(img({}))).toBe(false);
    expect(hasEmbeddedPixels(img({ base64: 'short' }))).toBe(false);
    expect(hasEmbeddedPixels(img({ url: '', localPath: 'f.jpg' }))).toBe(false);
  });
});

describe('isAssetUrl', () => {
  it('recognizes both convertFileSrc forms', () => {
    expect(isAssetUrl('asset://localhost/C%3A/x.jpg')).toBe(true);
    expect(isAssetUrl('http://asset.localhost/C%3A/x.jpg')).toBe(true);
    expect(isAssetUrl('https://asset.localhost/C%3A/x.jpg')).toBe(true);
  });
  it('rejects public and data URLs', () => {
    expect(isAssetUrl('https://cdn.example/x.jpg')).toBe(false);
    expect(isAssetUrl('http://example.com/a.jpg')).toBe(false);
    expect(isAssetUrl(DATA_URL)).toBe(false);
  });
});

describe('slimImageRecord', () => {
  it('persists the data-URL and swaps in the asset URL', async () => {
    persistMock.mockResolvedValue('2026-06-11_img-1.jpg');
    displayMock.mockResolvedValue('http://asset.localhost/C%3A/img.jpg');
    const out = await slimImageRecord(img({ url: DATA_URL }));
    expect(persistMock).toHaveBeenCalledWith(DATA_URL, 'img-1', 1718000000000);
    expect(out).not.toBeNull();
    expect(out!.localPath).toBe('2026-06-11_img-1.jpg');
    expect(out!.url).toBe('http://asset.localhost/C%3A/img.jpg');
    expect(out!.base64).toBeUndefined();
  });

  it('builds the source from legacy base64 when url is remote', async () => {
    persistMock.mockResolvedValue('f.jpg');
    displayMock.mockResolvedValue('asset://localhost/f.jpg');
    const b64 = 'C'.repeat(4000);
    const out = await slimImageRecord(img({ base64: b64 }));
    expect(persistMock.mock.calls[0][0]).toBe(`data:image/jpeg;base64,${b64}`);
    expect(out!.base64).toBeUndefined();
  });

  it('returns null when there is nothing to slim', async () => {
    expect(await slimImageRecord(img({}))).toBeNull();
    expect(persistMock).not.toHaveBeenCalled();
  });

  it('returns null when the disk write fails (off-Tauri) — caller keeps the fat record', async () => {
    persistMock.mockResolvedValue(null);
    expect(await slimImageRecord(img({ url: DATA_URL }))).toBeNull();
  });

  it('returns null when asset resolution fails — never blanks the image', async () => {
    persistMock.mockResolvedValue('f.jpg');
    displayMock.mockResolvedValue('');
    expect(await slimImageRecord(img({ url: DATA_URL }))).toBeNull();
  });
});

describe('slimForBackup', () => {
  it('strips payloads ONLY for records whose pixels live on disk', () => {
    const fatNoDisk = img({ id: 'a', url: DATA_URL });
    const fatWithDisk = img({ id: 'b', url: DATA_URL, localPath: 'b.jpg' });
    const slim = img({ id: 'c' });
    const out = slimForBackup([fatNoDisk, fatWithDisk, slim]);
    expect(out[0].url).toBe(DATA_URL); // pixels exist nowhere else — keep
    expect(out[1].url).toBe('');       // on disk — strip from the JSON
    expect(out[1].base64).toBeUndefined();
    expect(out[2]).toBe(slim);         // untouched, same reference
  });
});
