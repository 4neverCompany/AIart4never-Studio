/**
 * JSON-field backup recovery (V1.4.3)
 *
 * Previous versions (v1.3.2 and earlier) stored image backups in
 * the `mashup_saved_images_backup` field of the Tauri plugin-store
 * JSON blob. When the user updated the app and `mashup_saved_images`
 * got wiped (e.g. by an NSIS reinstall), the backup was orphaned
 * — sitting in the JSON but never re-read.
 *
 * This module adds `restoreFromJsonBackupField()` which:
 *   1. Reads `mashup_saved_images_backup` from the plugin-store
 *   2. Filters out items whose URL is empty (broken records)
 *   3. Persists each URL to disk via `persistImageToDisk` (v1.3.4
 *      file-per-image storage) so future reinstalls survive
 *   4. Writes the records back to `mashup_saved_images`
 *
 * Returns the restored images and a summary of what happened.
 */

import type { GeneratedImage } from '@/types/mashup'
import { get, set } from '@/lib/persistence'
import { persistImageToDisk } from '@/lib/images/storage'

const IMAGES_KEY = 'mashup_saved_images'
const BACKUP_KEY = 'mashup_saved_images_backup'
const MIGRATION_FLAG = 'mashup_backup_migrated_v1_4_3'

export interface BackupRecoveryReport {
  found: number
  restored: number
  broken: number
  persisted: number
  skipped: boolean
  reason?: string
}

/**
 * Idempotent migration: runs once on app startup, restores the
 * `mashup_saved_images_backup` field into `mashup_saved_images` if
 * the latter is empty. Sets `MIGRATION_FLAG` to prevent re-runs.
 *
 * Returns a report so the caller can surface a toast like
 * "Restored 4 images from backup" — or silently skip if there's
 * nothing to do.
 */
export async function restoreFromJsonBackupField(): Promise<BackupRecoveryReport> {
  const flag = await get(MIGRATION_FLAG)
  if (flag) {
    return { found: 0, restored: 0, broken: 0, persisted: 0, skipped: true, reason: 'already-migrated' }
  }

  const current = (await get<GeneratedImage[]>(IMAGES_KEY)) || []
  if (current.length > 0) {
    // Gallery already has images — nothing to do
    await set(MIGRATION_FLAG, true)
    return { found: 0, restored: 0, broken: 0, persisted: 0, skipped: true, reason: 'images-already-present' }
  }

  const backup = (await get<GeneratedImage[]>(BACKUP_KEY)) || []
  if (backup.length === 0) {
    await set(MIGRATION_FLAG, true)
    return { found: 0, restored: 0, broken: 0, persisted: 0, skipped: true, reason: 'no-backup-found' }
  }

  // Filter out records that can't be displayed (no URL, no base64)
  const valid = backup.filter((img) => img.url || img.base64)
  const broken = backup.length - valid.length

  // Restore to the live list
  await set(IMAGES_KEY, valid)

  // Try to persist each image to disk. Failures are non-fatal —
  // the user still has the image in the gallery via the URL.
  let persisted = 0
  for (const img of valid) {
    if (!img.url) continue
    try {
      const filename = await persistImageToDisk(img.url, img.id, img.savedAt ?? Date.now())
      if (filename) {
        persisted++
      }
    } catch {
      // URL may have expired — leave the record in place; the
      // gallery will show "image broken" once the CDN URL 404s.
    }
  }

  await set(MIGRATION_FLAG, true)

  return {
    found: backup.length,
    restored: valid.length,
    broken,
    persisted,
    skipped: false,
  }
}

/**
 * Force-restore (for the Settings → Image Backup panel button).
 * Unlike the idempotent migration, this can run multiple times
 * — the user might want to refresh the gallery from backup
 * after a content moderation event wiped a few items.
 */
export async function forceRestoreFromJsonBackupField(): Promise<BackupRecoveryReport> {
  const flag = await get(MIGRATION_FLAG)
  if (flag) {
    // Clear the flag so the migration can run again
    await set(MIGRATION_FLAG, false)
  }
  return restoreFromJsonBackupField()
}
