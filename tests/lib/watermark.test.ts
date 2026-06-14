/**
 * V1.5: reapplyWatermark contract tests.
 *
 * Covers the guard branches that don't touch the canvas (video skip,
 * disabled watermark, missing base) plus the double-stack-protection
 * base selection. The actual canvas compositing (applyWatermark) is a
 * browser-only path exercised through the app, not unit-tested here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GeneratedImage, WatermarkSettings } from '@/types/mashup';

// Stub the storage import the helper does dynamically, so the Tauri
// persist path is a no-op in node.
vi.mock('@/lib/images/storage', () => ({
  persistImageToDisk: vi.fn().mockResolvedValue(null),
}));

import { reapplyWatermark, applyWatermark, WATERMARK_LOAD_TIMEOUT_MS } from '@/lib/watermark';

const onSettings: WatermarkSettings = {
  enabled: true,
  image: null,
  position: 'bottom-right',
  opacity: 0.8,
  scale: 0.05,
};

const img = (over: Partial<GeneratedImage> = {}): GeneratedImage =>
  ({ id: 'i1', prompt: 'p', url: 'https://cdn/x.jpg', ...over }) as GeneratedImage;

describe('reapplyWatermark — guard branches', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips videos with a clear reason', async () => {
    const r = await reapplyWatermark(img({ isVideo: true }), onSettings, 'Chan');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/video/i);
  });

  it('skips when the watermark is disabled', async () => {
    const r = await reapplyWatermark(img(), { ...onSettings, enabled: false }, 'Chan');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/enable/i);
  });

  it('skips when there is no watermark image AND no channel name', async () => {
    const r = await reapplyWatermark(img(), onSettings, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/watermark image or channel/i);
  });

  it('skips when the image has no source to watermark', async () => {
    const r = await reapplyWatermark(img({ url: undefined }), onSettings, 'Chan');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no source/i);
  });
});

describe('applyWatermark — V1.7.0-PERF load timeout (no more infinite hang)', () => {
  it('resolves to the un-watermarked base when the image never loads', async () => {
    // happy-dom's `new Image()` never fires onload/onerror for a remote
    // src (no network) — exactly the production stall. Before the fix the
    // Promise never settled; now the timeout ships the base.
    vi.useFakeTimers();
    const base = 'https://cdn.example/never-loads.jpg';
    const settings: WatermarkSettings = {
      enabled: true,
      image: 'data:image/png;base64,AAAA',
      position: 'bottom-right',
      opacity: 0.8,
      scale: 0.15,
    };
    const p = applyWatermark(base, settings, 'Chan');
    await vi.advanceTimersByTimeAsync(WATERMARK_LOAD_TIMEOUT_MS + 100);
    await expect(p).resolves.toBe(base);
    vi.useRealTimers();
  });

  it('short-circuits instantly (no timer) when the watermark is disabled', async () => {
    const base = 'https://cdn.example/x.jpg';
    await expect(
      applyWatermark(base, { enabled: false, image: null, position: 'bottom-right', opacity: 0.8, scale: 0.05 }),
    ).resolves.toBe(base);
  });
});
