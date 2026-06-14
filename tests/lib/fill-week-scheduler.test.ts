// V060-004: pickFillWeekSlot tests.
//
// Pure helper — pin `now` and verify the horizon flips from 7→14
// based on whether week 1 is filled, and that the `week` flag
// matches the slot date.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pickFillWeekSlot } from '@/lib/fill-week-scheduler';
import type { CachedEngagement } from '@/lib/smartScheduler';
import type { ScheduledPost } from '@/types/mashup';

// findBestSlots reads `new Date()` internally for its candidate window.
// Pin the system clock so candidate dates and the fill-status anchor
// agree.
const NOW = new Date(2026, 3, 20, 12, 0, 0); // Mon 2026-04-20 12:00 local

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function flatEngagement(): CachedEngagement {
  return {
    hours: [
      { hour: 6, weight: 0.3 },
      { hour: 12, weight: 0.5 },
      { hour: 18, weight: 0.9 },
      { hour: 20, weight: 1 },
    ],
    days: Array.from({ length: 7 }, (_, i) => ({ day: i, multiplier: 1 })),
    fetchedAt: 0,
    source: 'default',
  };
}

function post(date: string, time: string): ScheduledPost {
  return {
    id: `${date}-${time}`,
    imageId: 'img',
    date,
    time,
    platforms: ['instagram'],
    caption: '',
    status: 'scheduled',
  };
}

describe('pickFillWeekSlot — horizon switches with week-1 fill state', () => {
  it('with empty schedule, picks a slot in week 1 (tomorrow .. tomorrow+6)', () => {
    const result = pickFillWeekSlot({
      posts: [],
      engagement: flatEngagement(),
      postsPerDay: 2,
      now: NOW,
    });
    expect(result.week).toBe(1);
    const slotDate = new Date(`${result.date}T00:00:00`);
    // Week 1 = [tomorrow, tomorrow+7) = [today+1, today+8).
    const today = new Date(NOW); today.setHours(0, 0, 0, 0);
    // INCLUDE-TODAY: week 2 starts at today+7 (was today+8 pre-fix).
    const week2Start = new Date(today); week2Start.setDate(today.getDate() + 7);
    expect(slotDate.getTime()).toBeLessThan(week2Start.getTime());
  });

  it('once week 1 is fully booked, the slot lands in week 2', () => {
    // Saturate every day in week 1 (tomorrow .. tomorrow+6) with 2 posts
    // each at engagement-best hours, so any further slot must spill into
    // week 2 once the horizon expands to 14.
    const posts: ScheduledPost[] = [];
    // INCLUDE-TODAY (2026-05-22): horizon starts TODAY, not tomorrow.
    const today = new Date(NOW); today.setHours(0, 0, 0, 0);
    const tomorrow = today;
    for (let i = 0; i < 7; i++) {
      const d = new Date(tomorrow);
      d.setDate(tomorrow.getDate() + i);
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      posts.push(post(ds, '18:00'));
      posts.push(post(ds, '20:00'));
    }
    const result = pickFillWeekSlot({
      posts,
      engagement: flatEngagement(),
      postsPerDay: 2,
      now: NOW,
    });
    expect(result.week).toBe(2);
    const slotDate = new Date(`${result.date}T00:00:00`);
    // INCLUDE-TODAY: week 2 starts at today+7 (was today+8 pre-fix).
    const week2Start = new Date(today); week2Start.setDate(today.getDate() + 7);
    expect(slotDate.getTime()).toBeGreaterThanOrEqual(week2Start.getTime());
  });

  it('with week 1 partially filled, the slot still lands in week 1', () => {
    // Only 4 days of week 1 (tomorrow .. tomorrow+3) saturated → 3 days
    // still have gaps. The 7-day horizon must keep selection inside week 1.
    const posts: ScheduledPost[] = [];
    // INCLUDE-TODAY (2026-05-22): horizon starts TODAY, not tomorrow.
    const today = new Date(NOW); today.setHours(0, 0, 0, 0);
    const tomorrow = today;
    for (let i = 0; i < 4; i++) {
      const d = new Date(tomorrow);
      d.setDate(tomorrow.getDate() + i);
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      posts.push(post(ds, '18:00'));
      posts.push(post(ds, '20:00'));
    }
    const result = pickFillWeekSlot({
      posts,
      engagement: flatEngagement(),
      postsPerDay: 2,
      now: NOW,
    });
    expect(result.week).toBe(1);
  });
});
