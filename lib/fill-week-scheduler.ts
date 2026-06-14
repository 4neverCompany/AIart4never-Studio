// V060-004: fill-week-first slot picker.
//
// The pipeline used to call findBestSlot with the default 14-day window
// for every new post, so the engagement-best slot from week 2 (often
// Saturday evening) could outrank lower-engagement slots in the current
// week — leaving holes in this week while next week filled up first.
//
// pickFillWeekSlot caps the candidate horizon at 7 days while the
// current week still has gaps (per `computeWeekFillStatus`), then
// extends to 14 days once week 1 is filled. The engagement-based
// scoring inside findBestSlot is unchanged — this helper only narrows
// the window.
//
// Pure: pass `now` so tests can pin the clock.

import { findBestSlot, type CachedEngagement } from './smartScheduler';
import { computeWeekFillStatus } from './weekly-fill';
import type { ScheduledPost, UserSettings } from '../types/mashup';

export interface PickFillWeekSlotOptions {
  posts: ScheduledPost[];
  engagement: CachedEngagement;
  postsPerDay: number;
  platforms?: string[];
  caps?: UserSettings['pipelineDailyCaps'];
  now?: Date;
}

export interface FillWeekSlotResult {
  date: string;
  time: string;
  /** Which week the slot landed in — 1 = current 7-day window, 2 = days 8-14. */
  week: 1 | 2;
}

/**
 * Pick the next slot, prioritising the current week.
 *
 * - When week 1 (next 7 days) has gaps → confine the candidate window
 *   to 7 days so the engagement-best slot lands here, not in week 2.
 * - When week 1 is already filled → extend to a 14-day window so the
 *   pipeline pre-schedules week 2 at the engagement-best times.
 */
export function pickFillWeekSlot(opts: PickFillWeekSlotOptions): FillWeekSlotResult {
  const { posts, engagement, postsPerDay, platforms, caps, now } = opts;
  const week1 = computeWeekFillStatus(posts, 7, postsPerDay, now ?? new Date());
  const horizonDays = week1.filled ? 14 : 7;
  // AUTO-SCHEDULE-FIX (2026-05-21): forward postsPerDay as a hard cap on
  // findBestSlot, not just an input to computeWeekFillStatus. The soft
  // dispersion penalty inside findBestSlots (`score / (1 + dayCount)`)
  // wasn't enough to stop a dominant engagement day from absorbing every
  // pipeline post — Saturday 20:00 at raw=20 still beat Monday 12:00 at
  // raw=2.4 even after 5 Saturday posts (20/6=3.3 > 2.4/1). The hard cap
  // forces the picker to bounce off a full day and land on the next
  // engagement-best day instead.
  // AUTO-SCHEDULE-DEPTH-FIRST (2026-05-22): pipeline path uses depth-first
  // fill — each day fills its heatmap-ordered hours up to postsPerDay
  // before spilling to the next day. Previously findBestSlots' soft
  // score-max picker spread one post per day across days at each day's
  // peak hour, producing Maurice's "12 posts all at 19:00" cluster
  // across 12 different days.
  const slot = findBestSlot(posts, engagement, {
    platforms,
    caps,
    horizonDays,
    postsPerDay,
    fillMode: 'depth',
  });

  // Week classification: post INCLUDE-TODAY (2026-05-22), both
  // `findBestSlots` and `computeWeekFillStatus` anchor on TODAY. Week 1
  // is the 7-day window starting today = [today, today+7). Anything
  // landing at today+7 or later is week 2. The cutoff slid by one day
  // vs the prior "tomorrow + 7" convention; consumers that read the
  // `week: 1 | 2` field are unchanged — same number of days in week 1.
  const today = new Date(now ?? new Date());
  today.setHours(0, 0, 0, 0);
  const week2Start = new Date(today);
  week2Start.setDate(today.getDate() + 7);
  const slotDate = new Date(`${slot.date}T00:00:00`);
  const week: 1 | 2 = slotDate.getTime() >= week2Start.getTime() ? 2 : 1;

  return { date: slot.date, time: slot.time, week };
}
