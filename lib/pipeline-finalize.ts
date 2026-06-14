// V040-HOTFIX-007: approval-time finalization for pipeline-generated
// images. A pipeline run saves images with `pipelinePending: true` when
// the associated ScheduledPost lands as `pending_approval`. Approval
// then (a) clears that flag so Gallery renders the image, and
// (b) applies the watermark that generateComparison never got around to
// applying during the pipeline run.
//
// Pure helpers — async canvas work lives in `applyWatermark` (passed in
// from useImageGeneration). Keeps this file testable without jsdom.

import type { GeneratedImage, ScheduledPost, WatermarkSettings } from '../types/mashup';

export type ApplyWatermarkFn = (
  baseImageSrc: string,
  settings: WatermarkSettings,
  channelName?: string,
) => Promise<string>;

/**
 * Returns the subset of `images` that an approval for this post should
 * finalize: images whose `pipelinePending` flag is still set AND that
 * belong to the post — either directly (`post.imageId === img.id`) or
 * transitively via a shared carousel group
 * (`post.carouselGroupId === img.carouselGroupId`).
 *
 * An image that is no longer pipelinePending is skipped: it was either
 * never pipeline-origin or has already been finalized.
 */
export function collectFinalizeTargets(
  post: Pick<ScheduledPost, 'imageId' | 'carouselGroupId'>,
  images: GeneratedImage[],
): GeneratedImage[] {
  const directId = post.imageId;
  const groupId = post.carouselGroupId;
  return images.filter((img) => {
    if (img.pipelinePending !== true) return false;
    if (img.id === directId) return true;
    if (groupId && img.carouselGroupId === groupId) return true;
    return false;
  });
}

/**
 * Applies the watermark (if enabled) and clears the `pipelinePending`
 * flag. Returns the image object the caller should persist via
 * `saveImage`. Watermark failures are swallowed — a missing watermark
 * must never block an approval, because the ScheduledPost has already
 * flipped to `scheduled` and the auto-poster may pick it up at any
 * moment.
 *
 * BUG-CRIT-013: when `markPostReady` is true, also flips `isPostReady`
 * so the image surfaces in the Post Ready tab. Approve path passes
 * true (the user just approved a scheduled post — Post Ready is where
 * scheduled content lives). Reject path passes false (rejected images
 * land in Gallery only, never Post Ready).
 */
export async function finalizePipelineImage(
  img: GeneratedImage,
  watermark: WatermarkSettings | undefined,
  channelName: string | undefined,
  applyWatermark: ApplyWatermarkFn,
  markPostReady = false,
): Promise<GeneratedImage> {
  let finalUrl = img.url;
  // BUG-FIX-2026-06-06: detect videos and skip the image-only
  // canvas watermark. The data model treats videos and images as
  // `GeneratedImage` (they share the same shape), discriminated by
  // `isVideo`. Canvas-based watermarks don't apply to video URLs —
  // they corrupt the file (Canvas rasterizes the URL and produces an
  // image, not a video). For videos we leave the URL untouched and
  // log the gap. TODO: implement a server-side FFmpeg-based video
  // watermark (lib/pipeline-finalize.video.ts) once a host is wired
  // up that has FFmpeg available. For now, videos ship as-is, which
  // is the pre-existing behavior (just no longer pretending to
  // watermark and silently producing a broken raster).
  const isVideo = img.isVideo === true;
  if (watermark?.enabled && finalUrl && !isVideo) {
    try {
      finalUrl = await applyWatermark(finalUrl, watermark, channelName);
    } catch (err) {
      // Watermark failed — keep the original URL and ship as-is.
      // BUG-DEV-004: surface the failure to the dev console so a broken
      // watermark service is debuggable. Silent fallback masked an
      // outage where every approved image landed un-watermarked with
      // no signal to the developer or user.
      console.warn('[pipeline-finalize] watermark failed for', img.id, err);
      finalUrl = img.url;
    }
  } else if (isVideo && watermark?.enabled) {
    // Video watermark is not yet implemented. Log once per finalize
    // so dev console shows the gap; the URL is preserved as-is.
    console.warn(
      '[pipeline-finalize] video watermark not yet implemented, shipping without watermark for',
      img.id,
    );
  }
  return {
    ...img,
    url: finalUrl,
    pipelinePending: false,
    // F-001: explicit `false` on the reject path so a previously-approved
    // image (already isPostReady: true in the gallery) doesn't keep
    // appearing in Post Ready after rejection. The empty-spread variant
    // would have been a no-op and silently violated the "rejected
    // images land in Gallery only, never Post Ready" contract.
    isPostReady: markPostReady,
  };
}
