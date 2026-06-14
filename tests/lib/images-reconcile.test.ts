import { describe, it, expect, vi } from 'vitest';
import { findMissingImageIds } from '@/lib/images/reconcile';
import type { GeneratedImage } from '@/types/mashup';

function img(partial: Partial<GeneratedImage> & { id: string }): GeneratedImage {
  return {
    prompt: 'p',
    url: '',
    ...partial,
  } as GeneratedImage;
}

describe('findMissingImageIds', () => {
  it('reports NOTHING on web (no isDesktop) — can\'t prove remote-only is dead', async () => {
    const images = [img({ id: 'a', url: 'https://cdn/x.jpg' })];
    const missing = await findMissingImageIds(images, { isDesktop: false });
    expect(missing.size).toBe(0);
  });

  it('treats a base64 image as alive even with no local file', async () => {
    const images = [img({ id: 'a', base64: 'AAAA' })];
    const missing = await findMissingImageIds(images, {
      isDesktop: true,
      fileExists: async () => false,
    });
    expect(missing.has('a')).toBe(false);
  });

  it('treats an on-disk image (localPath file exists) as alive', async () => {
    const images = [img({ id: 'a', localPath: 'img_a.jpg' })];
    const missing = await findMissingImageIds(images, {
      isDesktop: true,
      fileExists: async (f) => f === 'img_a.jpg',
    });
    expect(missing.has('a')).toBe(false);
  });

  it('flags a localPath record whose file is gone (no base64) as missing', async () => {
    const images = [img({ id: 'a', localPath: 'gone.jpg' })];
    const missing = await findMissingImageIds(images, {
      isDesktop: true,
      fileExists: async () => false,
    });
    expect(missing.has('a')).toBe(true);
  });

  it('flags a remote-only record (url, no localPath, no base64) as missing', async () => {
    const images = [img({ id: 'a', url: 'https://cdn.leonardo.ai/expired.jpg' })];
    const missing = await findMissingImageIds(images, {
      isDesktop: true,
      fileExists: async () => false,
    });
    expect(missing.has('a')).toBe(true);
  });

  it('NEVER flags an image if the existence probe THROWS (transient-failure safety)', async () => {
    const images = [img({ id: 'a', localPath: 'maybe.jpg' })];
    const missing = await findMissingImageIds(images, {
      isDesktop: true,
      fileExists: async () => {
        throw new Error('fs hiccup');
      },
    });
    expect(missing.has('a')).toBe(false);
  });

  it('handles a large set across the concurrency chunk boundary', async () => {
    // 50 images: even ids on disk, odd ids gone.
    const images = Array.from({ length: 50 }, (_, i) =>
      img({ id: `i${i}`, localPath: `i${i}.jpg` }),
    );
    const onDisk = new Set(images.filter((_, i) => i % 2 === 0).map((x) => x.id));
    const missing = await findMissingImageIds(images, {
      isDesktop: true,
      concurrency: 8,
      fileExists: async (f) => onDisk.has(f.replace('.jpg', '')),
    });
    expect(missing.size).toBe(25);
    expect(missing.has('i1')).toBe(true);
    expect(missing.has('i0')).toBe(false);
  });

  it('does not mutate the input array', async () => {
    const images = [img({ id: 'a', localPath: 'gone.jpg' })];
    const fileExists = vi.fn(async () => false);
    await findMissingImageIds(images, { isDesktop: true, fileExists });
    expect(images).toHaveLength(1);
    expect(images[0].id).toBe('a');
  });
});
