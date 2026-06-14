/**
 * Image Storage — file-per-image, robust against JSON corruption.
 *
 * Why this exists
 * ---------------
 * v1.3.3 and earlier stored the image library as a single JSON blob in
 * the Tauri plugin-store (`%APPDATA%\com.4nevercompany.mashupforge\mashupforge.json`).
 * Three problems with that:
 *
 *   1. **Single point of failure.** One corrupt write = every saved
 *      image lost. There's no partial recovery — either the JSON
 *      parses or it doesn't.
 *
 *   2. **Temporary source URLs.** The image `url` field points to the
 *      Higgsfield CDN, which expires (typically 24-72h). After expiry
 *      the gallery card shows a broken image and the JSON metadata
 *      is the only thing left.
 *
 *   3. **Unbounded JSON size.** Every base64 fallback embedded in the
 *      blob. 200 generated images × 500 KB each = 100 MB JSON that
 *      has to be read/written on every save.
 *
 * What this module does
 * ---------------------
 * Each generated image gets downloaded to a real file on disk the
 * moment it succeeds. The metadata in `mashupforge.json` shrinks to
 * a thin record (id, prompt, tags, model info, …, plus the relative
 * `localPath`). The file itself is the source of truth for pixels.
 *
 *   %APPDATA%\com.4nevercompany.mashupforge\
 *   ├── mashupforge.json                          # metadata only
 *   └── images\generated\
 *       ├── 2026-06-09_img-1717900000-0.jpg
 *       ├── 2026-06-09_img-1717900000-1.jpg
 *       └── ...
 *
 * Failure mode is now granular: one bad byte in one JPEG = one broken
 * thumbnail, not a wiped library. The metadata survives, the user
 * can still see the prompt/tags, and they can re-generate the broken
 * one.
 *
 * Display: `displayUrlAsync(image)` returns a Tauri-`asset://` URL
 * that the WebView2 can render. Falls back to the live CDN URL if
 * the file is missing (and to a data-URL base64 fallback for legacy
 * entries).
 */

import { type GeneratedImage } from '@/types/mashup'

const IMAGES_SUBDIR = ['images', 'generated'] as const

/**
 * Where on disk generated image files live. Returns the absolute path
 * in Tauri (`%APPDATA%\com.4nevercompany.mashupforge\images\generated\`)
 * or `null` if we're not in a Tauri runtime (web/test).
 */
export async function getImagesDir(): Promise<string | null> {
  if (typeof window === 'undefined') return null
  const tauriInternals = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  const tauriLegacy = (window as unknown as { __TAURI__?: unknown }).__TAURI__
  if (!tauriInternals && !tauriLegacy) return null
  try {
    const { appDataDir, join } = await import('@tauri-apps/api/path')
    const base = await appDataDir()
    let dir = base
    for (const seg of IMAGES_SUBDIR) {
      dir = await join(dir, seg)
    }
    return dir
  } catch {
    return null
  }
}

/**
 * Stable, sortable filename derived from the image id and creation
 * timestamp. We use a YYYY-MM-DD prefix so users browsing the folder
 * in Explorer see their images grouped by generation day.
 */
export function buildImageFilename(id: string, savedAt: number): string {
  const d = new Date(savedAt || Date.now())
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  // Strip any path-unsafe chars from the id (defensive; ids are
  // `img-<timestamp>-<i>` so this is rarely needed).
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `${yyyy}-${mm}-${dd}_${safeId}.jpg`
}

/**
 * Infer the file extension from the source URL's content-type or path
 * hint. Defaults to `.jpg` since that's the most common AI output
 * format. The actual format is determined by the byte stream, not
 * the extension — we save the raw bytes we received.
 */
function extensionFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const p = u.pathname.toLowerCase()
    if (p.endsWith('.png')) return '.png'
    if (p.endsWith('.webp')) return '.webp'
    if (p.endsWith('.gif')) return '.gif'
    if (p.endsWith('.mp4') || p.endsWith('.mov')) return '.mp4'
  } catch {
    /* not a URL */
  }
  return '.jpg'
}

/**
 * Download a generated image from its source URL and write it to the
 * Tauri app data dir as a real file. Returns the relative filename
 * (e.g. `2026-06-09_img-...jpg`) on success, or `null` on failure.
 *
 * Failures are non-fatal: we return `null` and the caller keeps the
 * original `url` in the metadata. The image is still displayable from
 * the CDN until that URL expires, and the metadata record is intact.
 */
export async function persistImageToDisk(
  sourceUrl: string,
  imageId: string,
  savedAt: number,
): Promise<string | null> {
  const dir = await getImagesDir()
  if (!dir) return null
  if (!sourceUrl) return null

  try {
    // Make sure the directory exists. mkdir({ recursive: true }) is a
    // no-op if the directory already exists.
    const { mkdir } = await import('@tauri-apps/plugin-fs')
    await mkdir(dir, { recursive: true })

    // Fetch the bytes. CORS matters here — if the upstream CDN
    // refuses, we'll catch the error below and return null.
    const res = await fetch(sourceUrl)
    if (!res.ok) return null
    const bytes = new Uint8Array(await res.arrayBuffer())

    // Prefer the source URL's extension; fall back to jpg.
    const ext = extensionFromUrl(sourceUrl)
    const baseName = buildImageFilename(imageId, savedAt).replace(/\.jpg$/, '')
    const filename = `${baseName}${ext}`

    const { writeFile } = await import('@tauri-apps/plugin-fs')
    const { join } = await import('@tauri-apps/api/path')
    const filePath = await join(dir, filename)
    await writeFile(filePath, bytes)
    return filename
  } catch {
    return null
  }
}

/**
 * Where approved images are exported for discoverability — the user's
 * real Documents folder, NOT the hidden appdata dir. Returns
 * `Documents\MashupForge\Images` (or the platform equivalent) in Tauri,
 * or `null` off-Tauri (web/test). Scoped in
 * src-tauri/capabilities/default.json under `$DOCUMENT/MashupForge/Images`.
 */
export async function getApprovedImagesDocDir(): Promise<string | null> {
  if (typeof window === 'undefined') return null
  const tauriInternals = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  const tauriLegacy = (window as unknown as { __TAURI__?: unknown }).__TAURI__
  if (!tauriInternals && !tauriLegacy) return null
  try {
    const { documentDir, join } = await import('@tauri-apps/api/path')
    const base = await documentDir()
    return await join(base, 'MashupForge', 'Images')
  } catch {
    return null
  }
}

/**
 * V1.5: persist an APPROVED image to disk in two places, from a single
 * fetch:
 *
 *   1. the canonical app-data store (`images/generated/`) — the source
 *      of truth that `displayUrlAsync` / `deleteImageFile` resolve, and
 *   2. a discoverable copy in `Documents\MashupForge\Images` so the user
 *      can find their approved posts as ordinary files.
 *
 * Returns the canonical app-data filename (to write into `localPath`) on
 * success, or `null` off-Tauri / on failure. The Documents copy is
 * best-effort: a scope/permission failure there never blocks the
 * canonical write. Pass the POST-watermark URL so the saved file carries
 * the watermark the user approved.
 */
export async function persistApprovedImageToDisk(
  sourceUrl: string,
  imageId: string,
  savedAt: number,
): Promise<string | null> {
  const dir = await getImagesDir()
  if (!dir || !sourceUrl) return null

  try {
    const { mkdir, writeFile } = await import('@tauri-apps/plugin-fs')
    const { join } = await import('@tauri-apps/api/path')

    await mkdir(dir, { recursive: true })

    const res = await fetch(sourceUrl)
    if (!res.ok) return null
    const bytes = new Uint8Array(await res.arrayBuffer())

    const ext = extensionFromUrl(sourceUrl)
    const baseName = buildImageFilename(imageId, savedAt).replace(/\.jpg$/, '')
    const filename = `${baseName}${ext}`

    // 1. Canonical app-data write (source of truth).
    const canonicalPath = await join(dir, filename)
    await writeFile(canonicalPath, bytes)

    // 2. Discoverable Documents copy — best-effort, never fatal.
    try {
      const docDir = await getApprovedImagesDocDir()
      if (docDir) {
        await mkdir(docDir, { recursive: true })
        const docPath = await join(docDir, filename)
        await writeFile(docPath, bytes)
      }
    } catch {
      /* Documents copy is optional; canonical write already succeeded. */
    }

    return filename
  } catch {
    return null
  }
}

/**
 * Convert a stored image record into a URL that the WebView2 can
 * render WITHOUT resolving the local filesystem path. Priority:
 *
 *   1. `url` (live CDN) — works until expiry.
 *   2. `base64` (legacy fallback) — data URL.
 *   3. '' (broken — show placeholder).
 *
 * Components that can use a hook (most of the gallery) should call
 * `displayUrlAsync` instead, which resolves the local file to a
 * webview-loadable `asset://` URL. The sync version is here for
 * non-hook contexts (download buttons, OG-image rendering, etc).
 */
export function displayUrl(image: Pick<GeneratedImage, 'localPath' | 'url' | 'base64'>): string {
  if (image.url) return image.url
  if (image.base64) return `data:image/jpeg;base64,${image.base64}`
  return ''
}

/**
 * Async version of `displayUrl` — resolves the absolute path of the
 * image file from the Tauri app data dir and returns a
 * webview-loadable `asset://` URL via `convertFileSrc`. Use this in
 * components that have access to a `useEffect` or a state slot.
 */
export async function displayUrlAsync(
  image: Pick<GeneratedImage, 'localPath' | 'url' | 'base64'>,
): Promise<string> {
  if (image.localPath) {
    const dir = await getImagesDir()
    if (dir) {
      try {
        const { join } = await import('@tauri-apps/api/path')
        const abs = await join(dir, image.localPath)
        const { convertFileSrc } = await import('@tauri-apps/api/core')
        return convertFileSrc(abs)
      } catch {
        /* fall through to CDN url */
      }
    }
  }
  if (image.url) return image.url
  if (image.base64) return `data:image/jpeg;base64,${image.base64}`
  return ''
}

/**
 * Check whether the local file for a stored image still exists. Used
 * by the gallery to mark broken-but-known entries (metadata survives,
 * pixels are gone) and to trigger re-download from the CDN when
 * possible.
 */
export async function imageFileExists(filename: string): Promise<boolean> {
  if (!filename) return false
  const dir = await getImagesDir()
  if (!dir) return false
  try {
    const { stat } = await import('@tauri-apps/plugin-fs')
    const { join } = await import('@tauri-apps/api/path')
    const filePath = await join(dir, filename)
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Delete a single image file from disk. Called when the user removes
 * an image from their library. We don't fail loudly if the file is
 * already gone — the metadata removal is the source of truth.
 */
export async function deleteImageFile(filename: string): Promise<boolean> {
  if (!filename) return false
  const dir = await getImagesDir()
  if (!dir) return false
  try {
    const { remove } = await import('@tauri-apps/plugin-fs')
    const { join } = await import('@tauri-apps/api/path')
    const filePath = await join(dir, filename)
    await remove(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * List every image file currently on disk. Used by the recovery
 * flow to reconcile metadata with the filesystem — if a file exists
 * on disk but the metadata is gone, we can re-import it.
 */
export async function listImageFiles(): Promise<string[]> {
  const dir = await getImagesDir()
  if (!dir) return []
  try {
    const { readDir } = await import('@tauri-apps/plugin-fs')
    const entries = await readDir(dir)
    return entries
      .filter((e: unknown): e is { name: string } => {
        if (typeof e !== 'object' || e === null) return false
        const obj = e as Record<string, unknown>
        return typeof obj.name === 'string' && obj.isFile === true
      })
      .map((e) => e.name)
  } catch {
    return []
  }
}
