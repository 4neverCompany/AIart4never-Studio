/**
 * 4NE-17 — posting-time / hook self-tuning tests (PURE, deterministic).
 *
 * Pins down: the top (pillar, weekday) slot for a consistently-strong cell,
 * the shrinkage property (a high-sample mediocre slot is trusted over a
 * 1-sample fluke), recommendedHour derived from postedAt, hook ranking, and the
 * empty-input graceful path.
 */
import { describe, it, expect } from 'vitest';
import { recommendPostingTimes, recommendHooks, shrinkScore } from '@/lib/growth';
import type { AttributedInsight } from '@/lib/growth';

/** A Friday 20:00 UTC base timestamp; hour is read via getUTCHours. */
const FRI_20_UTC = Date.UTC(2023, 10, 17, 20, 0, 0); // 2023-11-17 is a Friday
const TUE_09_UTC = Date.UTC(2023, 10, 14, 9, 0, 0); // 2023-11-14 is a Tuesday

function insight(over: Partial<AttributedInsight> & Pick<AttributedInsight, 'postId'>): AttributedInsight {
  return {
    assetId: undefined,
    pillarId: undefined,
    reality: undefined,
    day: undefined,
    hookId: undefined,
    postedAt: FRI_20_UTC,
    likes: 0,
    comments: 0,
    saves: 0,
    shares: 0,
    reach: 0,
    impressions: 0,
    ...over,
  };
}

describe('shrinkScore', () => {
  it('approaches the cell average as n grows large (shrink + penalty both vanish)', () => {
    // n=1000, K=3, cellAvg=100, globalMean=10:
    //   shrunk  = (1000·100 + 3·10)/1003 ≈ 99.73
    //   penalty = 0.5·10/sqrt(1000)       ≈  0.16
    //   score   ≈ 99.57 — within ~0.5 of the true average.
    expect(shrinkScore(100, 1000, 10)).toBeCloseTo(100, 0);
  });
  it('discounts a tiny sample (shrink toward mean + uncertainty penalty)', () => {
    // n=1, K=3, cellAvg=100, globalMean=10:
    //   shrunk  = (1·100 + 3·10)/4 = 32.5
    //   penalty = 0.5·10/sqrt(1)   =  5
    //   score   = 27.5
    expect(shrinkScore(100, 1, 10)).toBeCloseTo(27.5, 6);
  });
  it('returns the prior (global mean) for an empty cell', () => {
    expect(shrinkScore(0, 0, 42)).toBe(42);
  });
});

describe('recommendPostingTimes', () => {
  it('ranks a consistently-strong (pillar, weekday) cell on top with its hour', () => {
    const history: AttributedInsight[] = [
      // story-beat on Friday — strong + many posts
      insight({ postId: 'a', pillarId: 'story-beat', day: 'fri', saves: 40, reach: 1000, postedAt: FRI_20_UTC }),
      insight({ postId: 'b', pillarId: 'story-beat', day: 'fri', saves: 38, reach: 1000, postedAt: FRI_20_UTC }),
      insight({ postId: 'c', pillarId: 'story-beat', day: 'fri', saves: 42, reach: 1000, postedAt: FRI_20_UTC }),
      // lore-poll on Tuesday — weak
      insight({ postId: 'd', pillarId: 'lore-poll', day: 'tue', saves: 4, reach: 1000, postedAt: TUE_09_UTC }),
      insight({ postId: 'e', pillarId: 'lore-poll', day: 'tue', saves: 5, reach: 1000, postedAt: TUE_09_UTC }),
    ];
    const recs = recommendPostingTimes(history);
    expect(recs[0]!.pillarId).toBe('story-beat');
    expect(recs[0]!.day).toBe('fri');
    expect(recs[0]!.recommendedHour).toBe(20); // 20:00 UTC
    expect(recs[0]!.basis).toBe(3);
    expect(recs[0]!.score).toBeGreaterThan(recs[recs.length - 1]!.score);
  });

  it('trusts a high-sample solid slot over a single-post fluke (shrinkage works)', () => {
    const history: AttributedInsight[] = [
      // Solid Friday story-beat: many posts, avg 60.
      ...Array.from({ length: 10 }, (_, i) =>
        insight({ postId: `solid${i}`, pillarId: 'story-beat', day: 'fri', saves: 60, reach: 1000, postedAt: FRI_20_UTC }),
      ),
      // Fluke: ONE Tuesday lore-poll that scored 99 (raw avg would top the list).
      insight({ postId: 'fluke', pillarId: 'lore-poll', day: 'tue', saves: 99, reach: 1000, postedAt: TUE_09_UTC }),
    ];
    const recs = recommendPostingTimes(history);
    // Raw average would rank the fluke (99) above the solid slot (60).
    // Shrinkage must pull the n=1 fluke down so the n=10 slot wins.
    expect(recs[0]!.pillarId).toBe('story-beat');
    expect(recs[0]!.day).toBe('fri');
    const fluke = recs.find((r) => r.pillarId === 'lore-poll')!;
    expect(recs[0]!.score).toBeGreaterThan(fluke.score);
  });

  it('returns [] for empty or unattributable history', () => {
    expect(recommendPostingTimes([])).toEqual([]);
    expect(recommendPostingTimes([insight({ postId: 'x', saves: 5, reach: 1000 })])).toEqual([]); // no pillar/day
  });
});

describe('recommendHooks', () => {
  it('ranks the better-performing hook first, per pillar', () => {
    const history: AttributedInsight[] = [
      insight({ postId: 'a', pillarId: 'story-beat', hookId: 'good', saves: 50, reach: 1000 }),
      insight({ postId: 'b', pillarId: 'story-beat', hookId: 'good', saves: 48, reach: 1000 }),
      insight({ postId: 'c', pillarId: 'story-beat', hookId: 'good', saves: 52, reach: 1000 }),
      insight({ postId: 'd', pillarId: 'story-beat', hookId: 'meh', saves: 8, reach: 1000 }),
      insight({ postId: 'e', pillarId: 'story-beat', hookId: 'meh', saves: 7, reach: 1000 }),
      insight({ postId: 'f', pillarId: 'story-beat', hookId: 'meh', saves: 9, reach: 1000 }),
    ];
    const recs = recommendHooks(history);
    expect(recs[0]!.hookId).toBe('good');
    expect(recs[0]!.score).toBeGreaterThan(recs[1]!.score);
    expect(recs[0]!.basis).toBe(3);
  });

  it('skips insights without a hookId and returns [] when none carry one', () => {
    const history: AttributedInsight[] = [
      insight({ postId: 'a', pillarId: 'story-beat', saves: 50, reach: 1000 }), // no hookId
      insight({ postId: 'b', pillarId: 'story-beat', hookId: 'h', saves: 10, reach: 1000 }),
    ];
    const recs = recommendHooks(history);
    expect(recs.map((r) => r.hookId)).toEqual(['h']);
    expect(recommendHooks([])).toEqual([]);
  });
});
