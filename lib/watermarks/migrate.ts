/**
 * V1.7.1-M3.2b-WATERMARK-DISK: once-per-session migration from the
 * legacy in-store data-URL watermark to a disk-backed file.
 *
 * Background
 * ----------
 * Pre-M3.2b, `settings.watermark.image` was a base64 data-URL
 * (`data:image/png;base64,…`) persisted directly into localStorage /
 * the Tauri plugin-store. For a 10.7 MB PNG that meant serializing
 * 10.7 MB on every settings save (300ms debounce) and the same
 * 10.7 MB fighting the beforeunload localStorage quota flush.
 *
 * M3.2b moves the bytes to disk (`%APPDATA%\…\images\watermark\…`).
 * The store keeps only a thin `imageRef: { hash, filename, mimeType,
 * size }`. The `image` field is now an `asset://` URL when read in
 * Tauri, or a data-URL fallback during the migration window.
 *
 * When does migration run?
 * ------------------------
 * Pattern mirrors M3.2 (lib/images/slim.ts): once per session, on the
 * first `useSettings` hydration that finds a watermark set. The
 * marker `m32bWatermarkMigrated` is written into a separate
 * `migratedFlags` slice in the store so the migration never repeats,
 * even if the user toggles the watermark off and back on.
 *
 * The migration is best-effort: if the disk write fails, we leave the
 * legacy data-URL alone and the next session will try again. The
 * user's watermark keeps working in the meantime.
 *
 * Atomicity
 * ---------
 * The migration is NOT a single atomic write — it's three steps:
 *
 *   1. Write bytes to disk → `imageRef`
 *   2. Set `settings.watermark.image = <asset:// URL>` + `imageRef`
 *   3. Set `migratedFlags.m32bWatermarkMigrated = true`
 *
 * Step 1 failing is silent (returns null). Step 2 happens AFTER step
 * 1 returns, so a failed step 1 leaves the user's old data-URL
 * watermark still in the store — they keep seeing their logo. Step 3
 * only happens if step 2 lands. If the user closes the app between
 * step 2 and step 3, the next session re-runs step 1 (the same hash
 * lands on the same filename → idempotent over-write), then step 2
 * again. The cost is one redundant disk write per crash boundary —
 * acceptable for a logo that changes once a year.
 */

import type { UserSettings, WatermarkSettings } from '@/types/mashup'
import {
  persistWatermarkToDisk,
  displayWatermarkUrlAsync,
  parseDataUrl,
} from './storage'

/**
 * Detect whether the migration needs to run. We run when:
 *
 *   1. The user has a watermark set (`image` is a non-empty string), AND
 *   2. The store does NOT yet have an `imageRef`, AND
 *   3. The store's `image` is a data-URL (not yet migrated).
 *
 * Off-Tauri (web preview, tests), we skip — there's no disk. The
 * watermark keeps using the data-URL.
 */
export function shouldMigrateWatermark(
  settings: Pick<UserSettings, 'watermark'> | undefined | null,
  isTauri: boolean,
): boolean {
  if (!isTauri) return false
  const wm = settings?.watermark
  if (!wm) return false
  if (wm.imageRef) return false // already migrated
  if (!wm.image) return false
  return wm.image.startsWith('data:')
}

/**
 * Run the migration. Returns the patch to commit to the settings
 * store, or `null` if no migration is needed / possible.
 *
 * The patch, on success, is shaped like:
 *
 *   {
 *     watermark: {
 *       ...settings.watermark,
 *       image: <asset:// URL>,
 *       imageRef: { hash, filename, mimeType, size },
 *     },
 *   }
 *
 * On failure, the function returns `null` and the caller leaves the
 * store alone (legacy data-URL keeps working).
 */
export async function migrateWatermarkToDisk(
  settings: Pick<UserSettings, 'watermark'>,
): Promise<Partial<UserSettings> | null> {
  const wm = settings.watermark
  if (!wm) return null
  if (wm.imageRef) return null
  if (!wm.image || !wm.image.startsWith('data:')) return null

  // 1. Persist the bytes to disk.
  const ref = await persistWatermarkToDisk({ dataUrl: wm.image })
  if (!ref) return null

  // 2. Resolve the asset:// URL.
  const assetUrl = await displayWatermarkUrlAsync(ref)
  if (!assetUrl) return null

  return {
    watermark: {
      ...wm,
      image: assetUrl,
      imageRef: ref,
    },
  }
}

/**
 * Pure helper used by tests + the upload handler. Build the
 * `WatermarkSettings` patch for a freshly-uploaded watermark file.
 *
 * Pre-M3.2b, the upload handler did:
 *
 *   settings.watermark = { ...settings.watermark, image: <data-URL> };
 *
 * M3.2b replaces that with this function's output, which sets
 * `image` to the disk-resolved asset:// URL AND populates `imageRef`.
 */
export interface BuildUploadPatchInput {
  dataUrl: string;
  assetUrl: string;
  hash: string;
  filename: string;
  mimeType: WatermarkImageRef['mimeType'];
  size: number;
}

import type { WatermarkImageRef } from '@/types/mashup'

export function buildWatermarkUploadPatch(
  prev: WatermarkSettings,
  input: BuildUploadPatchInput,
): WatermarkSettings {
  return {
    ...prev,
    image: input.assetUrl,
    imageRef: {
      hash: input.hash,
      filename: input.filename,
      mimeType: input.mimeType,
      size: input.size,
    },
  }
}

/**
 * Pure helper: build the patch for "user removed the watermark".
 * Clears both the runtime image URL AND the persistent ref.
 */
export function buildWatermarkRemovePatch(
  prev: WatermarkSettings,
): WatermarkSettings {
  return {
    ...prev,
    image: null,
    imageRef: undefined,
  }
}

/**
 * Pure helper: parse a data-URL once. Re-exported from storage.ts
 * for the upload handler — saves a duplicate import in
 * SettingsModal.
 */
export const parseWatermarkDataUrl = parseDataUrl
