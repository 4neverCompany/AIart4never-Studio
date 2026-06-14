/**
 * V1.7.1-M3.2b-WATERMARK-DISK: integration test for the watermark
 * migration. We mock `@tauri-apps/api/path` and `@tauri-apps/plugin-fs`
 * so `migrateWatermarkToDisk` can run in Node without a real Tauri
 * runtime.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Tauri path + fs plugins BEFORE importing the migration.
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockReadDir = vi.fn().mockResolvedValue([]);
const mockRemove = vi.fn().mockResolvedValue(undefined);
const mockConvertFileSrc = vi.fn((abs: string) => `asset://localhost${abs.replace(/\\/g, '/').replace(/^.*\/images/, '/images')}`);
const mockAppDataDir = vi.fn().mockResolvedValue('C:\\Users\\Test\\AppData\\Roaming\\com.4nevercompany.mashupforge');
const mockJoin = vi.fn(async (...parts: string[]) => parts.join('\\'));

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: mockAppDataDir,
  join: mockJoin,
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  readDir: mockReadDir,
  remove: mockRemove,
  stat: vi.fn().mockResolvedValue({ isFile: true }),
}));
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: mockConvertFileSrc,
}));

// Set up window.__TAURI_INTERNALS__ so getWatermarkDir() sees a Tauri runtime.
beforeEach(() => {
  vi.clearAllMocks();
  // happy-dom provides `window` on the global. The storage module
  // checks `window.__TAURI_INTERNALS__`, not `globalThis.__TAURI_INTERNALS__`.
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
});

import { migrateWatermarkToDisk } from '@/lib/watermarks/migrate';
import type { UserSettings } from '@/types/mashup';

describe('migrateWatermarkToDisk', () => {
  it('returns a patch with asset URL + imageRef on success', async () => {
    // 1x1 transparent PNG (the smallest valid PNG).
    const onePxPng =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const settings: Pick<UserSettings, 'watermark'> = {
      watermark: {
        enabled: true,
        image: onePxPng,
        position: 'bottom-right',
        opacity: 0.8,
        scale: 0.15,
      },
    };

    const patch = await migrateWatermarkToDisk(settings);
    expect(patch).not.toBeNull();
    expect(patch!.watermark).toBeDefined();
    expect(patch!.watermark!.image).toMatch(/^asset:\/\/localhost\//);
    expect(patch!.watermark!.imageRef).toBeDefined();
    expect(patch!.watermark!.imageRef!.filename).toMatch(/^wm_[0-9a-f]{8}\.png$/);
    expect(patch!.watermark!.imageRef!.size).toBeGreaterThan(0);
    // Preserves the other fields
    expect(patch!.watermark!.enabled).toBe(true);
    expect(patch!.watermark!.position).toBe('bottom-right');
    expect(patch!.watermark!.opacity).toBe(0.8);
    expect(patch!.watermark!.scale).toBe(0.15);
  });

  it('is a no-op when imageRef is already set', async () => {
    const settings: Pick<UserSettings, 'watermark'> = {
      watermark: {
        enabled: true,
        image: 'asset://localhost/wm_1f2e3a4b.png',
        imageRef: {
          hash: '1f2e3a4b',
          filename: 'wm_1f2e3a4b.png',
          mimeType: 'image/png',
          size: 100,
        },
        position: 'bottom-right',
        opacity: 0.8,
        scale: 0.15,
      },
    };
    const patch = await migrateWatermarkToDisk(settings);
    expect(patch).toBeNull();
  });

  it('is a no-op when the watermark is empty', async () => {
    const settings: Pick<UserSettings, 'watermark'> = {
      watermark: {
        enabled: true,
        image: null,
        position: 'bottom-right',
        opacity: 0.8,
        scale: 0.15,
      },
    };
    const patch = await migrateWatermarkToDisk(settings);
    expect(patch).toBeNull();
  });

  it('is a no-op when the watermark is already an asset URL (no data: prefix)', async () => {
    const settings: Pick<UserSettings, 'watermark'> = {
      watermark: {
        enabled: true,
        image: 'asset://localhost/wm_already.png',
        position: 'bottom-right',
        opacity: 0.8,
        scale: 0.15,
      },
    };
    const patch = await migrateWatermarkToDisk(settings);
    expect(patch).toBeNull();
  });

  it('returns null when persistWatermarkToDisk fails (write error)', async () => {
    mockWriteFile.mockRejectedValueOnce(new Error('Permission denied'));
    const onePxPng =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const settings: Pick<UserSettings, 'watermark'> = {
      watermark: {
        enabled: true,
        image: onePxPng,
        position: 'bottom-right',
        opacity: 0.8,
        scale: 0.15,
      },
    };
    const patch = await migrateWatermarkToDisk(settings);
    expect(patch).toBeNull();
  });
});
