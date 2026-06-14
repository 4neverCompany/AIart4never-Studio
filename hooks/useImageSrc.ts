'use client';

/**
 * useImageSrc — resolves a GeneratedImage to a webview-loadable URL.
 *
 * Three-layer resolution:
 *
 *   1. `localPath` (real file on disk) → `asset://` URL via Tauri
 *      `convertFileSrc`. This is the source of truth once the image
 *      has been persisted to disk.
 *
 *   2. `url` (live CDN) — works until the Higgsfield CDN expires.
 *      Used as a fallback while the local file is being downloaded
 *      or if the download failed.
 *
 *   3. `base64` (legacy fallback) — a data URL, slow to render for
 *      large images but works without any network.
 *
 *   4. '' — broken; the caller should show a placeholder.
 *
 * The hook stores the resolved URL in state and re-runs the
 * resolution only when the image id changes — calling
 * `convertFileSrc` on every render would be wasteful (it's a syscall
 * that goes through Tauri's IPC).
 */

import { useEffect, useState } from 'react'
import { type GeneratedImage } from '@/types/mashup'
import { displayUrl, displayUrlAsync } from '@/lib/images/storage'

export function useImageSrc(image: Pick<GeneratedImage, 'id' | 'localPath' | 'url' | 'base64'> | null | undefined): string {
  // First render: use the sync fallback so the <img> tag has
  // *something* to show. Tauri-aware async resolution patches this
  // in on the next frame.
  const [src, setSrc] = useState<string>(() => (image ? displayUrl(image) : ''))

  useEffect(() => {
    // react-hooks/set-state-in-effect: the synchronous setSrc calls
    // are deferred via queueMicrotask (project convention) and share
    // the async path's cancellation guard.
    let cancelled = false
    if (!image) {
      queueMicrotask(() => {
        if (!cancelled) setSrc('')
      })
    } else if (image.localPath) {
      // If we have a localPath, do the async Tauri resolution. The
      // URL is stable across re-renders unless the image id changes.
      void (async () => {
        const resolved = await displayUrlAsync(image)
        if (!cancelled) setSrc(resolved)
      })()
    } else {
      // No local file — use the sync fallback (CDN url or data URL).
      queueMicrotask(() => {
        if (!cancelled) setSrc(displayUrl(image))
      })
    }
    return () => {
      cancelled = true
    }
  }, [image?.id, image?.localPath, image?.url, image?.base64, image])

  return src
}
