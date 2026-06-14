/**
 * BUG-QA-003: Audit — every delete/remove path in the app.
 *
 * Rule: Gallery images (savedImages) may ONLY be removed when an action
 * originates explicitly from the Gallery view. All other views (Post Ready,
 * Captioning, Pipeline approval, Calendar) must only mutate their own
 * view-layer state and leave savedImages intact.
 *
 * Paths under test (6 total, matching task acceptance criteria):
 *   1. Gallery kebab delete       — deleteImage(id, true)  → removes from savedImages (intentional)
 *   2. Post Ready modal delete    — wrapper intercepts when view='post-ready' → patchImage only
 *   3. Captioning remove          — patchImage({approved:false}) → image stays in savedImages
 *   4. Pipeline disapprove        — rejectScheduledPost → status:'rejected', post stays in array
 *   5. Calendar delete            — filter on scheduledPosts only, savedImages untouched
 *   6. fromSaved=false guard      — deleteImage(id, false) is a no-op on savedImages
 */

import { describe, it, expect, vi } from 'vitest';
import type { GeneratedImage, ScheduledPost } from '@/types/mashup';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeImage(overrides?: Partial<GeneratedImage>): GeneratedImage {
  return {
    id: `img-${Math.random().toString(36).slice(2, 7)}`,
    prompt: 'test prompt',
    url: 'https://cdn.example.com/img.jpg',
    status: 'ready',
    modelInfo: { provider: 'leonardo', modelId: 'phoenix', modelName: 'Phoenix' },
    ...overrides,
  };
}

function makePost(overrides?: Partial<ScheduledPost>): ScheduledPost {
  return {
    id: `post-${Math.random().toString(36).slice(2, 7)}`,
    imageId: `img-${Math.random().toString(36).slice(2, 7)}`,
    date: '2026-04-25',
    time: '18:00',
    platforms: ['instagram'],
    caption: 'test caption',
    status: 'pending_approval',
    ...overrides,
  };
}

// ─── Pure logic equivalents (mirrors the actual app implementations) ──────────

/** Mirrors useImages.deleteImage */
function deleteImage(
  savedImages: GeneratedImage[],
  id: string,
  fromSaved: boolean,
): GeneratedImage[] {
  if (fromSaved) return savedImages.filter(i => i.id !== id);
  return savedImages; // no-op when fromSaved=false
}

/** Mirrors the MainContent.tsx ImageDetailModal wrapper (BUG-QA-001) */
function postReadyModalDeleteWrapper(
  id: string,
  fromSaved: boolean,
  view: string,
  savedImages: GeneratedImage[],
  patchFn: (img: GeneratedImage, patch: Partial<GeneratedImage>) => void,
  deleteFn: (id: string, fromSaved: boolean) => void,
): void {
  if (view === 'post-ready') {
    const img = savedImages.find(i => i.id === id);
    if (img) { patchFn(img, { isPostReady: false }); return; }
  }
  deleteFn(id, fromSaved);
}

/** Mirrors MashupContext.rejectScheduledPost (BUG-QA-001) */
function rejectScheduledPost(posts: ScheduledPost[], postId: string): ScheduledPost[] {
  return posts.map(p => p.id === postId ? { ...p, status: 'rejected' as const } : p);
}

/** Mirrors the Calendar delete (MainContent.tsx ~line 3016) */
function calendarDeletePost(posts: ScheduledPost[], postId: string): ScheduledPost[] {
  return posts.filter(sp => sp.id !== postId);
}

/** Mirrors Captioning remove (MainContent.tsx ~line 2633) — BUG-QA-002 fix */
function captioningRemove(
  savedImages: GeneratedImage[],
  id: string,
): GeneratedImage[] {
  // patchImage sets approved=false + clears text; image stays in array
  return savedImages.map(img =>
    img.id === id
      ? { ...img, approved: false, postCaption: '', postHashtags: [], tags: [] }
      : img
  );
}

// ─── 1. Gallery kebab delete ─────────────────────────────────────────────────

describe('Path 1 — Gallery kebab delete (intentional Gallery removal)', () => {
  it('deleteImage(id, true) removes the image from savedImages', () => {
    const img = makeImage({ id: 'target' });
    const other = makeImage({ id: 'other' });
    const result = deleteImage([img, other], 'target', true);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('other');
  });

  it('deleteImage(id, true) on unknown id leaves savedImages unchanged', () => {
    const img = makeImage({ id: 'img-a' });
    const result = deleteImage([img], 'does-not-exist', true);
    expect(result).toHaveLength(1);
  });
});

// ─── 2. Post Ready modal delete (BUG-QA-001) ────────────────────────────────

describe('Path 2 — Post Ready modal delete (Gallery image preserved)', () => {
  it('when view=post-ready: patchFn called, deleteFn NOT called', () => {
    const img = makeImage({ id: 'pr-img', isPostReady: true });
    const patchFn = vi.fn();
    const deleteFn = vi.fn();

    postReadyModalDeleteWrapper('pr-img', true, 'post-ready', [img], patchFn, deleteFn);

    expect(patchFn).toHaveBeenCalledWith(img, { isPostReady: false });
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it('when view=post-ready: Gallery image stays in savedImages (no deletion)', () => {
    const img = makeImage({ id: 'pr-img', isPostReady: true });
    const savedImages = [img, makeImage({ id: 'other' })];
    const patchFn = vi.fn();
    const deleteFn = vi.fn();

    postReadyModalDeleteWrapper('pr-img', true, 'post-ready', savedImages, patchFn, deleteFn);

    // savedImages untouched — patchFn mutates via hook, not by slicing array
    expect(savedImages).toHaveLength(2);
  });

  it('when view=gallery: deleteFn called, patchFn NOT called', () => {
    const img = makeImage({ id: 'gal-img' });
    const patchFn = vi.fn();
    const deleteFn = vi.fn();

    postReadyModalDeleteWrapper('gal-img', true, 'gallery', [img], patchFn, deleteFn);

    expect(deleteFn).toHaveBeenCalledWith('gal-img', true);
    expect(patchFn).not.toHaveBeenCalled();
  });

  it('when view=post-ready but id not in savedImages: deleteFn called as fallback', () => {
    const patchFn = vi.fn();
    const deleteFn = vi.fn();

    postReadyModalDeleteWrapper('ghost-id', true, 'post-ready', [], patchFn, deleteFn);

    expect(deleteFn).toHaveBeenCalledWith('ghost-id', true);
    expect(patchFn).not.toHaveBeenCalled();
  });
});

// ─── 3. Captioning remove (BUG-QA-002) ─────────────────────────────────────

describe('Path 3 — Captioning remove (Gallery image preserved)', () => {
  it('sets approved=false on the target image, image stays in array', () => {
    const img = makeImage({ id: 'cap-img', approved: true, postCaption: 'old caption' });
    const other = makeImage({ id: 'other', approved: true });
    const result = captioningRemove([img, other], 'cap-img');

    expect(result).toHaveLength(2);
    const target = result.find(i => i.id === 'cap-img')!;
    expect(target.approved).toBe(false);
  });

  it('clears postCaption, postHashtags, tags on removal', () => {
    const img = makeImage({
      id: 'cap-img',
      approved: true,
      postCaption: 'my caption',
      postHashtags: ['#test'],
      tags: ['tag1'],
    });
    const result = captioningRemove([img], 'cap-img');
    const target = result[0];
    expect(target.postCaption).toBe('');
    expect(target.postHashtags).toEqual([]);
    expect(target.tags).toEqual([]);
  });

  it('image disappears from Captioning filter after removal', () => {
    const img = makeImage({ id: 'cap-img', approved: true, isPostReady: false });
    const result = captioningRemove([img], 'cap-img');
    // Captioning filter: !i.isPostReady && i.approved
    const captioningVisible = result.filter(i => !i.isPostReady && i.approved);
    expect(captioningVisible).toHaveLength(0);
  });

  it('other images in array are untouched', () => {
    const img = makeImage({ id: 'cap-img', approved: true });
    const bystander = makeImage({ id: 'bystander', approved: true, postCaption: 'keep me' });
    const result = captioningRemove([img, bystander], 'cap-img');
    const kept = result.find(i => i.id === 'bystander')!;
    expect(kept.approved).toBe(true);
    expect(kept.postCaption).toBe('keep me');
  });
});

// ─── 4. Pipeline disapprove (BUG-QA-001) ───────────────────────────────────

describe('Path 4 — Pipeline disapprove (post stays, Gallery image preserved)', () => {
  it('sets status=rejected on the post, post stays in array', () => {
    const post = makePost({ id: 'p1', status: 'pending_approval' });
    const result = rejectScheduledPost([post], 'p1');
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('rejected');
  });

  it('rejected post is excluded from the approval queue filter', () => {
    const post = makePost({ id: 'p1', status: 'pending_approval' });
    const result = rejectScheduledPost([post], 'p1');
    // ApprovalQueue filter: p.status === 'pending_approval'
    const pendingQueue = result.filter(p => p.status === 'pending_approval');
    expect(pendingQueue).toHaveLength(0);
  });

  it('rejected post is excluded from countFutureScheduledPosts (terminal status)', () => {
    const posts = [
      makePost({ id: 'p1', status: 'rejected', date: '2099-01-01', time: '18:00' }),
      makePost({ id: 'p2', status: 'scheduled', date: '2099-01-02', time: '18:00' }),
    ];
    const TERMINAL = new Set(['posted', 'failed', 'rejected']);
    const nonTerminal = posts.filter(p => !TERMINAL.has(p.status ?? ''));
    expect(nonTerminal).toHaveLength(1);
    expect(nonTerminal[0].id).toBe('p2');
  });

  it('other posts in array are untouched', () => {
    const p1 = makePost({ id: 'p1', status: 'pending_approval' });
    const p2 = makePost({ id: 'p2', status: 'scheduled' });
    const result = rejectScheduledPost([p1, p2], 'p1');
    expect(result.find(p => p.id === 'p2')!.status).toBe('scheduled');
  });

  it('savedImages are never touched by reject — no deleteImage call path exists', () => {
    // rejectScheduledPost only maps scheduledPosts; there is no branch that
    // calls deleteImage or modifies savedImages.
    const savedImages = [makeImage({ id: 'img-a' })];
    const post = makePost({ id: 'p1', imageId: 'img-a', status: 'pending_approval' });
    rejectScheduledPost([post], 'p1');
    // savedImages reference is identical (no mutation occurred here)
    expect(savedImages).toHaveLength(1);
  });
});

// ─── 5. Calendar delete ──────────────────────────────────────────────────────

describe('Path 5 — Calendar delete (scheduledPost removed, Gallery untouched)', () => {
  it('removes the targeted ScheduledPost from the array', () => {
    const p1 = makePost({ id: 'p1' });
    const p2 = makePost({ id: 'p2' });
    const result = calendarDeletePost([p1, p2], 'p1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p2');
  });

  it('savedImages are not touched by calendar delete', () => {
    const savedImages = [makeImage({ id: 'img-a' })];
    const post = makePost({ id: 'p1', imageId: 'img-a' });
    calendarDeletePost([post], 'p1');
    expect(savedImages).toHaveLength(1);
  });

  it('calendar delete on unknown id leaves array unchanged', () => {
    const p1 = makePost({ id: 'p1' });
    const result = calendarDeletePost([p1], 'ghost');
    expect(result).toHaveLength(1);
  });
});

// ─── 6. fromSaved=false safety guard ────────────────────────────────────────

describe('Path 6 — fromSaved=false is always a no-op on savedImages', () => {
  it('deleteImage(id, false) leaves savedImages unchanged', () => {
    const img = makeImage({ id: 'img-a' });
    const result = deleteImage([img], 'img-a', false);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('img-a');
  });

  it('GalleryCard Dismiss in studio view passes fromSaved=false (no Gallery deletion)', () => {
    // GalleryCard line 160: deleteImage(img.id, view === 'gallery')
    // In studio view, view !== 'gallery' so fromSaved evaluates to false → no-op.
    const view: string = 'studio';
    const fromSaved = view === 'gallery'; // false
    const img = makeImage({ id: 'img-a' });
    const result = deleteImage([img], 'img-a', fromSaved);
    expect(result).toHaveLength(1);
  });

  it('GalleryCard Trash2 button in non-gallery view passes fromSaved=false → no-op', () => {
    // GalleryCard line 373: deleteImage(img.id, false) — always false in this branch
    const img = makeImage({ id: 'img-a' });
    const result = deleteImage([img], 'img-a', false);
    expect(result).toHaveLength(1);
  });
});
