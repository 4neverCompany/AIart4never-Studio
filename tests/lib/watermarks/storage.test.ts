/**
 * V1.7.1-M3.2b-WATERMARK-DISK: tests for the watermark storage
 * helpers + migration. The Tauri runtime paths (persistWatermarkToDisk,
 * displayWatermarkUrlAsync, removeWatermarkFile) are integration
 * tests and live in the same file as the pure helpers because the
 * pure helpers ARE the only testable surface — the Tauri side is
 * mocked via Vitest's `vi.mock` for `@tauri-apps/api/path` /
 * `@tauri-apps/plugin-fs`.
 *
 * See lib/watermarks/storage.ts for the contract and lib/watermarks/
 * migrate.ts for the migration semantics.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseDataUrl,
  hashBytes,
  extensionFromMime,
  buildWatermarkFilename,
} from '@/lib/watermarks/storage';
import {
  shouldMigrateWatermark,
  buildWatermarkUploadPatch,
  buildWatermarkRemovePatch,
  type BuildUploadPatchInput,
} from '@/lib/watermarks/migrate';
import type { WatermarkSettings } from '@/types/mashup';

describe('parseDataUrl', () => {
  it('parses a PNG data-URL into bytes + mime', () => {
    // "Hello" in base64 = SGVsbG8=
    const url = 'data:image/png;base64,SGVsbG8=';
    const result = parseDataUrl(url);
    expect(result).not.toBeNull();
    expect(result!.mime).toBe('image/png');
    expect(result!.bytes).toEqual(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
  });

  it('parses a JPEG data-URL', () => {
    const url = 'data:image/jpeg;base64,/9j/AA==';
    const result = parseDataUrl(url);
    expect(result!.mime).toBe('image/jpeg');
  });

  it('parses an SVG data-URL', () => {
    const url = 'data:image/svg+xml;base64,PHN2Zy8+';
    const result = parseDataUrl(url);
    expect(result!.mime).toBe('image/svg+xml');
  });

  it('returns null for a non-data URL', () => {
    expect(parseDataUrl('https://example.com/logo.png')).toBeNull();
  });

  it('returns null for a non-image data URL', () => {
    expect(parseDataUrl('data:application/json;base64,e30=')).toBeNull();
  });

  it('returns null for a malformed data URL (no base64 marker)', () => {
    expect(parseDataUrl('data:image/png,notbase64')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseDataUrl('')).toBeNull();
  });
});

describe('hashBytes', () => {
  it('produces an 8-char hex string', () => {
    const h = hashBytes(new Uint8Array([1, 2, 3]));
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is deterministic for the same input', () => {
    const a = hashBytes(new Uint8Array([1, 2, 3, 4, 5]));
    const b = hashBytes(new Uint8Array([1, 2, 3, 4, 5]));
    expect(a).toBe(b);
  });

  it('produces different hashes for different inputs', () => {
    const a = hashBytes(new Uint8Array([1, 2, 3]));
    const b = hashBytes(new Uint8Array([1, 2, 4]));
    expect(a).not.toBe(b);
  });

  it('handles an empty byte array without crashing', () => {
    const h = hashBytes(new Uint8Array([]));
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('extensionFromMime', () => {
  it.each([
    ['image/png', '.png'],
    ['image/jpeg', '.jpg'],
    ['image/jpg', '.jpg'],
    ['image/svg+xml', '.svg'],
    ['image/webp', '.webp'],
    ['image/gif', '.gif'],
    ['image/unknown', '.png'], // fallback
    ['not-a-mime', '.png'], // fallback
  ])('maps %s to %s', (mime, expected) => {
    expect(extensionFromMime(mime)).toBe(expected);
  });
});

describe('buildWatermarkFilename', () => {
  it('joins hash and extension with a wm_ prefix', () => {
    expect(buildWatermarkFilename('1f2e3a4b', 'png')).toBe('wm_1f2e3a4b.png');
  });

  it('tolerates an extension that already has the dot', () => {
    expect(buildWatermarkFilename('1f2e3a4b', '.png')).toBe('wm_1f2e3a4b.png');
  });

  it('handles a hash shorter than 8 chars (padded by hashBytes, not here)', () => {
    // buildWatermarkFilename is purely a string-join; padding is the
    // caller's responsibility (hashBytes already pads to 8). Defensive:
    // we should still produce a valid filename.
    expect(buildWatermarkFilename('ab', 'svg')).toBe('wm_ab.svg');
  });
});

describe('shouldMigrateWatermark', () => {
  const baseWm: WatermarkSettings = {
    enabled: true,
    image: 'data:image/png;base64,abc',
    position: 'bottom-right',
    opacity: 0.8,
    scale: 0.15,
  };

  it('returns true on a legacy data-URL watermark in Tauri', () => {
    expect(shouldMigrateWatermark({ watermark: baseWm }, true)).toBe(true);
  });

  it('returns false off-Tauri (no disk to migrate to)', () => {
    expect(shouldMigrateWatermark({ watermark: baseWm }, false)).toBe(false);
  });

  it('returns false when the watermark is already migrated (imageRef set)', () => {
    expect(
      shouldMigrateWatermark(
        {
          watermark: {
            ...baseWm,
            imageRef: { hash: '1f2e3a4b', filename: 'wm_1f2e3a4b.png', mimeType: 'image/png', size: 100 },
          },
        },
        true,
      ),
    ).toBe(false);
  });

  it('returns false when the watermark is empty', () => {
    expect(
      shouldMigrateWatermark(
        { watermark: { ...baseWm, image: null } },
        true,
      ),
    ).toBe(false);
  });

  it('returns false when the watermark is already an asset:// URL', () => {
    expect(
      shouldMigrateWatermark(
        { watermark: { ...baseWm, image: 'asset://localhost/wm_1f2e3a4b.png' } },
        true,
      ),
    ).toBe(false);
  });

  it('returns false for missing settings', () => {
    expect(shouldMigrateWatermark(undefined, true)).toBe(false);
    expect(shouldMigrateWatermark(null, true)).toBe(false);
    expect(shouldMigrateWatermark({}, true)).toBe(false);
  });
});

describe('buildWatermarkUploadPatch', () => {
  const prev: WatermarkSettings = {
    enabled: true,
    image: 'data:image/png;base64,OLD',
    position: 'top-left',
    opacity: 0.5,
    scale: 0.1,
  };

  const upload: BuildUploadPatchInput = {
    dataUrl: 'data:image/png;base64,NEW',
    assetUrl: 'asset://localhost/wm_deadbeef.png',
    hash: 'deadbeef',
    filename: 'wm_deadbeef.png',
    mimeType: 'image/png',
    size: 4096,
  };

  it('preserves every other field (enabled, position, opacity, scale)', () => {
    const next = buildWatermarkUploadPatch(prev, upload);
    expect(next.enabled).toBe(true);
    expect(next.position).toBe('top-left');
    expect(next.opacity).toBe(0.5);
    expect(next.scale).toBe(0.1);
  });

  it('replaces `image` with the asset URL', () => {
    const next = buildWatermarkUploadPatch(prev, upload);
    expect(next.image).toBe('asset://localhost/wm_deadbeef.png');
  });

  it('populates `imageRef` with the upload metadata', () => {
    const next = buildWatermarkUploadPatch(prev, upload);
    expect(next.imageRef).toEqual({
      hash: 'deadbeef',
      filename: 'wm_deadbeef.png',
      mimeType: 'image/png',
      size: 4096,
    });
  });

  it('does NOT mutate the previous settings', () => {
    const snapshot = JSON.parse(JSON.stringify(prev));
    buildWatermarkUploadPatch(prev, upload);
    expect(prev).toEqual(snapshot);
  });
});

describe('buildWatermarkRemovePatch', () => {
  const prev: WatermarkSettings = {
    enabled: true,
    image: 'asset://localhost/wm_1f2e3a4b.png',
    imageRef: {
      hash: '1f2e3a4b',
      filename: 'wm_1f2e3a4b.png',
      mimeType: 'image/png',
      size: 4096,
    },
    position: 'center',
    opacity: 0.7,
    scale: 0.2,
  };

  it('clears the runtime image', () => {
    const next = buildWatermarkRemovePatch(prev);
    expect(next.image).toBeNull();
  });

  it('clears the persistent imageRef', () => {
    const next = buildWatermarkRemovePatch(prev);
    expect(next.imageRef).toBeUndefined();
  });

  it('preserves every other field (enabled, position, opacity, scale)', () => {
    const next = buildWatermarkRemovePatch(prev);
    expect(next.enabled).toBe(true);
    expect(next.position).toBe('center');
    expect(next.opacity).toBe(0.7);
    expect(next.scale).toBe(0.2);
  });

  it('does NOT mutate the previous settings', () => {
    const snapshot = JSON.parse(JSON.stringify(prev));
    buildWatermarkRemovePatch(prev);
    expect(prev).toEqual(snapshot);
  });
});
