// V082-COLLECTION-FEATURES — pins the pure tag-grouping helpers used by
// the "Auto-organize by tag" and "Auto-add matching" Gallery actions.
// The helpers live on useCollections module scope (not inside the hook)
// so they can be tested without spinning up React.

import { describe, it, expect } from 'vitest';
import type { GeneratedImage } from '@/types/mashup';
import {
  normalizeTag,
  proposeTagGroups,
  findMatchingImages,
} from '@/hooks/useCollections';

const mkImg = (overrides: Partial<GeneratedImage>): GeneratedImage => ({
  id: 'i',
  prompt: 'p',
  ...overrides,
});

describe('normalizeTag', () => {
  it('lowercases and trims', () => {
    expect(normalizeTag('  Batman ')).toBe('batman');
    expect(normalizeTag('SUPER')).toBe('super');
  });
});

describe('proposeTagGroups', () => {
  it('buckets images by tag and only surfaces groups ≥ minImages', () => {
    const imgs: GeneratedImage[] = [
      mkImg({ id: '1', tags: ['Batman', 'night'] }),
      mkImg({ id: '2', tags: ['batman', 'day'] }),
      mkImg({ id: '3', tags: ['BATMAN'] }),
      mkImg({ id: '4', tags: ['solo'] }),
    ];
    const groups = proposeTagGroups(imgs, 3);
    expect(groups).toHaveLength(1);
    expect(groups[0].tag).toBe('batman');
    expect(groups[0].imageIds.sort()).toEqual(['1', '2', '3']);
  });

  it('treats postHashtags as tags (strips leading #)', () => {
    const imgs: GeneratedImage[] = [
      mkImg({ id: '1', postHashtags: ['#Gotham'] }),
      mkImg({ id: '2', postHashtags: ['gotham', '#night'] }),
      mkImg({ id: '3', tags: ['Gotham'] }),
    ];
    const groups = proposeTagGroups(imgs, 3);
    expect(groups[0].tag).toBe('gotham');
    expect(groups[0].imageIds.sort()).toEqual(['1', '2', '3']);
  });

  it('orders proposals by bucket size descending', () => {
    const imgs: GeneratedImage[] = [
      mkImg({ id: 'a', tags: ['big'] }),
      mkImg({ id: 'b', tags: ['big'] }),
      mkImg({ id: 'c', tags: ['big'] }),
      mkImg({ id: 'd', tags: ['big', 'mid'] }),
      mkImg({ id: 'e', tags: ['mid'] }),
      mkImg({ id: 'f', tags: ['mid'] }),
      mkImg({ id: 'g', tags: ['mid'] }),
      mkImg({ id: 'h', tags: ['mid', 'big'] }),
    ];
    const groups = proposeTagGroups(imgs, 3);
    expect(groups.map((g) => g.tag)).toEqual(['big', 'mid']);
    expect(groups[0].imageIds.length).toBeGreaterThanOrEqual(groups[1].imageIds.length);
  });

  it('returns empty when no bucket clears the threshold', () => {
    const imgs: GeneratedImage[] = [mkImg({ id: '1', tags: ['x'] })];
    expect(proposeTagGroups(imgs, 3)).toEqual([]);
  });

  it('preserves a human-readable display name from the first occurrence', () => {
    const imgs: GeneratedImage[] = [
      mkImg({ id: '1', tags: ['Dark Knight'] }),
      mkImg({ id: '2', tags: ['dark knight'] }),
      mkImg({ id: '3', tags: ['DARK KNIGHT'] }),
    ];
    const groups = proposeTagGroups(imgs, 3);
    expect(groups[0].tag).toBe('dark knight');
    expect(groups[0].displayName).toBe('Dark Knight');
  });
});

describe('findMatchingImages', () => {
  it('returns pool images that share any tag with the collection', () => {
    const inCollection: GeneratedImage[] = [
      mkImg({ id: 'c1', collectionId: 'col-1', tags: ['batman', 'gotham'] }),
    ];
    const pool: GeneratedImage[] = [
      mkImg({ id: 'p1', tags: ['batman'] }),
      mkImg({ id: 'p2', tags: ['unrelated'] }),
      mkImg({ id: 'p3', tags: ['Gotham', 'night'] }),
    ];
    const matches = findMatchingImages(pool, inCollection, 'col-1');
    expect(matches.map((m) => m.id).sort()).toEqual(['p1', 'p3']);
  });

  it('never re-matches an image that is already in the target collection', () => {
    const inCollection: GeneratedImage[] = [
      mkImg({ id: 'c1', collectionId: 'col-1', tags: ['batman'] }),
    ];
    const pool: GeneratedImage[] = [
      mkImg({ id: 'c1', collectionId: 'col-1', tags: ['batman'] }),
      mkImg({ id: 'p1', tags: ['batman'] }),
    ];
    const matches = findMatchingImages(pool, inCollection, 'col-1');
    expect(matches.map((m) => m.id)).toEqual(['p1']);
  });

  it('returns [] when the collection has no tags at all', () => {
    const inCollection: GeneratedImage[] = [mkImg({ id: 'c1', collectionId: 'col-1' })];
    const pool: GeneratedImage[] = [mkImg({ id: 'p1', tags: ['anything'] })];
    expect(findMatchingImages(pool, inCollection, 'col-1')).toEqual([]);
  });
});
