/**
 * V1.7.1-M3.2b-WATERMARK-DISK: file-per-watermark, mirrors the
 * lib/images/storage.ts pattern from M3.2 (PR #77).
 *
 * Why this exists
 * ---------------
 * The watermark logo used to live as a base64 data-URL in
 * `settings.watermark.image`. For a 10.7 MB PNG that's 10.7 MB
 * serialized into localStorage on every settings save (300ms debounce)
 * and the same 10.7 MB fought the beforeunload localStorage quota flush.
 * Plus, every render of GalleryCard / ImageDetailModal / the Settings
 * preview serialized the whole string into the React tree even when the
 * user wasn't looking at the watermark.
 *
 * Pattern (mirrors lib/images/storage.ts)
 * ---------------------------------------
 *   %APPDATA%\com.4nevercompany.mashupforge\
 *   └── images\
 *       └── watermark\
 *           └── wm_<hash>.png
 *
 * The store keeps ONLY a thin reference (`settings.watermark.imageRef`):
 *
 *   { hash: string; size: number; mimeType: 'image/png' | 'image/jpeg' | 'image/svg+xml'; filename: string }
 *
 * The on-disk file is the source of truth for pixels. Components that
 * need to display the watermark call `displayWatermarkUrlAsync(ref)`,
 * which returns a webview-loadable `asset://` URL via Tauri
 * `convertFileSrc` (or a data-URL fallback for the web preview build).
 *
 * Why we DON'T change the consumer signature
 * ------------------------------------------
 * `lib/watermark.ts applyWatermark` and the two preview components
 * (GalleryCard / ImageDetailModal) all read
 * `settings.watermark.image` and hand it straight to `new Image().src`.
 * If we change the field's runtime value from `data:image/png;base64,…`
 * to `asset://localhost/wm_<hash>.png`, that still loads in Tauri.
 * So we can do the entire refactor by:
 *
 *   1. Adding `imageRef` to the type (new field, additive).
 *   2. Keeping `image` populated at runtime with the asset:// URL.
 *   3. Migrating once on load (see ./migrate.ts).
 *   4. Setting `image` from the upload handler in SettingsModal.
 *
 * No consumer has to change.
 *
 * File format: we keep the user's original bytes (PNG, JPEG, SVG) —
 * `displayWatermarkUrlAsync` doesn't transcode, so the watermark
 * renders pixel-identical to what the user uploaded.
 */

import { type WatermarkImageRef } from '@/types/mashup'

const WATERMARK_SUBDIR = ['images', 'watermark'] as const

/**
 * Where on disk watermark files live. Returns the absolute path
 * in Tauri (`%APPDATA%\com.4nevercompany.mashupforge\images\watermark\`)
 * or `null` if we're not in a Tauri runtime (web/test).
 *
 * Note: the watermark dir is a SINGLE-FILE dir by design — only the
 * current logo lives there. Switching the watermark deletes the old
 * one (see `removeWatermarkFile`).
 */
export async function getWatermarkDir(): Promise<string | null> {
  if (typeof window === 'undefined') return null
  const tauriInternals = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  const tauriLegacy = (window as unknown as { __TAURI__?: unknown }).__TAURI__
  if (!tauriInternals && !tauriLegacy) return null
  try {
    const { appDataDir, join } = await import('@tauri-apps/api/path')
    const base = await appDataDir()
    let dir = base
    for (const seg of WATERMARK_SUBDIR) {
      dir = await join(dir, seg)
    }
    return dir
  } catch {
    return null
  }
}

/**
 * Stable, content-addressed filename for the watermark file. We use
 * a short hash of the bytes (8 hex chars) so two users uploading the
 * same logo share a filename (handy for re-use after re-install), and
 * a deterministic name that doesn't depend on the upload time.
 *
 * The hash is recomputed by the caller from the file bytes — we don't
 * trust whatever the uploader claims the hash is.
 */
export function buildWatermarkFilename(hash: string, ext: string): string {
  return `wm_${hash}${ext.startsWith('.') ? ext : `.${ext}`}`
}

/**
 * Infer the file extension from a data-URL's MIME type. The Settings
 * upload handler hands us a File or Blob; we extract the MIME and
 * map it to a stable on-disk extension.
 */
export function extensionFromMime(mime: string): string {
  if (mime === 'image/png') return '.png'
  if (mime === 'image/jpeg' || mime === 'image/jpg') return '.jpg'
  if (mime === 'image/svg+xml') return '.svg'
  if (mime === 'image/webp') return '.webp'
  if (mime === 'image/gif') return '.gif'
  return '.png' // safest fallback for AI-generated logos
}

/**
 * Parse a data-URL into its MIME type and base64 payload. Returns
 * `null` if the input isn't a `data:image/...` URL — that's the
 * migration signal ("this is a legacy in-store data-URL that needs
 * to be moved to disk").
 */
export function parseDataUrl(
  input: string,
): { mime: 'image/png' | 'image/jpeg' | 'image/svg+xml' | 'image/webp' | 'image/gif'; bytes: Uint8Array } | null {
  if (!input || !input.startsWith('data:')) return null
  const match = /^data:([^;]+);base64,(.+)$/.exec(input)
  if (!match) return null
  const mime = match[1]
  if (!mime.startsWith('image/')) return null
  // base64 → bytes
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return { mime: mime as 'image/png' | 'image/jpeg' | 'image/svg+xml' | 'image/webp' | 'image/gif', bytes }
}

/**
 * Compute a short 8-char hex hash of the watermark bytes. Used as the
 * content-addressed filename component. NOT cryptographic — we just
 * want stable identity for re-use. FNV-1a 32-bit, hex-truncated to 8.
 */
export function hashBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    // 32-bit FNV prime, applied byte-wise
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, '0').slice(0, 8)
}

/**
 * Persist a new watermark file to disk. The caller passes either:
 *   - a data-URL (from the upload handler), OR
 *   - raw bytes + mime (from the migration path, see ./migrate.ts).
 *
 * Returns a `WatermarkImageRef` to write into `settings.watermark.imageRef`,
 * or `null` on failure (off-Tauri, write error, etc). The `image` field
 * of the setting should be set to the asset:// URL returned by
 * `displayWatermarkUrlAsync(ref)` — call sites usually do that
 * immediately after this resolves.
 *
 * On success, the previous watermark file (if any) is removed. We
 * intentionally keep a single-file dir, not a history.
 */
export async function persistWatermarkToDisk(
  input: { bytes: Uint8Array; mime: string } | { dataUrl: string },
): Promise<WatermarkImageRef | null> {
  const dir = await getWatermarkDir()
  if (!dir) return null

  let bytes: Uint8Array
  let mime: string
  if ('dataUrl' in input) {
    const parsed = parseDataUrl(input.dataUrl)
    if (!parsed) return null
    bytes = parsed.bytes
    mime = parsed.mime
  } else {
    bytes = input.bytes
    mime = input.mime
  }

  const hash = hashBytes(bytes)
  const ext = extensionFromMime(mime)
  const filename = buildWatermarkFilename(hash, ext)

  try {
    const { mkdir, writeFile, remove, readDir } = await import('@tauri-apps/plugin-fs')
    const { join } = await import('@tauri-apps/api/path')
    const filePath = await join(dir, filename)

    await mkdir(dir, { recursive: true })
    await writeFile(filePath, bytes)

    // Best-effort cleanup of the previous watermark file (single-file dir).
    // We don't fail the new write if cleanup errors out — the new file
    // is the source of truth, the old one is just dead bytes.
    try {
      const entries = await readDir(dir)
      for (const e of entries as Array<{ name?: string; isFile?: boolean }>) {
        if (e && e.isFile && e.name && e.name !== filename && e.name.startsWith('wm_')) {
          try {
            await remove(await join(dir, e.name))
          } catch {
            /* swallow — best-effort cleanup */
          }
        }
      }
    } catch {
      /* swallow — best-effort cleanup */
    }

    return { hash, filename, mimeType: mime as WatermarkImageRef['mimeType'], size: bytes.byteLength }
  } catch (e) {
    // Debug aid: surface the underlying failure when persist can't
    // complete (e.g. fs scope mismatch in Tauri). The caller treats
    // null as "fall back to legacy data-URL" — the error here is
    // visible to the user via the warning that fall-back path emits.
    console.warn('[watermark] persist failed:', e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * Resolve a stored `WatermarkImageRef` to a webview-loadable URL.
 *
 *   - Tauri: `asset://localhost/...` (via `convertFileSrc`) so the
 *     WebView2 can `<img src=...>` it without a custom protocol handler.
 *   - Off-Tauri (web preview, test): no asset:// exists, so we return
 *     a placeholder. Callers that need a guaranteed-loadable URL
 *     should pass the data-URL fallback at hydration time (the
 *     migration helper in ./migrate.ts does this for the user).
 *
 * Returns `null` if the file is missing on disk or we're not in a
 * Tauri runtime with a ref to resolve.
 */
export async function displayWatermarkUrlAsync(ref: WatermarkImageRef | undefined | null): Promise<string | null> {
  if (!ref) return null
  if (typeof window === 'undefined') return null
  const tauriInternals = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  const tauriLegacy = (window as unknown as { __TAURI__?: unknown }).__TAURI__
  if (!tauriInternals && !tauriLegacy) return null
  try {
    const dir = await getWatermarkDir()
    if (!dir) return null
    const { join } = await import('@tauri-apps/api/path')
    const abs = await join(dir, ref.filename)
    const { convertFileSrc } = await import('@tauri-apps/api/core')
    return convertFileSrc(abs)
  } catch {
    return null
  }
}

/**
 * Check whether the watermark file is still on disk. Used by the
 * settings UI to show a "missing" hint if the user nuked the file
 * from outside the app.
 */
export async function watermarkFileExists(ref: WatermarkImageRef | undefined | null): Promise<boolean> {
  if (!ref) return false
  const dir = await getWatermarkDir()
  if (!dir) return false
  try {
    const { stat } = await import('@tauri-apps/plugin-fs')
    const { join } = await import('@tauri-apps/api/path')
    await stat(await join(dir, ref.filename))
    return true
  } catch {
    return false
  }
}

/**
 * Delete the on-disk watermark file. Called when the user clicks
 * "Remove watermark" in Settings, OR when the user uploads a new
 * logo (the previous one is reaped). Idempotent — missing files
 * don't error.
 */
export async function removeWatermarkFile(): Promise<boolean> {
  const dir = await getWatermarkDir()
  if (!dir) return false
  try {
    const { readDir, remove } = await import('@tauri-apps/plugin-fs')
    const { join } = await import('@tauri-apps/api/path')
    const entries = await readDir(dir)
    for (const e of entries as Array<{ name?: string; isFile?: boolean }>) {
      if (e && e.isFile && e.name && e.name.startsWith('wm_')) {
        try {
          await remove(await join(dir, e.name))
        } catch {
          /* swallow — missing file is fine */
        }
      }
    }
    return true
  } catch {
    return false
  }
}
