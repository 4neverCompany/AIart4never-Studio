// BUG-CRIT-001: integration test for the watermark-on-approval contract.
// The pipeline-produced-post gate previously lived alongside this in the
// daemon (pipeline-processor.processIdea), but the daemon web has been
// removed. What remains — and still matters — is the approval-flow
// watermark step that MashupContext.approveScheduledPost drives via
// finalizePipelineImagesForPosts → finalizePipelineImage.
//
// Fix contract (surviving half):
//   finalizePipelineImage (called by MashupContext.approveScheduledPost
//   via finalizePipelineImagesForPosts) applies the watermark and
//   clears pipelinePending so Gallery lights up.

import { describe, it, expect, vi } from 'vitest';
import { finalizePipelineImage } from '@/lib/pipeline-finalize';
import type {
  GeneratedImage,
  WatermarkSettings,
} from '@/types/mashup';

describe('BUG-CRIT-001 — watermark-on-approval contract', () => {
  // The watermark pass is performed in MashupContext.approveScheduledPost
  // via finalizePipelineImagesForPosts → finalizePipelineImage. These
  // tests pin the contract for the helper that the approval handler
  // calls so a future refactor can't silently break the wiring.

  const enabledWatermark: WatermarkSettings = {
    enabled: true,
    image: 'data:image/png;base64,IGNORED',
    position: 'bottom-right',
    opacity: 0.6,
    scale: 0.15,
  };

  it('applies the watermark and clears pipelinePending on approval', async () => {
    const applyWatermark = vi.fn().mockResolvedValue('watermarked-url');
    const img: GeneratedImage = {
      id: 'i1',
      prompt: 'p',
      url: 'original-url',
      pipelinePending: true,
    };

    const out = await finalizePipelineImage(img, enabledWatermark, 'chan', applyWatermark);

    expect(applyWatermark).toHaveBeenCalledWith('original-url', enabledWatermark, 'chan');
    expect(out.url).toBe('watermarked-url');
    expect(out.pipelinePending).toBe(false);
  });

  it('still clears pipelinePending when the user has watermark disabled', async () => {
    const applyWatermark = vi.fn();
    const img: GeneratedImage = {
      id: 'i1',
      prompt: 'p',
      url: 'original-url',
      pipelinePending: true,
    };

    const out = await finalizePipelineImage(
      img,
      { ...enabledWatermark, enabled: false },
      'chan',
      applyWatermark,
    );

    expect(applyWatermark).not.toHaveBeenCalled();
    expect(out.url).toBe('original-url');
    expect(out.pipelinePending).toBe(false);
  });

  // BUG-DEV-004: watermark failures used to swallow silently. The
  // catch now both keeps the original URL (existing contract) AND
  // surfaces a warning to the dev console (new contract) so a broken
  // watermark service is debuggable.
  it('keeps the original URL AND warns when applyWatermark rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const applyWatermark = vi.fn().mockRejectedValue(new Error('canvas blew up'));
      const img: GeneratedImage = {
        id: 'i-broken',
        prompt: 'p',
        url: 'original-url',
        pipelinePending: true,
      };

      const out = await finalizePipelineImage(img, enabledWatermark, 'chan', applyWatermark);

      // Existing contract: original URL preserved, pipelinePending cleared.
      expect(out.url).toBe('original-url');
      expect(out.pipelinePending).toBe(false);

      // New contract: warning logged with module tag + image id + error.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [msg, id, err] = warnSpy.mock.calls[0]!;
      expect(msg).toBe('[pipeline-finalize] watermark failed for');
      expect(id).toBe('i-broken');
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('canvas blew up');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
