/**
 * Gallery zombie reconciler (2026-06-14).
 *
 * The saved-image store (`mashup_saved_images`) only ever GROWS — nothing
 * checks a record against what's actually on disk. When the pixels go away
 * (an NSIS reinstall wipes the images dir, a file is deleted out-of-band, a
 * remote-only URL expires) the metadata record survives. Result: the gallery
 * COUNTS hundreds of "images" but can only display the ~third that still have
 * reachable pixels, and the auto-backup JSON re-serializes all of them on
 * every mutation (a likely cause of the click/approve freeze).
 *
 * This module finds those zombie records. Per Maurice's call (2026-06-14):
 *   - "alive" = the pixels are reachable WITHOUT the network: an embedded
 *     base64, OR an on-disk file (`localPath`). A remote-only `url` does NOT
 *     count — Leonardo/CDN links expire, so a record whose only handle is a
 *     (possibly dead) url is treated as missing.
 *   - We MARK, never auto-delete. The caller surfaces a count + a
 *     user-confirmed "remove N missing" action. No silent data loss.
 *   - Desktop only. On web there are no local files, so we cannot tell a
 *     remote-only record is dead without a network probe — we report none.
 */

import type { GeneratedImage } from '@/types/mashup'
import { imageFileExists } from './storage'

function detectTauri(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__)
}

export interface FindMissingOptions {
  /** Max concurrent fs.stat calls (default 16) so a 300-image scan doesn't
   *  fan out 300 IPC calls at once. */
  concurrency?: number
  /** Existence probe — injectable for tests. Defaults to imageFileExists. */
  fileExists?: (filename: string) => Promise<boolean>
  /** Override the Tauri detection (tests). When false, returns an empty set. */
  isDesktop?: boolean
}

/**
 * Returns the ids of saved images whose pixels are gone (zombies). Never
 * mutates the input and never deletes anything — the caller decides.
 */
export async function findMissingImageIds(
  images: readonly GeneratedImage[],
  opts: FindMissingOptions = {},
): Promise<Set<string>> {
  const missing = new Set<string>()
  const isDesktop = opts.isDesktop ?? detectTauri()
  if (!isDesktop) return missing

  const fileExists = opts.fileExists ?? imageFileExists
  const concurrency = Math.max(1, opts.concurrency ?? 16)

  for (let i = 0; i < images.length; i += concurrency) {
    const chunk = images.slice(i, i + concurrency)
    const aliveFlags = await Promise.all(
      chunk.map(async (img) => {
        // base64 pixels are self-contained — always displayable.
        if (typeof img.base64 === 'string' && img.base64.length > 0) return true
        // An on-disk file is the durable, network-free source of truth.
        if (img.localPath) {
          try {
            if (await fileExists(img.localPath)) return true
          } catch {
            // A probe failure is NOT proof of death — treat as alive so a
            // transient fs hiccup can never flag a real image for removal.
            return true
          }
        }
        return false
      }),
    )
    chunk.forEach((img, j) => {
      if (!aliveFlags[j]) missing.add(img.id)
    })
  }

  return missing
}
