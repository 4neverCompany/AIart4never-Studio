/**
 * M3.2 (V1.8) — store slimming: embedded pixels OUT of the JSON store.
 *
 * Grounding (Maurice's real store, 2026-06-11): mashupforge.json was
 * 217.7 MB — 103 MB `mashup_saved_images` (236 of 259 entries carried
 * a `data:` URL of ~400-780 KB each and NOT ONE had a `localPath`),
 * plus a byte-identical 103 MB `mashup_saved_images_backup` duplicate.
 * The original roadmap suspect (`mashup_comparison_results`) was
 * EMPTY. Root cause: v1.4.4's file-per-image persistence was only
 * wired into `generateImages` (which nothing calls — Studio and the
 * pipeline go through `generateComparison`) and the Manual panel, so
 * the watermark flows (`pickComparisonWinner`, pipeline finalize,
 * re-apply) kept writing canvas data-URLs straight into the store.
 * The Tauri plugin-store eagerly JSON.parses the whole file — this is
 * the documented 30+ second studio-mount stall.
 *
 * This module is the single source of "does this record embed pixels,
 * and how do we get them onto disk":
 *   - `hasEmbeddedPixels`  — the predicate.
 *   - `slimImageRecord`    — write pixels to the canonical images dir
 *     (v1.4.4 pattern) and return the slimmed record. Off-Tauri or on
 *     failure it returns null and the caller keeps the fat record (a
 *     later launch retries — the predicate still matches).
 *   - `slimForBackup`      — pure: strip embedded payloads for the
 *     auto-backup snapshot (metadata + remote URLs + localPath refs
 *     survive; raw pixels never belonged in a JSON file).
 *
 * Display is already localPath-aware: GalleryCard/PostReady use
 * `useImageSrc` → `displayUrlAsync` → asset:// resolution.
 */

import type { GeneratedImage } from '@/types/mashup'
import { displayUrlAsync, persistImageToDisk } from './storage'

/** True when the record carries raw pixel data inside the JSON store. */
export function hasEmbeddedPixels(
  img: Pick<GeneratedImage, 'url' | 'base64'>,
): boolean {
  if (typeof img.url === 'string' && img.url.startsWith('data:')) return true
  // Legacy field — pre-v1.3.4 records. Small values (corrupt stubs)
  // are not worth a disk write; the 1 KB floor keeps the predicate
  // from matching garbage.
  if (typeof img.base64 === 'string' && img.base64.length > 1024) return true
  return false
}

/**
 * Persist the embedded pixels to disk and return the slimmed record.
 * Returns null when there is nothing to slim, when running off-Tauri
 * (persistImageToDisk no-ops), or when the write fails — in every
 * null case the caller keeps the original record unchanged.
 *
 * The slimmed record's `url` is the resolved `asset://` (Windows:
 * `http://asset.localhost/...`) URL for the file we just wrote. This
 * is deliberate: 10+ render sites set `src={img.url}` directly, and
 * the posting flows build their source from `url` — keeping the field
 * populated with a webview-loadable URL means NONE of them change.
 * The durable reference is `localPath`; the asset URL embeds an
 * absolute path, so a load-time refresh (see useImages) re-derives it
 * after a folder move or reinstall.
 */
export async function slimImageRecord(
  img: GeneratedImage,
): Promise<GeneratedImage | null> {
  if (!hasEmbeddedPixels(img)) return null
  const src =
    typeof img.url === 'string' && img.url.startsWith('data:')
      ? img.url
      : `data:image/jpeg;base64,${img.base64}`
  const filename = await persistImageToDisk(src, img.id, img.savedAt ?? Date.now())
  if (!filename) return null
  const assetUrl = await displayUrlAsync({ localPath: filename, url: '', base64: undefined })
  // No asset URL (shouldn't happen on Tauri when the write succeeded)
  // → keep the fat record rather than risk a blank image everywhere.
  if (!assetUrl) return null
  return {
    ...img,
    localPath: filename,
    url: assetUrl,
    base64: undefined,
  }
}

/** Asset-protocol detector — covers the macOS/Linux `asset://` form
 *  AND the Windows `http(s)://asset.localhost/` form convertFileSrc
 *  produces. Anything matching is machine-local, NOT publicly
 *  fetchable, and must never be handed to a social platform as-is. */
export function isAssetUrl(url: string): boolean {
  return (
    url.startsWith('asset://')
    || url.startsWith('http://asset.localhost')
    || url.startsWith('https://asset.localhost')
  )
}

/**
 * Pure backup-snapshot slimming: records minus embedded pixels.
 * The auto-backup JSON exists so metadata + re-derivable references
 * survive an app-data wipe; half-megabyte data-URLs per entry made
 * every backup write a 100 MB JSON serialization on a 200ms debounce.
 *
 * Safety rule: only strip a data-URL when the record ALREADY carries a
 * `localPath` (the pixels live as a real file). A fat record that
 * hasn't been migrated yet keeps its payload — the backup must not be
 * the place where pixels silently cease to exist.
 */
export function slimForBackup(images: GeneratedImage[]): GeneratedImage[] {
  return images.map((img) => {
    if (!hasEmbeddedPixels(img)) return img
    if (!img.localPath) return img
    return {
      ...img,
      url: typeof img.url === 'string' && img.url.startsWith('data:') ? '' : img.url,
      base64: undefined,
    }
  })
}
