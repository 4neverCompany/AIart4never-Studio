import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  findBestSlot,
  findBestSlots,
  loadEngagementData,
  saveEngagementData,
  type CachedEngagement,
  type ExistingPost,
} from '@/lib/smartScheduler';

function makeEngagement(): CachedEngagement {
  return {
    hours: [
      { hour: 12, weight: 0.5 },
      { hour: 18, weight: 0.85 },
      { hour: 20, weight: 0.95 },
    ],
    days: [
      { day: 0, multiplier: 0.9 },
      { day: 1, multiplier: 0.7 },
      { day: 2, multiplier: 0.75 },
      { day: 3, multiplier: 0.8 },
      { day: 4, multiplier: 0.85 },
      { day: 5, multiplier: 0.95 },
      { day: 6, multiplier: 1.0 },
    ],
    fetchedAt: Date.now(),
    source: 'default',
  };
}

function setupLocalStorageStub() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  });
  return store;
}

describe('findBestSlots', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin to a fixed Wednesday so weekend bonuses and day rotations
    // are deterministic across CI/local runs.
    // INCLUDE-TODAY (2026-05-22): pinned to 03:00 UTC = 05:00 CEST so
    // all engagement-fixture hours (12, 18, 20) are still future when
    // "today" is considered as a candidate day. Earlier pin of 10:00
    // UTC = 12:00 local would have excluded the 12:00 hour from today.
    vi.setSystemTime(new Date('2026-04-15T03:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns the requested count of slots', () => {
    const slots = findBestSlots([], 3, makeEngagement());
    expect(slots).toHaveLength(3);
  });

  it('skips slots that are already taken', () => {
    const eng = makeEngagement();
    const all = findBestSlots([], 1, eng);
    const taken: ExistingPost = { date: all[0].date, time: all[0].time };
    const next = findBestSlots([taken], 1, eng);
    expect(`${next[0].date}T${next[0].time}`).not.toBe(`${all[0].date}T${all[0].time}`);
  });

  it('sorts slots by score descending', () => {
    const slots = findBestSlots([], 5, makeEngagement());
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i - 1].score).toBeGreaterThanOrEqual(slots[i].score);
    }
  });

  it('INCLUDE-TODAY (2026-05-22): includes today as a candidate when there are future hours left', () => {
    // findBestSlots emits LOCAL date strings — derive `todayStr` the
    // same way to avoid a UTC/local mismatch. beforeEach pins to
    // 03:00 UTC = 05:00 CEST, so all engagement-fixture hours (12, 18,
    // 20) are future and should be considered for today.
    const today = new Date('2026-04-15T03:00:00Z');
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const slots = findBestSlots([], 3, makeEngagement(), { fillMode: 'depth', postsPerDay: 6 });
    // With depth-fill + cap=6, the first three picks all land on today
    // (highest-weight hours: 20, 18, 12 → all in the future at 05:00 local).
    expect(slots.every((s) => s.date === todayStr)).toBe(true);
  });

  it('INCLUDE-TODAY: skips today\'s already-passed hours', () => {
    // Override the timer to mid-afternoon so the 12:00 fixture hour is
    // in the past. 14:00 UTC = 16:00 CEST. Only 18 and 20 should be
    // valid for today; 12:00 must be skipped.
    vi.setSystemTime(new Date('2026-04-15T14:00:00Z'));
    const today = new Date('2026-04-15T14:00:00Z');
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const slots = findBestSlots([], 5, makeEngagement(), { fillMode: 'depth', postsPerDay: 6 });
    const todaySlots = slots.filter((s) => s.date === todayStr);
    for (const s of todaySlots) {
      const hour = Number.parseInt(s.time.slice(0, 2), 10);
      expect(hour).toBeGreaterThan(16); // strictly after current local hour
    }
  });

  it('honours per-platform daily caps — full day is skipped when any target platform is at cap', () => {
    const eng = makeEngagement();
    const baseline = findBestSlots([], 1, eng);
    const cappedDate = baseline[0].date;
    const existing: ExistingPost[] = [
      { date: cappedDate, time: '12:00', platforms: ['instagram'], status: 'scheduled' },
      { date: cappedDate, time: '18:00', platforms: ['instagram'], status: 'scheduled' },
    ];
    const slots = findBestSlots(existing, 5, eng, {
      platforms: ['instagram'],
      caps: { instagram: 2 },
    });
    for (const s of slots) {
      expect(s.date).not.toBe(cappedDate);
    }
  });

  it('ignores `posted` and `failed` posts when computing platform caps', () => {
    const eng = makeEngagement();
    const baseline = findBestSlots([], 1, eng);
    const targetDate = baseline[0].date;
    // Fill the day with posted+failed entries — those should NOT count.
    const existing: ExistingPost[] = [
      { date: targetDate, time: '06:00', platforms: ['instagram'], status: 'posted' },
      { date: targetDate, time: '07:00', platforms: ['instagram'], status: 'failed' },
    ];
    const slots = findBestSlots(existing, 5, eng, {
      platforms: ['instagram'],
      caps: { instagram: 1 },
    });
    // The day should still be available since posted+failed don't count.
    expect(slots.some(s => s.date === targetDate)).toBe(true);
  });

  it('returns empty array when count is 0', () => {
    expect(findBestSlots([], 0, makeEngagement())).toEqual([]);
  });

  describe('AUTO-SCHEDULE-FIX (2026-05-21): postsPerDay hard cap', () => {
    it('caps same-call picks at postsPerDay per day', () => {
      // Maurice's bug: without a hard cap, 5 requested slots could all
      // land on the dominant engagement day (Saturday). With postsPerDay=1
      // each day can hold at most one slot from this call.
      const slots = findBestSlots([], 5, makeEngagement(), { postsPerDay: 1 });
      const dates = slots.map((s) => s.date);
      const uniqueDates = new Set(dates);
      expect(uniqueDates.size).toBe(dates.length);
      expect(dates.length).toBe(5);
    });

    it('respects existing posts in the cap accounting', () => {
      // 2 existing posts on the engagement-best day saturate it. A new
      // pick with postsPerDay=2 must land somewhere else.
      const eng = makeEngagement();
      const baselineSlot = findBestSlots([], 1, eng)[0];
      const dominantDate = baselineSlot.date;
      const existing = [
        { date: dominantDate, time: '20:00', platforms: ['instagram'] },
        { date: dominantDate, time: '19:00', platforms: ['instagram'] },
      ];
      const next = findBestSlots(existing, 1, eng, { postsPerDay: 2 });
      expect(next.length).toBe(1);
      expect(next[0].date).not.toBe(dominantDate);
    });

    it('without postsPerDay (undefined) preserves old soft-penalty behaviour', () => {
      // Back-compat: 5 picks against an engagement profile with a heavy
      // weekend bias would historically stack on the dominant day. We
      // assert that the cap-less path still permits same-day duplicates
      // (the existing soft penalty isn't strong enough). If this test
      // ever flips to all-unique, the soft penalty was tuned up — fine,
      // but the cap test above is the real guarantee.
      const slots = findBestSlots([], 5, makeEngagement());
      const dates = slots.map((s) => s.date);
      expect(dates.length).toBe(5);
      // Don't assert uniqueness — point is the cap path is what enforces it.
    });

    it('caps interact with platform per-day caps (both honored)', () => {
      const slots = findBestSlots([], 4, makeEngagement(), {
        postsPerDay: 1,
        platforms: ['instagram'],
        caps: { instagram: 1 },
      });
      const dates = slots.map((s) => s.date);
      expect(new Set(dates).size).toBe(dates.length);
    });
  });

  describe('AUTO-SCHEDULE-DEPTH-FIRST (2026-05-22): fillMode=depth', () => {
    it('fills each day\'s heatmap-ordered hours before moving to the next day', () => {
      // Maurice's reported failure mode: 12 posts all queued at 19:00
      // across 12 days because the breadth-first picker spread one
      // pick per day at each day's peak hour. Depth-first should
      // cluster picks on the earliest day at varied hours instead.
      // Fixture has 3 distinct hours (12, 18, 20) — pick exactly that
      // many so the test asserts pure within-day fill without spilling.
      const slots = findBestSlots([], 3, makeEngagement(), {
        postsPerDay: 6,
        fillMode: 'depth',
      });
      expect(slots).toHaveLength(3);
      // All 3 should land on the SAME (earliest) day in depth mode.
      const dates = new Set(slots.map((s) => s.date));
      expect(dates.size).toBe(1);
      // And they should be at 3 DISTINCT hours, picked highest-weight first.
      const hours = slots.map((s) => Number.parseInt(s.time.slice(0, 2), 10));
      expect(new Set(hours).size).toBe(3);
      // The first slot must be the peak hour (highest weight in the
      // makeEngagement profile is hour 20 at weight 0.95).
      expect(hours[0]).toBe(20);
      // Second pick should be next-highest weight (18 at 0.85).
      expect(hours[1]).toBe(18);
    });

    it('spills to the next day once the cap is reached', () => {
      // Fixture has 3 distinct hours per day. Asking for 6 → fills
      // day 1 (3 picks) then day 2 (3 picks). Even with postsPerDay=6
      // the depth-first picker still spills at the hour-exhaustion
      // boundary, not just at the postsPerDay cap.
      const slots = findBestSlots([], 6, makeEngagement(), {
        postsPerDay: 6,
        fillMode: 'depth',
      });
      expect(slots).toHaveLength(6);
      const day1 = slots[0].date;
      const day2 = slots[3].date;
      expect(day1).not.toBe(day2);
      expect(slots.slice(0, 3).every((s) => s.date === day1)).toBe(true);
      expect(slots.slice(3, 6).every((s) => s.date === day2)).toBe(true);
    });

    it('respects postsPerDay as an explicit cap before hour exhaustion', () => {
      // postsPerDay=2 means each day caps at 2 picks even though the
      // fixture has 3 distinct hours. 6 picks → 3 days × 2 picks each.
      const slots = findBestSlots([], 6, makeEngagement(), {
        postsPerDay: 2,
        fillMode: 'depth',
      });
      expect(slots).toHaveLength(6);
      const dateCounts = new Map<string, number>();
      for (const s of slots) dateCounts.set(s.date, (dateCounts.get(s.date) ?? 0) + 1);
      // 3 distinct dates, each with exactly 2 picks
      expect(dateCounts.size).toBe(3);
      for (const c of dateCounts.values()) expect(c).toBe(2);
    });

    it('respects existing posts on a day toward the per-day cap', () => {
      // 5 existing posts on the engagement-best day already; depth=2/day
      // means that day is over-cap. Picker must skip to next day.
      const eng = makeEngagement();
      const firstSlot = findBestSlots([], 1, eng)[0];
      const saturated = firstSlot.date;
      const existing = [
        { date: saturated, time: '08:00', platforms: ['instagram'] },
        { date: saturated, time: '20:00', platforms: ['instagram'] },
      ];
      const slots = findBestSlots(existing, 1, eng, { postsPerDay: 2, fillMode: 'depth' });
      expect(slots[0].date).not.toBe(saturated);
    });

    it('back-compat: omitting fillMode preserves breadth-first behaviour', () => {
      // Same call without fillMode should still pass the existing
      // postsPerDay=1 same-call cap test — confirming the new option
      // is additive, not a behaviour change for existing callers.
      const slots = findBestSlots([], 5, makeEngagement(), { postsPerDay: 1 });
      const dates = slots.map((s) => s.date);
      expect(new Set(dates).size).toBe(dates.length); // breadth: one per day
    });
  });

  it('reason string mentions IG data when source is instagram', () => {
    const eng = makeEngagement();
    eng.source = 'instagram';
    const slots = findBestSlots([], 1, eng);
    expect(slots[0].reason).toContain('IG data');
  });

  it('reason string mentions research when source is default', () => {
    const slots = findBestSlots([], 1, makeEngagement());
    expect(slots[0].reason).toContain('research');
  });

  describe('BUG-CRIT-002 — distributes across the week instead of piling on one day', () => {
    it('spreads 10 picks across multiple days, not all on one day', () => {
      const slots = findBestSlots([], 10, makeEngagement());
      const dayCounts = slots.reduce<Record<string, number>>((acc, s) => {
        acc[s.date] = (acc[s.date] || 0) + 1;
        return acc;
      }, {});
      const distinctDays = Object.keys(dayCounts).length;
      expect(distinctDays).toBeGreaterThanOrEqual(5);
      const maxOnAnyDay = Math.max(...Object.values(dayCounts));
      expect(maxOnAnyDay).toBeLessThanOrEqual(3);
    });

    it('penalizes a day proportionally to existing posts on it', () => {
      const eng = makeEngagement();
      const baseline = findBestSlots([], 1, eng);
      const bestDay = baseline[0].date;
      const existing: ExistingPost[] = [
        { date: bestDay, time: '12:00', platforms: ['instagram'], status: 'scheduled' },
        { date: bestDay, time: '18:00', platforms: ['instagram'], status: 'scheduled' },
        { date: bestDay, time: '20:00', platforms: ['instagram'], status: 'scheduled' },
      ];
      const next = findBestSlots(existing, 1, eng);
      expect(next[0].date).not.toBe(bestDay);
    });

    it('cross-platform: a Twitter post on a day still penalizes that day for an Instagram pick', () => {
      const eng = makeEngagement();
      const baseline = findBestSlots([], 1, eng);
      const bestDay = baseline[0].date;
      const existing: ExistingPost[] = [
        { date: bestDay, time: '20:00', platforms: ['twitter'], status: 'scheduled' },
        { date: bestDay, time: '18:00', platforms: ['twitter'], status: 'scheduled' },
        { date: bestDay, time: '12:00', platforms: ['twitter'], status: 'scheduled' },
      ];
      const next = findBestSlots(existing, 1, eng, { platforms: ['instagram'] });
      expect(next[0].date).not.toBe(bestDay);
    });

    it('iterative single-slot picks (simulating the pipeline loop) distribute across days', () => {
      const eng = makeEngagement();
      const accumulated: ExistingPost[] = [];
      for (let i = 0; i < 12; i++) {
        const [pick] = findBestSlots(accumulated, 1, eng);
        accumulated.push({
          date: pick.date,
          time: pick.time,
          platforms: ['instagram'],
          status: 'scheduled',
        });
      }
      const dayCounts = accumulated.reduce<Record<string, number>>((acc, p) => {
        acc[p.date] = (acc[p.date] || 0) + 1;
        return acc;
      }, {});
      expect(Object.keys(dayCounts).length).toBeGreaterThanOrEqual(5);
      expect(Math.max(...Object.values(dayCounts))).toBeLessThanOrEqual(3);
    });

    it('overflows to the second week once the first week is uniformly saturated', () => {
      const eng = makeEngagement();
      const accumulated: ExistingPost[] = [];
      // Saturate the first week — 14 picks is enough to push the algorithm past the first 7 days.
      for (let i = 0; i < 14; i++) {
        const [pick] = findBestSlots(accumulated, 1, eng);
        accumulated.push({
          date: pick.date,
          time: pick.time,
          platforms: ['instagram'],
          status: 'scheduled',
        });
      }
      const startMs = new Date('2026-04-16').getTime();
      const week1End = startMs + 7 * 24 * 60 * 60 * 1000;
      const week2Picks = accumulated.filter(p => new Date(p.date).getTime() >= week1End);
      expect(week2Picks.length).toBeGreaterThan(0);
    });

    it('historical posted/failed entries do NOT penalize a day for distribution', () => {
      const eng = makeEngagement();
      const baseline = findBestSlots([], 1, eng);
      const bestDay = baseline[0].date;
      // Use a historical hour OUTSIDE the engagement window so the slot
      // itself doesn't get marked taken — we're isolating the "should
      // posted/failed count toward the distribution divisor?" question
      // from the orthogonal "is the exact time slot still free?" check.
      const existing: ExistingPost[] = [
        { date: bestDay, time: '07:00', platforms: ['instagram'], status: 'posted' },
        { date: bestDay, time: '08:00', platforms: ['instagram'], status: 'failed' },
      ];
      const next = findBestSlots(existing, 1, eng);
      expect(next[0].date).toBe(bestDay);
    });
  });
});

describe('findBestSlot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // INCLUDE-TODAY (2026-05-22): pinned to 03:00 UTC = 05:00 CEST so
    // all engagement-fixture hours (12, 18, 20) are still future when
    // "today" is considered as a candidate day. Earlier pin of 10:00
    // UTC = 12:00 local would have excluded the 12:00 hour from today.
    vi.setSystemTime(new Date('2026-04-15T03:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns one slot in {date,time} shape', () => {
    const slot = findBestSlot([], makeEngagement());
    expect(slot).toHaveProperty('date');
    expect(slot).toHaveProperty('time');
    expect(slot.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(slot.time).toMatch(/^\d{2}:\d{2}$/);
  });

  it('falls back to tomorrow @ 19:00 when engagement has no usable hours', () => {
    const empty: CachedEngagement = {
      hours: [],
      days: [],
      fetchedAt: Date.now(),
      source: 'default',
    };
    const slot = findBestSlot([], empty);
    expect(slot.time).toBe('19:00');
  });

  // BUG-2 (2026-05-23): when depth-first + postsPerDay saturates every
  // day in the constrained horizon, retry the pick with breadth-first +
  // 14-day + no postsPerDay cap (the same shape the manual Auto Schedule
  // button uses) BEFORE falling through to the tomorrow @ 19:00
  // absolute fallback. Without this, the pipeline's auto-schedule path
  // would dump every new post on tomorrow @ 19:00 once the user had
  // approved/queued enough posts to fill the depth-first window.
  describe('BUG-2 (2026-05-23): calendar-analysed retry when constrained pick is empty', () => {
    it('retries with breadth-first when depth-first saturates the 7-day horizon', () => {
      const eng = makeEngagement();
      // Saturate days 0..6 with 2 posts each (postsPerDay cap will hit).
      const existing: ExistingPost[] = [];
      const start = new Date('2026-04-15T03:00:00Z');
      for (let d = 0; d < 7; d++) {
        const day = new Date(start);
        day.setDate(start.getDate() + d);
        const dateStr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
        existing.push({ date: dateStr, time: '20:00', status: 'pending_approval' });
        existing.push({ date: dateStr, time: '18:00', status: 'pending_approval' });
      }
      const slot = findBestSlot(existing, eng, {
        horizonDays: 7,
        postsPerDay: 2,
        fillMode: 'depth',
      });
      // The retry path uses 14-day breadth-first with no postsPerDay cap,
      // so the picker can land a slot somewhere in days 0..13 even though
      // depth-first refused. Crucially, the picked time must NOT be the
      // absolute fallback's 19:00 default — calendar analysis picks the
      // best engagement hour (20:00 is highest in the fixture).
      expect(slot.time).toBe('20:00');
    });

    it('does NOT trigger the retry when the caller passes no constraints', () => {
      // Sanity: an unconstrained call that returns empty (because the
      // engagement is unusable) must still hit the tomorrow @ 19:00
      // absolute fallback rather than looping in retry. The empty
      // engagement makes findBestSlots return [] regardless of options.
      const empty: CachedEngagement = {
        hours: [],
        days: [],
        fetchedAt: Date.now(),
        source: 'default',
      };
      const slot = findBestSlot([], empty);
      expect(slot.time).toBe('19:00');
    });
  });
});

describe('loadEngagementData / saveEngagementData', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    vi.useFakeTimers();
    // INCLUDE-TODAY (2026-05-22): pinned to 03:00 UTC = 05:00 CEST so
    // all engagement-fixture hours (12, 18, 20) are still future when
    // "today" is considered as a candidate day. Earlier pin of 10:00
    // UTC = 12:00 local would have excluded the 12:00 hour from today.
    vi.setSystemTime(new Date('2026-04-15T03:00:00Z'));
    store = setupLocalStorageStub();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns defaults when localStorage is empty', () => {
    const data = loadEngagementData();
    expect(data.source).toBe('default');
    expect(data.hours.length).toBeGreaterThan(0);
    expect(data.days).toHaveLength(7);
  });

  it('round-trips through saveEngagementData', () => {
    const original: CachedEngagement = {
      hours: [{ hour: 20, weight: 0.95 }],
      days: [{ day: 6, multiplier: 1.0 }],
      fetchedAt: Date.now(),
      source: 'instagram',
    };
    saveEngagementData(original);
    const loaded = loadEngagementData();
    expect(loaded.source).toBe('instagram');
    expect(loaded.hours).toEqual(original.hours);
    expect(loaded.days).toEqual(original.days);
  });

  it('falls back to defaults when cache is older than 24h TTL', () => {
    const stale: CachedEngagement = {
      hours: [{ hour: 3, weight: 1.0 }],
      days: [{ day: 1, multiplier: 1.0 }],
      fetchedAt: Date.now() - 25 * 60 * 60 * 1000,
      source: 'instagram',
    };
    store.set('mashup_engagement_cache', JSON.stringify(stale));
    const loaded = loadEngagementData();
    expect(loaded.source).toBe('default');
  });

  it('returns defaults when localStorage holds malformed JSON', () => {
    store.set('mashup_engagement_cache', 'not json');
    const loaded = loadEngagementData();
    expect(loaded.source).toBe('default');
  });
});
