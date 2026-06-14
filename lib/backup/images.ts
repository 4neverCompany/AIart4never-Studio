import { get, set } from '@/lib/persistence'
import { slimForBackup } from '@/lib/images/slim'
import { type GeneratedImage } from '@/types/mashup'
import pkg from '@/package.json'

/**
 * Backup metadata stamps the app version that wrote it. Derived from
 * package.json — was hardcoded '1.3.1' until v1.4.5, which made every
 * backup claim it came from v1.3.1 regardless of the actual version.
 */
const APP_VERSION = pkg.version

const BACKUP_KEY = 'mashup_saved_images_backup'
const BACKUP_METADATA_KEY = 'mashup_saved_images_backup_meta'
const SALT_BACKUP_KEY = 'higgsfield_oauth_salt_backup'
const SALT_CONFIG_KEY = 'HIGGSFIELD_OAUTH_SALT'

export interface BackupMetadata {
  timestamp: number
  version: string
  imageCount: number
  source: 'auto' | 'manual'
}

function isTauriWithFS(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }
  return w.__TAURI_INTERNALS__ !== undefined || w.__TAURI__ !== undefined
}

async function getBackupDir(): Promise<string | null> {
  if (!isTauriWithFS()) return null
  try {
    // The user's real Documents folder. The pre-v1.4.5 code resolved
    // `appDataDir()/../Documents/...`, which on Windows lands in
    // `%APPDATA%\Roaming\Documents\...` — a folder that doesn't exist
    // and isn't where a user would ever look for their backups.
    const { documentDir, join } = await import('@tauri-apps/api/path')
    const baseDir = await documentDir()
    return await join(baseDir, 'MashupForge Backups')
  } catch { return null }
}

async function readBackupFile(filename: string): Promise<string | null> {
  if (!isTauriWithFS()) return null
  try {
    const { readTextFile } = await import('@tauri-apps/plugin-fs')
    const { join } = await import('@tauri-apps/api/path')
    const backupDir = await getBackupDir()
    if (!backupDir) return null
    const filePath = await join(backupDir, filename)
    return await (await import('@tauri-apps/plugin-fs')).readTextFile(filePath)
  } catch { return null }
}

async function writeBackupFile(filename: string, content: string): Promise<boolean> {
  if (!isTauriWithFS()) return false
  try {
    const { writeTextFile, mkdir } = await import('@tauri-apps/plugin-fs')
    const { join } = await import('@tauri-apps/api/path')
    const backupDir = await getBackupDir()
    if (!backupDir) return false
    await mkdir(backupDir, { recursive: true })
    const filePath = await join(backupDir, filename)
    await (await import('@tauri-apps/plugin-fs')).writeTextFile(filePath, content)
    return true
  } catch { return false }
}

/**
 * Auto-backup the current image store to local Tauri app data.
 * Fires on every `useImages` mutation (debounced 200ms).
 */
export async function autoBackupImages(images: GeneratedImage[]): Promise<void> {
  if (images.length === 0) return
  // M3.2 (V1.8): back up SLIMMED records — metadata + re-downloadable
  // URLs + localPath references, never raw embedded pixels. The fat
  // variant serialized ~100 MB of data-URLs into the plugin-store
  // (doubling mashupforge.json) AND into two Documents files on every
  // 200ms-debounced mutation. Recovery (lib/backup/recovery.ts)
  // re-downloads per URL; locally-persisted pixels live as real files
  // in the images dir (and approved ones additionally in Documents).
  const slimmed = slimForBackup(images)
  const metadata: BackupMetadata = {
    timestamp: Date.now(),
    version: APP_VERSION,
    imageCount: slimmed.length,
    source: 'auto',
  }
  await set(BACKUP_KEY, slimmed)
  await set(BACKUP_METADATA_KEY, metadata)
  const json = JSON.stringify({ images: slimmed, ...metadata }, null, 2)
  const filename = `mashupforge_images_${new Date().toISOString().split('T')[0]}.json`
  await writeBackupFile(filename, json)
  await writeBackupFile('latest.json', json)
}

/**
 * Backup the Higgsfield OAuth encryption salt so the user can re-derive
 * decryption keys after a reinstall. Reads config.json from the Tauri
 * app data dir, extracts HIGGSFIELD_OAUTH_SALT, and writes it to:
 *   - <BackupDir>/higgsfield_oauth_salt.txt
 *   - Tauri plugin-store key `higgsfield_oauth_salt_backup`
 */
export async function backupHiggsfieldSalt(): Promise<void> {
  try {
    // lib/desktop-env.ts writes config.json to
    // `%APPDATA%\MashupForge\config.json` (i.e. $CONFIG/MashupForge/
    // in Tauri path terms — note: the brand dir, NOT the app
    // identifier dir). The pre-v1.4.5 code read `appDataDir()/../
    // config.json`, a path nothing ever writes to, so the salt
    // backup silently never happened.
    const { configDir, join } = await import('@tauri-apps/api/path')
    const baseDir = await configDir()
    const configPath = await join(baseDir, 'MashupForge', 'config.json')
    const configContent = await (await import('@tauri-apps/plugin-fs')).readTextFile(configPath)
    const config = JSON.parse(configContent)
    const salt = config[SALT_CONFIG_KEY] || config['HIGGSFIELD_OAUTH_SALT']
    if (!salt) return
    await writeBackupFile('higgsfield_oauth_salt.txt', salt)
    await set(SALT_BACKUP_KEY, salt)
  } catch {}
}

/**
 * Trigger a browser download of the full image library as a single
 * JSON file the user can stash anywhere (cloud drive, USB, etc.).
 * Falls back to writing to the Tauri backup dir if available, but
 * the download is the primary path.
 */
export async function exportImagesToFile(images: GeneratedImage[]): Promise<boolean> {
  if (typeof window === 'undefined') return false
  try {
    const json = JSON.stringify(
      { images, exportedAt: new Date().toISOString(), version: APP_VERSION },
      null,
      2,
    )
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `mashupforge_images_${new Date().toISOString().split('T')[0]}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    return true
  } catch {
    return false
  }
}

/**
 * Parse and validate images from a user-picked JSON backup file.
 * Returns only the entries that pass the shape check — it does NOT
 * merge or write anything. The caller merges into the store
 * (HiggsfieldConnection's handleImport: dedupe by `id`, imported
 * entries overwrite existing ones with the same id).
 */
export async function importImagesFromFile(file: File): Promise<GeneratedImage[]> {
  try {
    const text = await file.text()
    const data = JSON.parse(text) as { images?: GeneratedImage[] }
    if (!Array.isArray(data.images)) return []
    // Basic shape check
    const valid = data.images.filter(
      (img): img is GeneratedImage =>
        img != null &&
        typeof img === 'object' &&
        typeof (img as GeneratedImage).id === 'string' &&
        typeof (img as GeneratedImage).url === 'string',
    )
    return valid
  } catch {
    return []
  }
}

/**
 * Restore the last auto-backup from the Tauri backup dir or
 * plugin-store. Called on app start to recover from data loss
 * (e.g. after a corrupt app-data wipe or install on a new machine
 * where the user copied the backup folder over).
 */
export async function restoreFromAutoBackup(): Promise<GeneratedImage[] | null> {
  try {
    // Prefer plugin-store first (fast, in-memory)
    const stored = (await get(BACKUP_KEY)) as GeneratedImage[] | null | undefined
    if (Array.isArray(stored) && stored.length > 0) return stored

    // Fall back to the latest.json file on disk
    const text = await readBackupFile('latest.json')
    if (!text) return null
    const data = JSON.parse(text) as { images?: GeneratedImage[] }
    if (!Array.isArray(data.images) || data.images.length === 0) return null
    return data.images
  } catch {
    return null
  }
}
