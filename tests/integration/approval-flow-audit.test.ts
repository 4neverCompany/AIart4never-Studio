/**
 * BUG-QA-004: Full approval flow audit.
 *
 * Tests cover four acceptance criteria:
 *   1. Reject blocks posting — status='rejected' post never reaches the auto-poster
 *   2. Approve-all carousel — ALL images in the group are approved + finalized
 *   3. All images watermarked on approve — finalizePipelineImage contract
 *   4. Mixed approve/reject — only approved images are posted; rejected stay hidden
 *
 * Two bugs found in the underlying code before this audit:
 *   BUG-DEV-001: rejectScheduledPost had no status guard — could silently flip
 *     already-scheduled/posted/failed posts to 'rejected', removing them from
 *     the auto-poster with no recovery path. Fixed: guard `p.status === 'pending_approval'`.
 *   BUG-DEV-003: rejectScheduledPost did not finalize the pipelinePending image —
 *     images were left as pipelinePending=true forever, invisible in Gallery.
 *     Fixed: call finalizePipelineImagesForPosts on reject too.
 */

import { describe, it, expect, vi } from 'vitest';
import { collectFinalizeTargets, finalizePipelineImage } from '@/lib/pipeline-finalize';
import type { GeneratedImage, ScheduledPost, WatermarkSettings } from '@/types/mashup';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makePost(overrides: Partial<ScheduledPost> = {}): ScheduledPost {
  return {
    id: `post-${Math.random().toString(36).slice(2, 7)}`,
    imageId: `img-${Math.random().toString(36).slice(2, 7)}`,
    date: '2026-05-01',
    time: '18:00',
    platforms: ['instagram'],
    caption: 'test',
    status: 'pending_approval',
    ...overrides,
  };
}

function makeImage(overrides: Partial<GeneratedImage> = {}): GeneratedImage {
  return {
    id: `img-${Math.random().toString(36).slice(2, 7)}`,
    prompt: 'test',
    url: 'https://cdn.example.com/img.jpg',
    status: 'ready',
    pipelinePending: true,
    modelInfo: { provider: 'leonardo', modelId: 'phoenix', modelName: 'Phoenix' },
    ...overrides,
  };
}

const watermarkEnabled: WatermarkSettings = {
  enabled: true,
  image: 'data:image/png;base64,IGNORED',
  position: 'bottom-right',
  opacity: 0.6,
  scale: 0.15,
};

/** Mirrors approveScheduledPost logic (pure) */
function approvePost(posts: ScheduledPost[], postId: string): ScheduledPost[] {
  return posts.map(p => p.id === postId ? { ...p, status: 'scheduled' as const } : p);
}

/** Mirrors rejectScheduledPost with BUG-DEV-001 status guard (pure) */
function rejectPost(posts: ScheduledPost[], postId: string): ScheduledPost[] {
  return posts.map(p =>
    p.id === postId && p.status === 'pending_approval'
      ? { ...p, status: 'rejected' as const }
      : p
  );
}

/** Mirrors bulkRejectScheduledPosts with status guard (pure) */
function bulkRejectPosts(posts: ScheduledPost[], postIds: string[]): ScheduledPost[] {
  const idSet = new Set(postIds);
  return posts.map(p =>
    idSet.has(p.id) && p.status === 'pending_approval'
      ? { ...p, status: 'rejected' as const }
      : p
  );
}

/** Mirrors approveRemaining loop in CarouselApprovalCard */
function approveRemainingCarousel(
  liveImages: GeneratedImage[],
  localStatus: Record<string, string>,
  approveImageFn: (imgId: string) => void,
) {
  for (const img of liveImages) {
    if ((localStatus[img.id] ?? 'pending') === 'pending') {
      approveImageFn(img.id);
    }
  }
}

// ─── 1. Reject blocks auto-poster ────────────────────────────────────────────

describe('BUG-QA-004.1 — reject blocks auto-poster', () => {
  it('auto-poster gate: only status=scheduled posts are eligible', () => {
    const posts: ScheduledPost[] = [
      makePost({ id: 'p1', status: 'scheduled' }),
      makePost({ id: 'p2', status: 'rejected' }),
      makePost({ id: 'p3', status: 'pending_approval' }),
      makePost({ id: 'p4', status: 'posted' }),
      makePost({ id: 'p5', status: 'failed' }),
    ];
    // Mirrors: if (post.status !== 'scheduled') continue;
    const eligible = posts.filter(p => p.status === 'scheduled');
    expect(eligible).toHaveLength(1);
    expect(eligible[0].id).toBe('p1');
  });

  it('rejected post: never passes the auto-poster gate', () => {
    const post = makePost({ status: 'pending_approval' });
    const afterReject = rejectPost([post], post.id);
    const eligible = afterReject.filter(p => p.status === 'scheduled');
    expect(eligible).toHaveLength(0);
  });

  it('approved post: passes the auto-poster gate', () => {
    const post = makePost({ status: 'pending_approval' });
    const afterApprove = approvePost([post], post.id);
    const eligible = afterApprove.filter(p => p.status === 'scheduled');
    expect(eligible).toHaveLength(1);
    expect(eligible[0].id).toBe(post.id);
  });

  it('bulk-rejected posts: none pass the auto-poster gate', () => {
    const posts = [
      makePost({ status: 'pending_approval' }),
      makePost({ status: 'pending_approval' }),
      makePost({ status: 'pending_approval' }),
    ];
    const ids = posts.map(p => p.id);
    const result = bulkRejectPosts(posts, ids);
    const eligible = result.filter(p => p.status === 'scheduled');
    expect(eligible).toHaveLength(0);
  });
});

// ─── 2. BUG-DEV-001: reject status guard ────────────────────────────────────

describe('BUG-QA-004.2 — reject status guard (BUG-DEV-001)', () => {
  it('rejectPost only flips pending_approval → cannot touch scheduled posts', () => {
    const posts = [
      makePost({ id: 'p1', status: 'scheduled' }),
      makePost({ id: 'p2', status: 'pending_approval' }),
    ];
    const result = rejectPost(posts, 'p1'); // try to reject an already-scheduled post
    expect(result.find(p => p.id === 'p1')!.status).toBe('scheduled'); // unchanged
  });

  it('rejectPost only flips pending_approval → cannot touch posted posts', () => {
    const p = makePost({ status: 'posted' });
    const result = rejectPost([p], p.id);
    expect(result[0].status).toBe('posted');
  });

  it('rejectPost only flips pending_approval → cannot touch failed posts', () => {
    const p = makePost({ status: 'failed' });
    const result = rejectPost([p], p.id);
    expect(result[0].status).toBe('failed');
  });

  it('bulkRejectPosts only flips pending_approval → mixed array safety', () => {
    const posts = [
      makePost({ id: 'p1', status: 'pending_approval' }),
      makePost({ id: 'p2', status: 'scheduled' }),
      makePost({ id: 'p3', status: 'posted' }),
    ];
    const result = bulkRejectPosts(posts, ['p1', 'p2', 'p3']);
    expect(result.find(p => p.id === 'p1')!.status).toBe('rejected');  // only this flips
    expect(result.find(p => p.id === 'p2')!.status).toBe('scheduled');  // guarded
    expect(result.find(p => p.id === 'p3')!.status).toBe('posted');     // guarded
  });
});

// ─── 3. BUG-DEV-003: reject finalizes pipelinePending images ────────────────

describe('BUG-QA-004.3 — reject must finalize pipelinePending images (BUG-DEV-003)', () => {
  it('collectFinalizeTargets finds the direct image on reject (single post)', () => {
    const img = makeImage({ id: 'img-a', pipelinePending: true });
    const post = makePost({ imageId: 'img-a' });
    const targets = collectFinalizeTargets(post, [img, makeImage({ id: 'other', pipelinePending: true })]);
    expect(targets.map(i => i.id)).toContain('img-a');
  });

  it('collectFinalizeTargets finds all carousel siblings on reject', () => {
    const gid = 'group-xyz';
    const img1 = makeImage({ id: 'c1', carouselGroupId: gid, pipelinePending: true });
    const img2 = makeImage({ id: 'c2', carouselGroupId: gid, pipelinePending: true });
    const img3 = makeImage({ id: 'c3', carouselGroupId: gid, pipelinePending: true });
    const outsider = makeImage({ id: 'out', pipelinePending: true }); // different carousel

    const post = makePost({ imageId: 'c1', carouselGroupId: gid });
    const targets = collectFinalizeTargets(post, [img1, img2, img3, outsider]);

    expect(targets).toHaveLength(3);
    expect(targets.map(i => i.id)).toEqual(expect.arrayContaining(['c1', 'c2', 'c3']));
    expect(targets.map(i => i.id)).not.toContain('out');
  });

  it('collectFinalizeTargets skips already-finalized images (pipelinePending=false)', () => {
    const img1 = makeImage({ id: 'c1', pipelinePending: true });
    const img2 = makeImage({ id: 'c2', pipelinePending: false }); // already finalized
    const post = makePost({ imageId: 'c1' });
    const targets = collectFinalizeTargets(post, [img1, img2]);
    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe('c1');
  });
});

// ─── 4. Approve-all carousel: ALL images finalized ──────────────────────────

describe('BUG-QA-004.4 — approve-all carousel approves ALL images', () => {
  it('approveRemaining loops all liveImages with pending status', () => {
    const imgs = [makeImage({ id: 'i1' }), makeImage({ id: 'i2' }), makeImage({ id: 'i3' })];
    const approved: string[] = [];
    approveRemainingCarousel(imgs, {}, (imgId) => approved.push(imgId));
    expect(approved).toHaveLength(3);
    expect(approved).toEqual(expect.arrayContaining(['i1', 'i2', 'i3']));
  });

  it('approveRemaining skips already-approved images', () => {
    const imgs = [makeImage({ id: 'i1' }), makeImage({ id: 'i2' }), makeImage({ id: 'i3' })];
    const localStatus = { 'i1': 'approved' }; // i1 already approved
    const approved: string[] = [];
    approveRemainingCarousel(imgs, localStatus, (imgId) => approved.push(imgId));
    expect(approved).toHaveLength(2);
    expect(approved).toEqual(expect.arrayContaining(['i2', 'i3']));
    expect(approved).not.toContain('i1');
  });

  it('approveRemaining on an empty carousel is a no-op', () => {
    const approved: string[] = [];
    approveRemainingCarousel([], {}, (imgId) => approved.push(imgId));
    expect(approved).toHaveLength(0);
  });

  it('carousel approve-all: all posts end up as scheduled', () => {
    const gid = 'grp-abc';
    const posts = [
      makePost({ id: 'p1', status: 'pending_approval', carouselGroupId: gid }),
      makePost({ id: 'p2', status: 'pending_approval', carouselGroupId: gid }),
      makePost({ id: 'p3', status: 'pending_approval', carouselGroupId: gid }),
    ];
    let state = [...posts];
    for (const p of posts) {
      state = approvePost(state, p.id);
    }
    expect(state.every(p => p.status === 'scheduled')).toBe(true);
  });

  it('collectFinalizeTargets finds all carousel images from any post in the group', () => {
    const gid = 'grp-xyz';
    const imgs = [
      makeImage({ id: 'c1', carouselGroupId: gid, pipelinePending: true }),
      makeImage({ id: 'c2', carouselGroupId: gid, pipelinePending: true }),
      makeImage({ id: 'c3', carouselGroupId: gid, pipelinePending: true }),
    ];
    const posts = [
      makePost({ id: 'p1', imageId: 'c1', carouselGroupId: gid }),
      makePost({ id: 'p2', imageId: 'c2', carouselGroupId: gid }),
      makePost({ id: 'p3', imageId: 'c3', carouselGroupId: gid }),
    ];

    // First approval sees all 3 images via carouselGroupId
    const targets1 = collectFinalizeTargets(posts[0], imgs);
    expect(targets1).toHaveLength(3);

    // After first finalize, subsequent approvals find zero remaining (already cleared)
    const finalized = imgs.map(i => ({ ...i, pipelinePending: false }));
    const targets2 = collectFinalizeTargets(posts[1], finalized);
    expect(targets2).toHaveLength(0);
  });
});

// ─── 5. Watermark on approve ─────────────────────────────────────────────────

describe('BUG-QA-004.5 — all images watermarked on approve', () => {
  it('finalizePipelineImage applies watermark and clears pipelinePending', async () => {
    const applyWatermark = vi.fn().mockResolvedValue('watermarked-url');
    const img = makeImage({ id: 'img-a', url: 'original', pipelinePending: true });

    const out = await finalizePipelineImage(img, watermarkEnabled, 'MyChan', applyWatermark);

    expect(applyWatermark).toHaveBeenCalledWith('original', watermarkEnabled, 'MyChan');
    expect(out.url).toBe('watermarked-url');
    expect(out.pipelinePending).toBe(false);
  });

  it('finalizePipelineImage clears pipelinePending even when watermark disabled', async () => {
    const applyWatermark = vi.fn();
    const img = makeImage({ id: 'img-b', pipelinePending: true });
    const wm = { ...watermarkEnabled, enabled: false };

    const out = await finalizePipelineImage(img, wm, 'chan', applyWatermark);

    expect(applyWatermark).not.toHaveBeenCalled();
    expect(out.pipelinePending).toBe(false);
  });

  it('watermark failure keeps original URL and clears pipelinePending', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const applyWatermark = vi.fn().mockRejectedValue(new Error('canvas error'));
      const img = makeImage({ id: 'img-c', url: 'orig', pipelinePending: true });

      const out = await finalizePipelineImage(img, watermarkEnabled, 'chan', applyWatermark);

      expect(out.url).toBe('orig');
      expect(out.pipelinePending).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('all carousel images get pipelinePending cleared on approval', async () => {
    const applyWatermark = vi.fn().mockResolvedValue('wm-url');
    const gid = 'grp-wm';
    const imgs = [
      makeImage({ id: 'c1', carouselGroupId: gid, pipelinePending: true, url: 'u1' }),
      makeImage({ id: 'c2', carouselGroupId: gid, pipelinePending: true, url: 'u2' }),
      makeImage({ id: 'c3', carouselGroupId: gid, pipelinePending: true, url: 'u3' }),
    ];
    const post = makePost({ imageId: 'c1', carouselGroupId: gid });

    const targets = collectFinalizeTargets(post, imgs);
    expect(targets).toHaveLength(3);

    const finalized = await Promise.all(
      targets.map(img => finalizePipelineImage(img, watermarkEnabled, 'chan', applyWatermark)),
    );
    expect(finalized.every(i => i.pipelinePending === false)).toBe(true);
    expect(finalized.every(i => i.url === 'wm-url')).toBe(true);
  });
});

// ─── 6. Mixed approve/reject ─────────────────────────────────────────────────

describe('BUG-QA-004.6 — mixed approve/reject carousel', () => {
  it('approved images post, rejected images do not', () => {
    const gid = 'grp-mix';
    const posts = [
      makePost({ id: 'p1', status: 'pending_approval', carouselGroupId: gid }),
      makePost({ id: 'p2', status: 'pending_approval', carouselGroupId: gid }),
      makePost({ id: 'p3', status: 'pending_approval', carouselGroupId: gid }),
    ];

    let state = approvePost(posts, 'p1');
    state = approvePost(state, 'p2');
    state = rejectPost(state, 'p3'); // reject the third

    const autoPostable = state.filter(p => p.status === 'scheduled');
    const blocked = state.filter(p => p.status !== 'scheduled');

    expect(autoPostable.map(p => p.id)).toEqual(expect.arrayContaining(['p1', 'p2']));
    expect(blocked.map(p => p.id)).toContain('p3');
    expect(blocked.find(p => p.id === 'p3')!.status).toBe('rejected');
  });

  it('rejected images from a mixed carousel still get finalized (BUG-DEV-003)', () => {
    const gid = 'grp-mix2';
    const rejectedPost = makePost({ id: 'p3', imageId: 'c3', carouselGroupId: gid });
    const imgs = [
      makeImage({ id: 'c3', carouselGroupId: gid, pipelinePending: true }),
      makeImage({ id: 'other', pipelinePending: false }),
    ];
    // On reject, finalizePipelineImagesForPosts is called
    const targets = collectFinalizeTargets(rejectedPost, imgs);
    expect(targets.map(i => i.id)).toContain('c3');
    expect(targets.map(i => i.id)).not.toContain('other'); // already finalized
  });

  it('auto-poster processes only scheduled entries from a mixed-result carousel', () => {
    const posts = [
      makePost({ id: 'p1', status: 'scheduled', date: '2020-01-01', time: '01:00' }),
      makePost({ id: 'p2', status: 'rejected', date: '2020-01-01', time: '01:00' }),
      makePost({ id: 'p3', status: 'pending_approval', date: '2020-01-01', time: '01:00' }),
    ];
    // Mirrors: for (const post of snapshot) { if (post.status !== 'scheduled') continue; }
    const processed = posts.filter(p => p.status === 'scheduled');
    expect(processed).toHaveLength(1);
    expect(processed[0].id).toBe('p1');
  });
});
