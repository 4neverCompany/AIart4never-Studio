import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  countFutureScheduledPosts,
  IdeaTimeoutError,
  pickContinuousBranch,
} from '@/lib/pipeline-daemon-utils';
import { SkipIdeaSignal } from '@/lib/pipeline-processor';
import { computeWeekFillStatus } from '@/lib/weekly-fill';
import type { ScheduledPost } from '@/types/mashup';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makePost(
  date: string,
  time: string,
  status?: ScheduledPost['status'],
): ScheduledPost {
  return {
    id: `post-${Math.random().toString(36).slice(2, 8)}`,
    imageId: 'img-001',
    date,
    time,
    platforms: ['instagram'],
    caption: 'Test caption',
    status,
  };
}

// ─── countFutureScheduledPosts ────────────────────────────────────────────────
//
// Fake now = 2026-04-18T12:00:00Z
// Horizon (daysAhead=7) = 2026-04-25T12:00:00Z

describe('countFutureScheduledPosts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('returns 0 for an empty array', () => {
    expect(countFutureScheduledPosts([], 7)).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(countFutureScheduledPosts(undefined, 7)).toBe(0);
  });

  it('counts a pending post (undefined status) within the horizon', () => {
    // 2026-04-20 is 2 days ahead — well inside 7-day window
    expect(countFutureScheduledPosts([makePost('2026-04-20', '18:00')], 7)).toBe(1);
  });

  it('counts a "scheduled" post within the horizon', () => {
    expect(countFutureScheduledPosts([makePost('2026-04-20', '18:00', 'scheduled')], 7)).toBe(1);
  });

  it('counts a "pending_approval" post within the horizon', () => {
    expect(
      countFutureScheduledPosts([makePost('2026-04-20', '18:00', 'pending_approval')], 7),
    ).toBe(1);
  });

  it('excludes "posted" posts', () => {
    expect(countFutureScheduledPosts([makePost('2026-04-20', '18:00', 'posted')], 7)).toBe(0);
  });

  it('excludes "failed" posts', () => {
    expect(countFutureScheduledPosts([makePost('2026-04-20', '18:00', 'failed')], 7)).toBe(0);
  });

  it('excludes past posts', () => {
    // 2026-04-17 is yesterday; even UTC-12 puts it before fake now
    expect(countFutureScheduledPosts([makePost('2026-04-17', '18:00')], 7)).toBe(0);
  });

  it('excludes posts beyond the horizon', () => {
    // 2026-04-26 is 8 days ahead — beyond 7-day window in all timezones
    expect(countFutureScheduledPosts([makePost('2026-04-26', '18:00')], 7)).toBe(0);
  });

  it('counts only active in-window posts from a mixed array', () => {
    const posts = [
      makePost('2026-04-19', '18:00'),               // 1 day ahead — counted
      makePost('2026-04-20', '18:00', 'scheduled'),  // 2 days ahead — counted
      makePost('2026-04-17', '18:00'),                // past — excluded
      makePost('2026-04-20', '18:00', 'posted'),     // posted — excluded
      makePost('2026-04-26', '18:00'),                // beyond horizon — excluded
    ];
    expect(countFutureScheduledPosts(posts, 7)).toBe(2);
  });
});

// ─── IdeaTimeoutError ─────────────────────────────────────────────────────────

describe('IdeaTimeoutError', () => {
  it('is instanceof Error', () => {
    expect(new IdeaTimeoutError()).toBeInstanceOf(Error);
  });

  it('has kind === "timeout"', () => {
    expect(new IdeaTimeoutError().kind).toBe('timeout');
  });

  it('has expected name and message', () => {
    const err = new IdeaTimeoutError();
    expect(err.name).toBe('IdeaTimeoutError');
    expect(err.message).toBe('__IDEA_TIMEOUT__');
  });
});

// ─── Per-idea timeout race (daemon pattern) ───────────────────────────────────

describe('per-idea timeout race — IdeaTimeoutError + AbortController pattern', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const PER_IDEA_TIMEOUT_MS = 10 * 60 * 1000; // same constant as daemon

  it('resolves with the fast task when processIdea finishes before the cap', async () => {
    let handle: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      handle = setTimeout(() => reject(new IdeaTimeoutError()), PER_IDEA_TIMEOUT_MS);
    });

    const result = await Promise.race([Promise.resolve('done'), timeoutPromise]);
    clearTimeout(handle!);
    expect(result).toBe('done');
  });

  it('rejects with IdeaTimeoutError when the task exceeds the hard cap', async () => {
    const hanging = new Promise<void>(() => {}); // never resolves
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new IdeaTimeoutError()), PER_IDEA_TIMEOUT_MS);
    });

    const race = Promise.race([hanging, timeoutPromise]);
    // Attach the expectation BEFORE advancing timers to avoid unhandled-rejection warning.
    const assertion = expect(race).rejects.toBeInstanceOf(IdeaTimeoutError);
    await vi.advanceTimersByTimeAsync(PER_IDEA_TIMEOUT_MS + 1);
    await assertion;
  });

  it('aborts the skip controller when the hard timeout fires', async () => {
    const skipAbort = new AbortController();
    const hanging = new Promise<void>(() => {});
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        skipAbort.abort(); // mirrors daemon: unblock processIdea's skip checks
        reject(new IdeaTimeoutError());
      }, PER_IDEA_TIMEOUT_MS);
    });

    const race = Promise.race([hanging, timeoutPromise]);
    const assertion = expect(race).rejects.toBeInstanceOf(IdeaTimeoutError);
    await vi.advanceTimersByTimeAsync(PER_IDEA_TIMEOUT_MS + 1);
    await assertion;
    expect(skipAbort.signal.aborted).toBe(true);
  });

  it('IdeaTimeoutError is distinguishable from SkipIdeaSignal', () => {
    const timeout = new IdeaTimeoutError();
    const skip = new SkipIdeaSignal();
    expect(timeout).not.toBeInstanceOf(SkipIdeaSignal);
    expect(skip).not.toBeInstanceOf(IdeaTimeoutError);
    expect(timeout.kind).toBe('timeout');
    expect(skip.kind).toBe('skip');
  });
});

// ─── Continuous-mode fill decision (PIPELINE-CONT-V2) ────────────────────────
//
// The daemon's continuous-mode block (hooks/usePipelineDaemon.ts) picks one
// of three branches per cycle via `pickContinuousBranch`:
//
//   continue-not-filled  — !filled, generate more (immediate next cycle)
//   continue-pending     — filled but pendingApprovalTotal > 0 (no sleep)
//   sleep-confirmed      — filled AND pendingApprovalTotal === 0 (sleep)
//
// V091-QA-FOLLOWUP: the helper was lifted out of the hook into
// lib/pipeline-daemon-utils so the test binds to the actual production
// code rather than a mirror. A future change to the branch logic now
// surfaces here automatically.

describe('pickContinuousBranch — daemon decision (PIPELINE-CONT-V2)', () => {
  // Pin "now" to Mon 2026-04-20 noon — window starts Tue 2026-04-21.
  const NOW = new Date(2026, 3, 20, 12, 0, 0);

  function fillFor(posts: ScheduledPost[], horizonDays = 14, perDay = 2) {
    return computeWeekFillStatus(posts, horizonDays, perDay, NOW);
  }

  function fullWeekOf(status: ScheduledPost['status']): ScheduledPost[] {
    // 14 days × 2 posts each = 28 posts, all the given status.
    // INCLUDE-TODAY (2026-05-22): horizon starts TODAY, not tomorrow.
    // Anchor on today (00:00) so today's posts at 14:00 / 20:00 (both
    // after the noon NOW) get counted instead of filtered as past.
    const tomorrow = new Date(NOW);
    tomorrow.setHours(0, 0, 0, 0);
    const out: ScheduledPost[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(tomorrow);
      d.setDate(tomorrow.getDate() + i);
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      out.push(makePost(ds, '14:00', status));
      out.push(makePost(ds, '20:00', status));
    }
    return out;
  }

  it('empty schedule → continue (not filled)', () => {
    const fill = fillFor([]);
    expect(fill.filled).toBe(false);
    expect(fill.pendingApprovalTotal).toBe(0);
    expect(pickContinuousBranch(fill)).toBe('continue-not-filled');
  });

  it('horizon full of pending_approval → continue (not filled, pending > 0)', () => {
    const fill = fillFor(fullWeekOf('pending_approval'));
    // Critical: pending_approval does NOT count as filled. Pre-V2 this was
    // `filled = true` and the daemon slept while the user had 28 posts
    // waiting for approval.
    expect(fill.filled).toBe(false);
    expect(fill.pendingApprovalTotal).toBe(28);
    expect(pickContinuousBranch(fill)).toBe('continue-not-filled');
  });

  it('horizon full of scheduled → sleep (confirmed fill)', () => {
    const fill = fillFor(fullWeekOf('scheduled'));
    expect(fill.filled).toBe(true);
    expect(fill.pendingApprovalTotal).toBe(0);
    expect(pickContinuousBranch(fill)).toBe('sleep-confirmed');
  });

  it('horizon full of scheduled + extra pending elsewhere → continue (partial)', () => {
    // Every slot in the 2-week window is scheduled (filled=true), AND there
    // are extra pending_approval posts on the same days (pendingTotal>0).
    // Branch: continue immediately — the pending posts will either get
    // approved (rolling forward into another scheduled day later) or
    // rejected, both of which warrant another cycle.
    const posts = [
      ...fullWeekOf('scheduled'),
      makePost('2026-04-22', '15:00', 'pending_approval'),
      makePost('2026-04-23', '15:00', 'pending_approval'),
    ];
    const fill = fillFor(posts);
    expect(fill.filled).toBe(true);
    expect(fill.pendingApprovalTotal).toBe(2);
    expect(pickContinuousBranch(fill)).toBe('continue-pending');
  });

  it('mixed half-scheduled half-pending → continue (not filled)', () => {
    // 14 scheduled + 14 pending across 14 days (1 each per day).
    // scheduledCount per day = 1, target = 2 → never filled.
    // INCLUDE-TODAY (2026-05-22): horizon starts TODAY, not tomorrow.
    // Anchor on today (00:00) so today's posts at 14:00 / 20:00 (both
    // after the noon NOW) get counted instead of filtered as past.
    const tomorrow = new Date(NOW);
    tomorrow.setHours(0, 0, 0, 0);
    const posts: ScheduledPost[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(tomorrow);
      d.setDate(tomorrow.getDate() + i);
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      posts.push(makePost(ds, '14:00', 'scheduled'));
      posts.push(makePost(ds, '20:00', 'pending_approval'));
    }
    const fill = fillFor(posts);
    expect(fill.filled).toBe(false);
    expect(fill.scheduledTotal).toBe(14);
    expect(fill.pendingApprovalTotal).toBe(14);
    expect(pickContinuousBranch(fill)).toBe('continue-not-filled');
  });
});
