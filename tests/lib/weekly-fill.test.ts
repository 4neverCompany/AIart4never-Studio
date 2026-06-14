// V030-004: weekly-fill helper tests.
//
// Pure math, no React / IDB / fetch — just needs a pinned `now` for
// determinism. Covers the per-day breakdown, terminal-status filtering,
// and the `filled` / `percent` aggregates.

import { describe, it, expect } from 'vitest';
import { computeWeekFillStatus } from '@/lib/weekly-fill';
import type { ScheduledPost } from '@/types/mashup';

function post(
  date: string,
  time: string,
  status: ScheduledPost['status'] = 'scheduled',
): ScheduledPost {
  return {
    id: `${date}-${time}`,
    imageId: 'img-1',
    date,
    time,
    platforms: ['instagram'],
    caption: '',
    status,
  };
}

// Monday 2026-04-19 at noon local — stable anchor for all cases.
// INCLUDE-TODAY (2026-05-22): the window now starts TODAY (was tomorrow
// pre-fix — matches findBestSlots which also considers today as a
// candidate now). For a 7-day target the days are 2026-04-19 ..
// 2026-04-25. Posts dated TODAY at a time AFTER `now` count toward
// the schedule; posts at an earlier hour today are filtered out by
// the `ts < now.getTime()` guard.
const NOW = new Date(2026, 3, 20, 12, 0, 0);

describe('computeWeekFillStatus', () => {
  it('empty schedule → 0%, 7 days, all gaps = postsPerDay', () => {
    const s = computeWeekFillStatus([], 7, 2, NOW);
    expect(s.targetDays).toBe(7);
    expect(s.targetTotal).toBe(14);
    expect(s.scheduledTotal).toBe(0);
    expect(s.filled).toBe(false);
    expect(s.percent).toBe(0);
    expect(s.days).toHaveLength(7);
    // INCLUDE-TODAY (2026-05-22): first day is TODAY (was tomorrow
    // pre-fix). 2026-04-20 is a Monday, so the labels start on Mon.
    expect(s.days[0].date).toBe('2026-04-20');
    expect(s.days[0].dayLabel).toBe('Mon');
    expect(s.days.every(d => d.gap === 2)).toBe(true);
    // Last day is today + 6 = Sun 2026-04-26.
    expect(s.days[6].date).toBe('2026-04-26');
    expect(s.days[6].dayLabel).toBe('Sun');
  });

  it('counts scheduled, posted, AND failed toward fill; tracks pending_approval separately; ignores only rejected', () => {
    // BUG-FIX-2026-06-06: previously 'posted' was excluded entirely,
    // causing the day to show as "open" in the pipeline after a
    // successful post. Now posted posts contribute to the fill so the
    // day is correctly recognized as full.
    //
    // V1.7.0-PRE-PROD-FIX: 'failed' also counts toward fill. A failed
    // post IS a tried slot — the daemon should NOT generate a new
    // post for that day just because the original attempt failed.
    // Only 'rejected' is excluded (the user explicitly said "don't
    // post this" → the day is genuinely free for new content).
    const posts: ScheduledPost[] = [
      post('2026-04-20', '18:00', 'scheduled'),
      post('2026-04-20', '20:00', 'pending_approval'),
      post('2026-04-20', '22:00', 'posted'),     // counts toward fill
      post('2026-04-21', '10:00', 'failed'),     // NOW counts toward fill
      post('2026-04-22', '09:00', 'scheduled'),
      post('2026-04-23', '10:00', 'rejected'),   // excluded
    ];
    const s = computeWeekFillStatus(posts, 7, 2, NOW);
    // day 0: 1 scheduled + 1 posted = 2 scheduledCount, 1 pending_approval
    expect(s.days[0].scheduledCount).toBe(2);
    expect(s.days[0].pendingApprovalCount).toBe(1);
    // day 1: 1 failed → counts (was 0 before the fix)
    expect(s.days[1].scheduledCount).toBe(1);
    expect(s.days[1].pendingApprovalCount).toBe(0);
    // day 2: 1 scheduled
    expect(s.days[2].scheduledCount).toBe(1);
    // day 3: 1 rejected → still 0
    expect(s.days[3].scheduledCount).toBe(0);
    // total: 2 + 1 + 1 + 0 = 4 (was 3 before; +1 from failed)
    expect(s.scheduledTotal).toBe(4);
    expect(s.pendingApprovalTotal).toBe(1);
  });

  it('counts a PAST-dated failed post toward fill (the realistic case)', () => {
    // V1.8.1: the prior test only had a FUTURE-dated failed post
    // (2026-04-21 vs NOW 2026-04-20), so it passed the `ts < now`
    // filter and counted even without the fix — masking the real bug.
    // A real failed post is in the PAST (you already tried the slot).
    // NOW = 2026-04-20 12:00; this failed post at 08:00 today is past.
    // Pre-fix it was dropped by the future-only filter → day showed
    // "open" → the daemon re-filled the slot Maurice already used.
    const posts: ScheduledPost[] = [
      post('2026-04-20', '08:00', 'failed'), // past today — must still count
    ];
    const s = computeWeekFillStatus(posts, 7, 2, NOW);
    expect(s.days[0].date).toBe('2026-04-20');
    expect(s.days[0].scheduledCount).toBe(1);
    expect(s.scheduledTotal).toBe(1);
  });

  it('pending_approval posts do not satisfy fill — daemon must keep generating', () => {
    // 7 days * 2/day = 14 slots. INCLUDE-TODAY (2026-05-22): place 14
    // pending_approval posts starting TODAY. Both slot times (14:00,
    // 20:00) are after the noon NOW so today's two pending posts
    // aren't filtered as past.
    const today = new Date(NOW);
    today.setHours(0, 0, 0, 0);
    const posts: ScheduledPost[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      posts.push(post(ds, '14:00', 'pending_approval'));
      posts.push(post(ds, '20:00', 'pending_approval'));
    }
    const s = computeWeekFillStatus(posts, 7, 2, NOW);
    expect(s.scheduledTotal).toBe(0);
    expect(s.filled).toBe(false);
    expect(s.percent).toBe(0);
    expect(s.pendingApprovalTotal).toBe(14);
    // Per-day pending count is preserved for the indicator UI.
    expect(s.days.every((d) => d.pendingApprovalCount === 2)).toBe(true);
  });

  it('mixed scheduled + pending_approval: only scheduled count toward fill', () => {
    // Tomorrow has 2 scheduled (filled), day after has 2 pending_approval (not filled).
    const posts: ScheduledPost[] = [
      post('2026-04-20', '14:00', 'scheduled'),
      post('2026-04-20', '20:00', 'scheduled'),
      post('2026-04-21', '14:00', 'pending_approval'),
      post('2026-04-21', '20:00', 'pending_approval'),
    ];
    const s = computeWeekFillStatus(posts, 7, 2, NOW);
    expect(s.days[0].scheduledCount).toBe(2);
    expect(s.days[0].gap).toBe(0);
    expect(s.days[0].pendingApprovalCount).toBe(0);
    expect(s.days[1].scheduledCount).toBe(0);
    expect(s.days[1].gap).toBe(2); // gap is computed from scheduledCount, not pending
    expect(s.days[1].pendingApprovalCount).toBe(2);
    expect(s.scheduledTotal).toBe(2);
    expect(s.pendingApprovalTotal).toBe(2);
    expect(s.filled).toBe(false);
  });

  it('pendingApprovalTotal sums across days; posted AND failed count toward fill, only rejected excluded', () => {
    // BUG-FIX-2026-06-06: 'posted' now counts toward fill (it's a
    // successfully filled slot).
    // V1.7.0-PRE-PROD-FIX: 'failed' also counts toward fill (it's a
    // tried slot — the daemon should not regenerate). 'rejected'
    // is the only status that frees the day for new content.
    const posts: ScheduledPost[] = [
      post('2026-04-20', '14:00', 'pending_approval'),
      post('2026-04-21', '14:00', 'pending_approval'),
      post('2026-04-22', '14:00', 'pending_approval'),
      post('2026-04-20', '15:00', 'posted'),     // counts toward fill
      post('2026-04-20', '16:00', 'failed'),     // counts toward fill (was excluded)
      post('2026-04-20', '17:00', 'rejected'),   // excluded
    ];
    const s = computeWeekFillStatus(posts, 7, 2, NOW);
    expect(s.pendingApprovalTotal).toBe(3);
    // posted + failed on day 0 → scheduledCount = 2
    expect(s.scheduledTotal).toBe(2);
    expect(s.days[0].scheduledCount).toBe(2);
  });

  // V1.7.0-PRE-PROD-FIX: dedicated test for the "failed counts toward
  // fill, rejected still excluded" contract. Reproduces the exact bug
  // Maurice reported: a posted-then-failed entry on a day should NOT
  // leave the day marked as "open" in the pipeline UI.
  it('counts a failed post toward fill so the daemon does not regenerate', () => {
    const posts: ScheduledPost[] = [
      post('2026-04-20', '14:00', 'failed'),     // the failed post in question
    ];
    const s = computeWeekFillStatus(posts, 7, 1, NOW);
    // Day 0 should report 1 scheduledCount, 0 gap, NOT "open"
    expect(s.days[0].scheduledCount).toBe(1);
    expect(s.days[0].gap).toBe(0);
    expect(s.scheduledTotal).toBe(1);
  });

  it('does NOT count rejected posts (those free the day for new content)', () => {
    const posts: ScheduledPost[] = [
      post('2026-04-20', '14:00', 'rejected'),
    ];
    const s = computeWeekFillStatus(posts, 7, 1, NOW);
    expect(s.days[0].scheduledCount).toBe(0);
    expect(s.days[0].gap).toBe(1);
    expect(s.scheduledTotal).toBe(0);
  });

  it('pending_approval posts outside the horizon are ignored from pendingApprovalTotal', () => {
    const posts: ScheduledPost[] = [
      post('2026-04-20', '14:00', 'pending_approval'),  // day 1 — counted
      post('2026-04-26', '14:00', 'pending_approval'),  // day 7 (last day) — counted
      post('2026-04-27', '14:00', 'pending_approval'),  // day 8 — outside horizon
      post('2026-05-15', '14:00', 'pending_approval'),  // far future — outside
    ];
    const s = computeWeekFillStatus(posts, 7, 2, NOW);
    expect(s.pendingApprovalTotal).toBe(2);
    expect(s.days[0].pendingApprovalCount).toBe(1);
    expect(s.days[6].pendingApprovalCount).toBe(1);
  });

  it('over-scheduled day with pending_approval still bounds scheduledTotal at target', () => {
    // 4 scheduled (over the 2/day target) + 3 pending_approval on day 0.
    // scheduledCount=4, pendingApprovalCount=3 — but capped contribution=2.
    // Other days remain empty → not filled.
    // INCLUDE-TODAY (2026-05-22): NOW is noon today; use only future
    // hours so the ts < now filter doesn't drop any.
    const posts: ScheduledPost[] = [
      post('2026-04-20', '12:00', 'scheduled'),
      post('2026-04-20', '13:00', 'scheduled'),
      post('2026-04-20', '14:00', 'scheduled'),
      post('2026-04-20', '15:00', 'scheduled'),
      post('2026-04-20', '18:00', 'pending_approval'),
      post('2026-04-20', '20:00', 'pending_approval'),
      post('2026-04-20', '22:00', 'pending_approval'),
    ];
    const s = computeWeekFillStatus(posts, 7, 2, NOW);
    expect(s.days[0].scheduledCount).toBe(4);
    expect(s.days[0].pendingApprovalCount).toBe(3);
    expect(s.scheduledTotal).toBe(2); // capped at day-0's target
    expect(s.pendingApprovalTotal).toBe(3);
    expect(s.filled).toBe(false);
  });

  it('INCLUDE-TODAY (2026-05-22): today\'s FUTURE hours count, today\'s past hours are filtered, yesterday is off-window', () => {
    // NOW is Monday 2026-04-20 at noon local. The window now starts
    // TODAY, so day[0] = 2026-04-20.
    const posts: ScheduledPost[] = [
      post('2026-04-19', '14:00', 'scheduled'), // yesterday → off-window entirely
      post('2026-04-19', '23:00', 'scheduled'), // yesterday → off-window
      post('2026-04-20', '09:00', 'scheduled'), // today PAST (09:00 < 12:00) → filtered by ts < now
      post('2026-04-20', '20:00', 'scheduled'), // today FUTURE → counted
    ];
    const s = computeWeekFillStatus(posts, 7, 2, NOW);
    expect(s.days[0].date).toBe('2026-04-20');
    // Only the future-today post counts; yesterday + past-today are excluded.
    expect(s.days[0].scheduledCount).toBe(1);
    expect(s.scheduledTotal).toBe(1);
  });

  it('posts outside the target window are ignored', () => {
    const posts: ScheduledPost[] = [
      post('2026-04-26', '12:00'),   // day 6 of window (within 7)
      post('2026-04-27', '12:00'),   // day 7 (outside 7)
      post('2026-05-05', '12:00'),   // far future
    ];
    const s = computeWeekFillStatus(posts, 7, 2, NOW);
    expect(s.scheduledTotal).toBe(1);
    expect(s.days[6].scheduledCount).toBe(1);
  });

  it('filled=true and percent=100 when target is met exactly', () => {
    // 7 days * 2/day = 14 posts. INCLUDE-TODAY (2026-05-22): window
    // now starts TODAY, so place 2 on each day starting today.
    // Both slot times (14:00, 20:00) are AFTER the noon NOW, so
    // today's two posts won't be filtered as past.
    const today = new Date(NOW);
    today.setHours(0, 0, 0, 0);
    const posts: ScheduledPost[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      posts.push(post(ds, '14:00'));
      posts.push(post(ds, '20:00'));
    }
    const s = computeWeekFillStatus(posts, 7, 2, NOW);
    expect(s.filled).toBe(true);
    expect(s.percent).toBe(100);
    expect(s.days.every(d => d.gap === 0)).toBe(true);
  });

  it('over-target total caps each day at postsPerDay; raw per-day count preserved', () => {
    // Fill the full week (14), then add 3 extras on day 0 (raw=17, capped=14).
    // INCLUDE-TODAY (2026-05-22): horizon starts TODAY, place from today.
    const today = new Date(NOW);
    today.setHours(0, 0, 0, 0);
    const posts: ScheduledPost[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      posts.push(post(ds, '14:00'));
      posts.push(post(ds, '20:00'));
    }
    posts.push(post('2026-04-20', '15:00'));
    posts.push(post('2026-04-20', '16:00'));
    posts.push(post('2026-04-20', '17:00'));
    const s = computeWeekFillStatus(posts, 7, 2, NOW);
    // Aggregate is capped at targetTotal — no overflow counting.
    expect(s.scheduledTotal).toBe(14);
    expect(s.scheduledTotal).toBeLessThanOrEqual(s.targetTotal);
    expect(s.filled).toBe(true);
    expect(s.percent).toBe(100);
    // Day-level raw count is preserved for tooltip / per-day display.
    expect(s.days[0].scheduledCount).toBe(5);
    expect(s.days[0].gap).toBe(0);
  });

  it('uneven over-scheduling on one day does not mask gaps elsewhere', () => {
    // 8 posts on day 0 (tomorrow), 0 elsewhere → raw=8, capped=2.
    // Was the bug shape: previously this would have summed to 8 toward the
    // 14-target, making the meter look 57% full when the week is mostly empty.
    const posts: ScheduledPost[] = Array.from({ length: 8 }, (_, k) =>
      post('2026-04-20', `${String(13 + k).padStart(2, '0')}:00`),
    );
    const s = computeWeekFillStatus(posts, 7, 2, NOW);
    expect(s.days[0].scheduledCount).toBe(8);
    expect(s.scheduledTotal).toBe(2); // only day-0's 2 slots count
    expect(s.targetTotal).toBe(14);
    expect(s.filled).toBe(false);
    expect(s.percent).toBe(Math.round((2 / 14) * 100));
  });

  it('respects a non-default postsPerDay', () => {
    const posts: ScheduledPost[] = [
      post('2026-04-20', '14:00'),
      post('2026-04-20', '20:00'),
      post('2026-04-20', '22:00'),
    ];
    const s = computeWeekFillStatus(posts, 7, 4, NOW);
    expect(s.targetTotal).toBe(28);
    expect(s.days[0].target).toBe(4);
    expect(s.days[0].gap).toBe(1);
    expect(s.filled).toBe(false);
  });

  it('malformed date string on a post is skipped rather than throwing', () => {
    const posts: ScheduledPost[] = [
      post('not-a-date', '14:00'),
      post('2026-04-20', '14:00'),
    ];
    const s = computeWeekFillStatus(posts, 7, 2, NOW);
    expect(s.scheduledTotal).toBe(1);
  });

  it('targetDays=0 produces an empty status without dividing by zero', () => {
    const s = computeWeekFillStatus([], 0, 2, NOW);
    expect(s.days).toEqual([]);
    expect(s.targetTotal).toBe(0);
    expect(s.percent).toBe(0);
    expect(s.filled).toBe(true); // 0 >= 0
  });

  it('undefined posts is treated the same as an empty array', () => {
    const s = computeWeekFillStatus(undefined, 7, 2, NOW);
    expect(s.scheduledTotal).toBe(0);
    expect(s.days).toHaveLength(7);
    expect(s.filled).toBe(false);
  });

  // INCLUDE-TODAY (2026-05-22): late-evening behaviour. Even when NOW
  // is 23:30 — past every realistic engagement hour — the window's
  // first day is still TODAY. Posts at past-today hours are filtered
  // by ts < now.getTime() but the day itself stays in `days[]` so the
  // UI can show a 0-of-target indicator for "today is done."
  it('INCLUDE-TODAY: at 23:30 today, first day is still today; past-today posts are filtered', () => {
    const lateNight = new Date(2026, 3, 20, 23, 30, 0); // Mon 23:30 local
    const s = computeWeekFillStatus([], 7, 2, lateNight);
    expect(s.days[0].date).toBe('2026-04-20');
    expect(s.days[0].dayLabel).toBe('Mon');
    expect(s.days[6].date).toBe('2026-04-26');
    // A post placed earlier today must NOT count — already in the past
    // per the ts < now.getTime() guard.
    const todayPastPost = computeWeekFillStatus(
      [post('2026-04-20', '18:00', 'scheduled')], // 18:00 < 23:30
      7,
      2,
      lateNight,
    );
    expect(todayPastPost.scheduledTotal).toBe(0);
    // The day IS in the window now (it's today), but the post itself
    // didn't add to scheduledCount because it was filtered as past.
    expect(todayPastPost.days[0].date).toBe('2026-04-20');
    expect(todayPastPost.days[0].scheduledCount).toBe(0);
  });
});
