/**
 * Tests for lib/backup/recovery.ts
 *
 * V1.4.3-IMAGE-RECOVERY: when the user updates the app and the
 * NSIS installer wipes %APPDATA%, the gallery list goes empty
 * but the v1.3.2 backup field in the JSON still has entries.
 * The auto-migration in MashupContext calls
 * `restoreFromJsonBackupField()` to bring them back.
 *
 * Covered:
 *   - Migration is idempotent (flag set after first run)
 *   - When gallery already has items, migration is a no-op
 *   - When backup is empty, migration is a no-op
 *   - When backup has entries, they're copied to the live list
 *   - Force-restore clears the flag so the migration re-runs
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the persistence + image-storage modules BEFORE importing
// the recovery module. We need to control what `get`/`set` return.
const mockStore = new Map<string, unknown>()

vi.mock('@/lib/persistence', () => ({
  get: vi.fn(async (key: string) => mockStore.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    mockStore.set(key, value)
  }),
}))

vi.mock('@/lib/images/storage', () => ({
  persistImageToDisk: vi.fn(async () => 'mock_filename.jpg'),
}))

import {
  restoreFromJsonBackupField,
  forceRestoreFromJsonBackupField,
} from '@/lib/backup/recovery'

const IMAGES_KEY = 'mashup_saved_images'
const BACKUP_KEY = 'mashup_saved_images_backup'
const FLAG_KEY = 'mashup_backup_migrated_v1_4_3'

const sampleBackup = [
  { id: 'img-1', url: 'https://cdn.example/1.jpg', prompt: 'p1', status: 'ready', savedAt: 1000 },
  { id: 'img-2', url: 'https://cdn.example/2.jpg', prompt: 'p2', status: 'ready', savedAt: 2000 },
  { id: 'img-3', base64: 'BASE64CHUNK', prompt: 'p3', status: 'ready', savedAt: 3000 },
  // broken: no url, no base64
  { id: 'img-4', prompt: 'p4', status: 'broken', savedAt: 4000 },
]

describe('lib/backup/recovery', () => {
  beforeEach(() => {
    mockStore.clear()
    vi.clearAllMocks()
  })

  it('migrates backup → live when gallery is empty and backup is full', async () => {
    mockStore.set(BACKUP_KEY, sampleBackup)
    const report = await restoreFromJsonBackupField()
    expect(report.skipped).toBe(false)
    expect(report.found).toBe(4)
    expect(report.restored).toBe(3) // the 4th is broken (no url/base64)
    expect(report.broken).toBe(1)
    // The flag is set so it doesn't run again
    expect(mockStore.get(FLAG_KEY)).toBe(true)
    // The live list now has the 3 valid items
    const live = mockStore.get(IMAGES_KEY) as Array<{ id: string }>
    expect(live.length).toBe(3)
    expect(live.map((i) => i.id)).toEqual(['img-1', 'img-2', 'img-3'])
  })

  it('is a no-op when the migration flag is already set', async () => {
    mockStore.set(FLAG_KEY, true)
    mockStore.set(BACKUP_KEY, sampleBackup)
    const report = await restoreFromJsonBackupField()
    expect(report.skipped).toBe(true)
    expect(report.reason).toBe('already-migrated')
    // Live list untouched
    expect(mockStore.get(IMAGES_KEY)).toBeUndefined()
  })

  it('is a no-op when the gallery already has items', async () => {
    mockStore.set(IMAGES_KEY, [{ id: 'existing', url: 'x', prompt: 'p', status: 'ready', savedAt: 0 }])
    mockStore.set(BACKUP_KEY, sampleBackup)
    const report = await restoreFromJsonBackupField()
    expect(report.skipped).toBe(true)
    expect(report.reason).toBe('images-already-present')
    // Flag is still set so a future empty-after-wipe can re-run
    expect(mockStore.get(FLAG_KEY)).toBe(true)
  })

  it('is a no-op when the backup is empty', async () => {
    mockStore.set(BACKUP_KEY, [])
    const report = await restoreFromJsonBackupField()
    expect(report.skipped).toBe(true)
    expect(report.reason).toBe('no-backup-found')
    expect(mockStore.get(FLAG_KEY)).toBe(true)
  })

  it('forceRestoreFromJsonBackupField clears the flag and re-runs', async () => {
    mockStore.set(FLAG_KEY, true)
    mockStore.set(BACKUP_KEY, sampleBackup)
    const report = await forceRestoreFromJsonBackupField()
    expect(report.restored).toBe(3)
  })
})
