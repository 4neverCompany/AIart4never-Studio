/**
 * Tests for lib/images/storage.ts
 *
 * Covers the deterministic, platform-agnostic surface:
 *   - buildImageFilename generates YYYY-MM-DD_<id>.<ext>
 *   - displayUrl falls back through url → base64 → ''
 *
 * Tauri-side effects (mkdir, writeFile, convertFileSrc) are not
 * tested here — they require the Tauri runtime, which is mocked in
 * the integration tests under tests/integration/.
 */

import { describe, it, expect } from 'vitest';
import { buildImageFilename, displayUrl } from '@/lib/images/storage';

describe('buildImageFilename', () => {
  it('formats the YYYY-MM-DD_<id>.jpg pattern', () => {
    const name = buildImageFilename('img-1234-0', Date.UTC(2026, 5, 9, 12, 0, 0));
    expect(name).toBe('2026-06-09_img-1234-0.jpg');
  });

  it('strips path-unsafe characters from the id', () => {
    const name = buildImageFilename('img/with\\weird:chars', Date.UTC(2026, 5, 9, 12, 0, 0));
    expect(name).toBe('2026-06-09_img_with_weird_chars.jpg');
  });
});

describe('displayUrl', () => {
  it('prefers url over base64', () => {
    const url = displayUrl({ url: 'https://example.com/a.jpg', base64: 'AAA' });
    expect(url).toBe('https://example.com/a.jpg');
  });

  it('falls back to data: URL when only base64 is set', () => {
    const url = displayUrl({ base64: 'B64CHUNK' });
    expect(url).toBe('data:image/jpeg;base64,B64CHUNK');
  });

  it('returns empty string for an empty record', () => {
    const url = displayUrl({});
    expect(url).toBe('');
  });
});
