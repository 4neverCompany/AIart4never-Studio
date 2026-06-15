/**
 * 4NE-14 — Weekly report builder tests (PURE, deterministic).
 *
 * Pins down: scoreInsight ordering (saves beat likes at equal reach), per-pillar
 * + per-slot rollups, best/worst/bestSlot selection, proposal content, and the
 * empty-week graceful "no data" path.
 */
import { describe, it, expect } from 'vitest';
import { buildWeeklyReport, scoreInsight } from '@/lib/analytics/report';
import type { PostInsight } from '@/lib/analytics/types';

const WEEK_START = 1_700_000_000_000;

/** Build a PostInsight with sane zero defaults, overriding what the test cares about. */
function insight(over: Partial<PostInsight> & Pick<PostInsight, 'postId'>): PostInsight {
  return {
    assetId: undefined,
    pillarId: undefined,
    reality: undefined,
    day: undefined,
    postedAt: WEEK_START,
    likes: 0,
    comments: 0,
    saves: 0,
    shares: 0,
    reach: 0,
    impressions: 0,
    ...over,
  };
}

describe('scoreInsight', () => {
  it('weights saves higher than likes at equal reach', () => {
    const reach = 1000;
    const highSaves = insight({ postId: 'a', saves: 50, reach });
    const highLikes = insight({ postId: 'b', likes: 50, reach });
    expect(scoreInsight(highSaves)).toBeGreaterThan(scoreInsight(highLikes));
  });

  it('shares are weighted like saves and above comments', () => {
    const reach = 1000;
    const shares = insight({ postId: 's', shares: 10, reach });
    const comments = insight({ postId: 'c', comments: 10, reach });
    expect(scoreInsight(shares)).toBeGreaterThan(scoreInsight(comments));
  });

  it('normalizes by reach — a resonant small post can beat a shallow big one', () => {
    const small = insight({ postId: 'small', saves: 100, reach: 1_000 });
    const big = insight({ postId: 'big', saves: 100, reach: 100_000 });
    expect(scoreInsight(small)).toBeGreaterThan(scoreInsight(big));
  });

  it('is finite (never NaN) for a zeroed post and for reach=0', () => {
    expect(scoreInsight(insight({ postId: 'z' }))).toBe(0);
    expect(Number.isFinite(scoreInsight(insight({ postId: 'r0', saves: 5, reach: 0 })))).toBe(true);
  });

  it('is deterministic — same input, same score', () => {
    const p = insight({ postId: 'd', saves: 3, likes: 7, reach: 2000 });
    expect(scoreInsight(p)).toBe(scoreInsight(p));
  });
});

describe('buildWeeklyReport — populated week', () => {
  // 6 posts across pillars/days. story-beat on fri is engineered to be the
  // clear winner (high saves at modest reach); variant-reveal lags.
  const fixture: PostInsight[] = [
    insight({ postId: 'p1', pillarId: 'story-beat', day: 'fri', saves: 80, shares: 20, reach: 2000 }),
    insight({ postId: 'p2', pillarId: 'story-beat', day: 'fri', saves: 60, shares: 10, reach: 2000 }),
    insight({ postId: 'p3', pillarId: 'variant-reveal', day: 'mon', likes: 30, reach: 5000 }),
    insight({ postId: 'p4', pillarId: 'variant-reveal', day: 'sun', likes: 20, reach: 6000 }),
    insight({ postId: 'p5', pillarId: 'same-soul', day: 'wed', saves: 30, comments: 10, reach: 3000 }),
    insight({ postId: 'p6', pillarId: 'lore-poll', day: 'tue', likes: 10, comments: 5, reach: 1500 }),
  ];

  const report = buildWeeklyReport(fixture, { weekStart: WEEK_START });

  it('counts every post and carries the weekStart', () => {
    expect(report.totalPosts).toBe(6);
    expect(report.weekStart).toBe(WEEK_START);
  });

  it('picks the highest-scoring post as best and lowest as worst', () => {
    expect(report.best?.postId).toBe('p1');
    // The shallow high-reach variant-reveal posts are the weakest.
    expect(['p3', 'p4']).toContain(report.worst?.postId);
  });

  it('rolls up per pillar with counts + total reach, sorted by avgScore desc', () => {
    const story = report.perPillar.find((r) => r.pillarId === 'story-beat');
    expect(story).toBeDefined();
    expect(story?.posts).toBe(2);
    expect(story?.totalReach).toBe(4000);
    // story-beat should top the pillar ranking.
    expect(report.perPillar[0]?.pillarId).toBe('story-beat');
    // Sorted descending.
    for (let i = 1; i < report.perPillar.length; i++) {
      expect(report.perPillar[i - 1]!.avgScore).toBeGreaterThanOrEqual(report.perPillar[i]!.avgScore);
    }
  });

  it('rolls up per slot and surfaces fri as the best slot', () => {
    expect(report.bestSlot?.day).toBe('fri');
    expect(report.perSlot.find((s) => s.day === 'fri')?.posts).toBe(2);
  });

  it('generates non-empty proposals that reference the top pillar and best day', () => {
    expect(report.proposals.length).toBeGreaterThan(0);
    const joined = report.proposals.join('\n');
    // Top pillar (Story-Beat) named, and its winning day (fri) named.
    expect(joined).toContain('Story-Beat');
    expect(joined).toContain('fri');
  });

  it('proposes shifting/retrying the underperforming pillar', () => {
    const joined = report.proposals.join('\n').toLowerCase();
    expect(joined).toContain('variant reveal'.toLowerCase());
  });

  it('excludes posts with no day from slot rollups but keeps them in pillar rollups', () => {
    const withDayless = [...fixture, insight({ postId: 'pX', pillarId: 'lore-poll', saves: 5, reach: 1000 })];
    const r = buildWeeklyReport(withDayless, { weekStart: WEEK_START });
    expect(r.totalPosts).toBe(7);
    // No new slot added for the dayless post.
    const totalSlotPosts = r.perSlot.reduce((a, s) => a + s.posts, 0);
    expect(totalSlotPosts).toBe(6);
    // But the lore-poll pillar now has 2 posts.
    expect(r.perPillar.find((p) => p.pillarId === 'lore-poll')?.posts).toBe(2);
  });
});

describe('buildWeeklyReport — empty week', () => {
  const report = buildWeeklyReport([], { weekStart: WEEK_START });

  it('returns a graceful no-data report', () => {
    expect(report.totalPosts).toBe(0);
    expect(report.perPillar).toEqual([]);
    expect(report.perSlot).toEqual([]);
    expect(report.best).toBeUndefined();
    expect(report.worst).toBeUndefined();
    expect(report.bestSlot).toBeUndefined();
  });

  it('carries the weekStart and a single "no data yet" proposal', () => {
    expect(report.weekStart).toBe(WEEK_START);
    expect(report.proposals).toHaveLength(1);
    expect(report.proposals[0]?.toLowerCase()).toContain('no data yet');
  });
});
