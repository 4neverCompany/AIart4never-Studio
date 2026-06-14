/**
 * Watermark compositor + re-apply helper.
 *
 * `applyWatermark` was originally defined inside hooks/useImageGeneration.ts.
 * V1.5 extracted it here (it has zero hook/React dependencies — it's a pure
 * canvas operation) so the re-apply helper can import it without pulling the
 * ~1600-line generation hook into a cycle. useImageGeneration re-exports it
 * for backward compatibility, so every existing importer keeps working.
 */

import type { WatermarkSettings, GeneratedImage } from '@/types/mashup';

/**
 * Composite the user's watermark (image or channel-name text) onto a base
 * image and return a JPEG data URL. Returns the input unchanged when the
 * watermark is disabled or there's nothing to draw. HTTP sources are routed
 * through /api/proxy-image to dodge canvas CORS taint.
 */
// V1.7.0-PERF: max time to wait for the base/watermark images to load
// before giving up and shipping the un-watermarked base. 15s is generous
// for a healthy CDN; the point is to convert an *infinite* hang into a
// bounded, recoverable one.
export const WATERMARK_LOAD_TIMEOUT_MS = 15_000;

export async function applyWatermark(
  baseImageSrc: string,
  settings: WatermarkSettings,
  channelName?: string,
): Promise<string> {
  if (!settings.enabled) return baseImageSrc;
  if (!settings.image && !channelName) return baseImageSrc;

  return new Promise((resolveRaw) => {
    // V1.7.0-PERF: bound the whole composite. The base image (a CDN URL
    // routed through /api/proxy-image) and the watermark image both load
    // via `new Image()`, which fires NEITHER onload NOR onerror if the
    // source stalls (slow/expired CDN, dead proxy, oversized data URL).
    // Without this guard the Promise never settled, so every awaiting
    // caller (generation, the pipeline's per-image finalize, the manual
    // "Re-apply watermark" button) hung INDEFINITELY — the freeze Maurice
    // saw. On timeout we ship the un-watermarked base rather than hang.
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRaw(value);
    };
    const timer = setTimeout(() => {
      console.warn('[watermark] image load timed out — shipping un-watermarked base');
      finish(baseImageSrc);
    }, WATERMARK_LOAD_TIMEOUT_MS);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        finish(baseImageSrc);
        return;
      }

      ctx.drawImage(img, 0, 0);
      ctx.globalAlpha = settings.opacity || 0.8;

      // 8% padding (up from 3%) gives watermarks more breathing room
      // even if Instagram applies minor adjustments to the padded image.
      const padding = canvas.width * 0.08;

      if (settings.image) {
        const wm = new Image();
        wm.crossOrigin = 'anonymous';
        wm.onload = () => {
          const wmWidth = canvas.width * (settings.scale || 0.15);
          const wmHeight = (wm.height / wm.width) * wmWidth;

          let x = 0,
            y = 0;
          switch (settings.position) {
            case 'top-left':
              x = padding;
              y = padding;
              break;
            case 'top-right':
              x = canvas.width - wmWidth - padding;
              y = padding;
              break;
            case 'bottom-left':
              x = padding;
              y = canvas.height - wmHeight - padding;
              break;
            case 'bottom-right':
              x = canvas.width - wmWidth - padding;
              y = canvas.height - wmHeight - padding;
              break;
            case 'center':
              x = (canvas.width - wmWidth) / 2;
              y = (canvas.height - wmHeight) / 2;
              break;
          }

          ctx.drawImage(wm, x, y, wmWidth, wmHeight);
          // POST-413-FIX (2026-05-21): JPEG (not PNG) to keep the data URL
          // under Vercel's 4.5MB serverless body limit. The composite has
          // no transparency at this point, so dropping alpha costs nothing.
          finish(canvas.toDataURL('image/jpeg', 0.92));
        };
        wm.onerror = () => finish(baseImageSrc);
        wm.src = settings.image;
      } else if (channelName) {
        const fontSize = canvas.width * (settings.scale || 0.05);
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.fillStyle = 'white';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';

        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 4;
        ctx.shadowOffsetX = 2;
        ctx.shadowOffsetY = 2;

        const metrics = ctx.measureText(channelName);
        const textWidth = metrics.width;
        const textHeight = fontSize;

        let x = 0,
          y = 0;
        switch (settings.position) {
          case 'top-left':
            x = padding;
            y = padding;
            break;
          case 'top-right':
            x = canvas.width - textWidth - padding;
            y = padding;
            break;
          case 'bottom-left':
            x = padding;
            y = canvas.height - textHeight - padding;
            break;
          case 'bottom-right':
            x = canvas.width - textWidth - padding;
            y = canvas.height - textHeight - padding;
            break;
          case 'center':
            x = (canvas.width - textWidth) / 2;
            y = (canvas.height - textHeight) / 2;
            break;
        }

        ctx.fillText(channelName, x, y);
        finish(canvas.toDataURL('image/jpeg', 0.92));
      }
    };
    img.onerror = () => finish(baseImageSrc);
    img.src = baseImageSrc.startsWith('http')
      ? `/api/proxy-image?url=${encodeURIComponent(baseImageSrc)}`
      : baseImageSrc.startsWith('data:')
        ? baseImageSrc
        : `data:image/jpeg;base64,${baseImageSrc}`;
  });
}

/** Result of a re-apply attempt. `skipped` carries a user-facing reason. */
export type ReapplyResult =
  | { ok: true; image: GeneratedImage }
  | { ok: false; skipped: true; reason: string };

/**
 * V1.5: re-apply the current watermark to an already-saved image, for the
 * "Re-apply watermark" action in Captioning / Post-Ready / Gallery.
 *
 * Double-stack protection: re-apply always composites onto the CLEAN base
 * (`image.originalUrl` — the pre-watermark source captured at generation),
 * falling back to `image.url` for legacy images that predate originalUrl.
 * The clean base is preserved on the result so repeated re-applies never
 * stack watermarks.
 *
 * Videos are skipped (canvas can't composite a video frame); the caller
 * shows a toast. Off-Tauri the new data URL displays directly; in Tauri we
 * overwrite the on-disk file (same id+savedAt filename) and refresh
 * localPath so the Gallery (which prefers localPath) shows the new image.
 */
export async function reapplyWatermark(
  image: GeneratedImage,
  settings: WatermarkSettings,
  channelName?: string,
): Promise<ReapplyResult> {
  if (image.isVideo) {
    return { ok: false, skipped: true, reason: 'Watermarks can only be applied to images, not videos.' };
  }
  if (!settings.enabled) {
    return { ok: false, skipped: true, reason: 'Enable the watermark in Settings first.' };
  }
  if (!settings.image && !channelName) {
    return { ok: false, skipped: true, reason: 'Set a watermark image or channel name in Settings first.' };
  }

  const base = image.originalUrl || image.url;
  if (!base) {
    return { ok: false, skipped: true, reason: 'This image has no source to watermark.' };
  }

  const newUrl = await applyWatermark(base, settings, channelName);
  if (newUrl === base) {
    // applyWatermark short-circuited (nothing drawn) — nothing changed.
    return { ok: false, skipped: true, reason: 'Watermark could not be applied.' };
  }

  // Refresh the on-disk file in Tauri so the Gallery (localPath-first)
  // shows the re-watermarked image; off-Tauri persistImageToDisk returns
  // null and the data URL displays directly.
  let localPath: string | undefined;
  try {
    const { persistImageToDisk } = await import('@/lib/images/storage');
    const fn = await persistImageToDisk(newUrl, image.id, image.savedAt ?? Date.now());
    localPath = fn ?? undefined;
  } catch {
    localPath = undefined;
  }

  return {
    ok: true,
    image: {
      ...image,
      url: newUrl,
      originalUrl: base, // remember the clean base for the next re-apply
      localPath, // refreshed file (Tauri) or undefined → show url (web)
    },
  };
}
