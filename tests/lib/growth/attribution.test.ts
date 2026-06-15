/**
 * 4NE-15 — attribution → plan-feedback tests (PURE, deterministic).
 *
 * Pins down: the three-way breakdown (byPillar / byHook / byReality) sorted by
 * avgScore, shares summing to ~1 within a dimension, hook attribution skipping
 * insights with no hookId, the over/under-perform → increase/decrease proposals,
 * thin-sample → hold/low confidence, and the empty-input graceful path.
 */
import { describe, it, expect } from 'vitest';
import { attributeEngagement, proposeTemplateAdjustments } from '@/lib/growth';
import type { AttributedInsight } from '@/lib/growth';

/** Build an AttributedInsight with zero defaults, overriding what each case cares about. */
function insight(over: Partial<AttributedInsight> & Pick<AttributedInsight, 'postId'>): AttributedInsight {
  return {
    assetId: undefined,
    pillarId: undefined,
    reality: undefined,
    day: undefined,
    hookId: undefined,
    postedAt: 1_700_000_000_000,
    likes: 0,
    comments: 0,
    saves: 0,
    shares: 0,
    reach: 0,
    impressions: 0,
    ...over,
  };
}

/**
 * ~8 insights across 3 pillars / 2 realities / 2 hooks.
 *
 * Scores use scoreInsight = (4·saves + 4·shares + 2·comments + likes) / reach · 1000.
 * All at reach=1000 so the score is just the weighted-action count:
 *   - story-beat posts: saves 30 → score 120 (the over-performer)
 *   - variant-reveal:   saves 10 → score  40 (mid)
 *   - lore-poll:        saves  2 → score   8 (the under-performer)
 */
const FIXTURE: AttributedInsight[] = [
  // story-beat (prime) — strong, hook A — 3 posts
  insight({ postId: 'sb1', pillarId: 'story-beat', reality: 'prime', hookId: 'hook-a', saves: 30, reach: 1000 }),
  insight({ postId: 'sb2', pillarId: 'story-beat', reality: 'prime', hookId: 'hook-a', saves: 30, reach: 1000 }),
  insight({ postId: 'sb3', pillarId: 'story-beat', reality: 'prime', hookId: 'hook-b', saves: 28, reach: 1000 }),
  // variant-reveal (w40k) — mid, hook B — 3 posts
  insight({ postId: 'vr1', pillarId: 'variant-reveal', reality: 'w40k', hookId: 'hook-b', saves: 10, reach: 1000 }),
  insight({ postId: 'vr2', pillarId: 'variant-reveal', reality: 'w40k', hookId: 'hook-b', saves: 10, reach: 1000 }),
  insight({ postId: 'vr3', pillarId: 'variant-reveal', reality: 'w40k', saves: 12, reach: 1000 }), // no hookId
  // lore-poll (prime) — weak — 2 posts, no hooks
  insight({ postId: 'lp1', pillarId: 'lore-poll', reality: 'prime', saves: 2, reach: 1000 }),
  insight({ postId: 'lp2', pillarId: 'lore-poll', reality: 'prime', saves: 2, reach: 1000 }),
];

describe('attributeEngagement', () => {
  it('breaks down byPillar sorted by avgScore desc, with shares summing to ~1', () => {
    const r = attributeEngagement(FIXTURE);
    expect(r.sampleSize).toBe(8);
    expect(r.byPillar.map((s) => s.key)).toEqual(['story-beat', 'variant-reveal', 'lore-poll']);
    // story-beat avg = (120+120+112)/3 ≈ 117.3 — top.
    expect(r.byPillar[0]!.avgScore).toBeGreaterThan(r.byPillar[1]!.avgScore);
    expect(r.byPillar[1]!.avgScore).toBeGreaterThan(r.byPillar[2]!.avgScore);
    const shareSum = r.byPillar.reduce((a, s) => a + s.share, 0);
    expect(shareSum).toBeCloseTo(1, 10);
    // 3/8 of posts are story-beat.
    expect(r.byPillar.find((s) => s.key === 'story-beat')!.share).toBeCloseTo(3 / 8, 10);
  });

  it('byHook only covers insights that carry a hookId, sorted by avgScore', () => {
    const r = attributeEngagement(FIXTURE);
    // 5 of the 8 posts name a hook (3 story-beat, 2 variant-reveal); lore-poll + vr3 have none.
    const hookPosts = r.byHook.reduce((a, s) => a + s.posts, 0);
    expect(hookPosts).toBe(5);
    expect(r.byHook.map((s) => s.key)).toEqual(['hook-a', 'hook-b']);
    expect(r.byHook[0]!.key).toBe('hook-a'); // hook-a (story-beat, score 120) beats hook-b
    const shareSum = r.byHook.reduce((a, s) => a + s.share, 0);
    expect(shareSum).toBeCloseTo(1, 10);
  });

  it('breaks down byReality with reach summed and shares ~1', () => {
    const r = attributeEngagement(FIXTURE);
    expect(r.byReality.map((s) => s.key).sort()).toEqual(['prime', 'w40k']);
    const prime = r.byReality.find((s) => s.key === 'prime')!;
    expect(prime.posts).toBe(5); // 3 story-beat + 2 lore-poll
    expect(prime.totalReach).toBe(5000);
    expect(r.byReality.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 10);
  });

  it('returns an all-empty report for empty input', () => {
    const r = attributeEngagement([]);
    expect(r).toEqual({ byPillar: [], byHook: [], byReality: [], sampleSize: 0 });
  });
});

describe('proposeTemplateAdjustments', () => {
  it('flags an over-performing pillar increase and an under-performer decrease', () => {
    const report = attributeEngagement(FIXTURE);
    const adj = proposeTemplateAdjustments(report, { minSample: 2 });

    const storyBeat = adj.find((a) => a.dimension === 'pillar' && a.key === 'story-beat');
    expect(storyBeat?.kind).toBe('increase');
    expect(storyBeat?.confidence).toBe('high');

    const lorePoll = adj.find((a) => a.dimension === 'pillar' && a.key === 'lore-poll');
    expect(lorePoll?.kind).toBe('decrease');
    expect(lorePoll?.confidence).toBe('high');
  });

  it('holds thin-sample keys at low confidence instead of tuning them', () => {
    // Two pillars: one well-sampled, one with a single post — the thin one must hold.
    const thin: AttributedInsight[] = [
      insight({ postId: 'a', pillarId: 'story-beat', saves: 20, reach: 1000 }),
      insight({ postId: 'b', pillarId: 'story-beat', saves: 20, reach: 1000 }),
      insight({ postId: 'c', pillarId: 'story-beat', saves: 20, reach: 1000 }),
      insight({ postId: 'd', pillarId: 'story-beat', saves: 20, reach: 1000 }),
      insight({ postId: 'e', pillarId: 'story-beat', saves: 20, reach: 1000 }),
      insight({ postId: 'f', pillarId: 'lore-poll', saves: 99, reach: 1000 }), // fluke single post
    ];
    const report = attributeEngagement(thin);
    const adj = proposeTemplateAdjustments(report); // default minSample = 5

    const lorePoll = adj.find((a) => a.dimension === 'pillar' && a.key === 'lore-poll');
    expect(lorePoll?.kind).toBe('hold');
    expect(lorePoll?.confidence).toBe('low');
    // The thin fluke must NOT have produced an increase despite its high score.
    expect(adj.some((a) => a.key === 'lore-poll' && a.kind === 'increase')).toBe(false);
  });

  it('returns no adjustments for an empty report', () => {
    expect(proposeTemplateAdjustments(attributeEngagement([]))).toEqual([]);
  });
});
