// V040-HOTFIX-007: approval-time finalization helpers.

import { describe, it, expect, vi } from 'vitest';
import {
  collectFinalizeTargets,
  finalizePipelineImage,
} from '@/lib/pipeline-finalize';
import type { GeneratedImage, ScheduledPost, WatermarkSettings } from '@/types/mashup';

function mkImg(overrides: Partial<GeneratedImage>): GeneratedImage {
  return {
    id: 'img',
    prompt: 'x',
    url: 'https://cdn.example.com/x.jpg',
    ...overrides,
  };
}

describe('collectFinalizeTargets', () => {
  it('returns only pipelinePending images that match the post.imageId', () => {
    const images: GeneratedImage[] = [
      mkImg({ id: 'a', pipelinePending: true }),
      mkImg({ id: 'b', pipelinePending: true }),
      mkImg({ id: 'c' }),
    ];
    const post: Pick<ScheduledPost, 'imageId' | 'carouselGroupId'> = { imageId: 'a' };
    const out = collectFinalizeTargets(post, images);
    expect(out.map((i) => i.id)).toEqual(['a']);
  });

  it('returns all pipelinePending images in the same carousel group', () => {
    const images: GeneratedImage[] = [
      mkImg({ id: 'a', pipelinePending: true, carouselGroupId: 'g1' }),
      mkImg({ id: 'b', pipelinePending: true, carouselGroupId: 'g1' }),
      mkImg({ id: 'c', pipelinePending: true, carouselGroupId: 'g2' }),
      mkImg({ id: 'd', carouselGroupId: 'g1' }), // already finalized
    ];
    const post = { imageId: 'a', carouselGroupId: 'g1' };
    const out = collectFinalizeTargets(post, images);
    expect(new Set(out.map((i) => i.id))).toEqual(new Set(['a', 'b']));
  });

  it('skips images whose pipelinePending is false/undefined', () => {
    const images: GeneratedImage[] = [
      mkImg({ id: 'a', pipelinePending: false }),
      mkImg({ id: 'b' }),
    ];
    const post = { imageId: 'a' };
    expect(collectFinalizeTargets(post, images)).toEqual([]);
  });
});

describe('finalizePipelineImage', () => {
  const enabledWm: WatermarkSettings = {
    enabled: true,
    image: null,
    position: 'bottom-right',
    opacity: 0.8,
    scale: 0.05,
  };

  it('clears pipelinePending and applies watermark when enabled', async () => {
    const wm = vi.fn().mockResolvedValue('https://cdn.example.com/wm.png');
    const img = mkImg({
      id: 'a',
      pipelinePending: true,
      url: 'https://cdn.example.com/raw.jpg',
    });
    const out = await finalizePipelineImage(img, enabledWm, 'chan', wm);
    expect(wm).toHaveBeenCalledWith('https://cdn.example.com/raw.jpg', enabledWm, 'chan');
    expect(out.pipelinePending).toBe(false);
    expect(out.url).toBe('https://cdn.example.com/wm.png');
  });

  it('skips watermark but still clears pipelinePending when watermark disabled', async () => {
    const wm = vi.fn();
    const img = mkImg({ id: 'a', pipelinePending: true });
    const out = await finalizePipelineImage(img, { ...enabledWm, enabled: false }, 'chan', wm);
    expect(wm).not.toHaveBeenCalled();
    expect(out.pipelinePending).toBe(false);
    expect(out.url).toBe(img.url);
  });

  it('skips watermark when watermark settings is undefined', async () => {
    const wm = vi.fn();
    const img = mkImg({ id: 'a', pipelinePending: true });
    const out = await finalizePipelineImage(img, undefined, undefined, wm);
    expect(wm).not.toHaveBeenCalled();
    expect(out.pipelinePending).toBe(false);
  });

  it('swallows watermark errors and keeps the original URL', async () => {
    const wm = vi.fn().mockRejectedValue(new Error('canvas blew up'));
    const img = mkImg({
      id: 'a',
      pipelinePending: true,
      url: 'https://cdn.example.com/raw.jpg',
    });
    const out = await finalizePipelineImage(img, enabledWm, 'chan', wm);
    // Approval must not be blocked by a watermark failure.
    expect(out.pipelinePending).toBe(false);
    expect(out.url).toBe('https://cdn.example.com/raw.jpg');
  });

  // BUG-CRIT-013: markPostReady drives Post Ready tab membership. The
  // approve path passes true (scheduled content belongs in Post Ready);
  // the reject path passes false (rejected images go to Gallery only).
  // F-001: the reject path must write an EXPLICIT `false` so a
  // previously-approved image (already isPostReady: true in the
  // gallery) gets cleared instead of staying in Post Ready. The old
  // empty-spread variant was a no-op and silently leaked rejected
  // images into Post Ready.
  it('sets isPostReady=false when markPostReady is omitted (default)', async () => {
    const wm = vi.fn();
    const img = mkImg({ id: 'a', pipelinePending: true });
    const out = await finalizePipelineImage(img, undefined, undefined, wm);
    expect(out.isPostReady).toBe(false);
  });

  it('sets isPostReady=false when markPostReady is false (reject path)', async () => {
    const wm = vi.fn();
    const img = mkImg({ id: 'a', pipelinePending: true });
    const out = await finalizePipelineImage(img, undefined, undefined, wm, false);
    expect(out.isPostReady).toBe(false);
  });

  it('F-001: clears isPostReady=true when rejecting a previously-approved image', async () => {
    const wm = vi.fn();
    const img = mkImg({ id: 'a', pipelinePending: true, isPostReady: true });
    const out = await finalizePipelineImage(img, undefined, undefined, wm, false);
    expect(out.isPostReady).toBe(false);
  });

  it('sets isPostReady=true when markPostReady is true (approve path)', async () => {
    const wm = vi.fn();
    const img = mkImg({ id: 'a', pipelinePending: true });
    const out = await finalizePipelineImage(img, undefined, undefined, wm, true);
    expect(out.isPostReady).toBe(true);
    expect(out.pipelinePending).toBe(false);
  });

  it('preserves isPostReady=true through a watermark pass on the approve path', async () => {
    const wm = vi.fn().mockResolvedValue('https://cdn.example.com/wm.png');
    const img = mkImg({
      id: 'a',
      pipelinePending: true,
      url: 'https://cdn.example.com/raw.jpg',
    });
    const out = await finalizePipelineImage(img, enabledWm, 'chan', wm, true);
    expect(out.isPostReady).toBe(true);
    expect(out.url).toBe('https://cdn.example.com/wm.png');
    expect(out.pipelinePending).toBe(false);
  });
});
