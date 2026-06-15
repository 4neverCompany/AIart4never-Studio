/**
 * M2 autonomy loop — PURE scheduler tests.
 *
 * Drives the scheduler with explicit `Date` values (never the real clock) and
 * asserts the daily-cadence dedupe: ticks once at/after tickHour, never again
 * the same local day, never when disabled or cadence!=daily, and nextTickAt is
 * the right local hour today-or-tomorrow.
 */
import { describe, it, expect } from 'vitest';
import {
  shouldTick,
  nextTickAt,
  weekdayOf,
  localDayKey,
} from '@/lib/autonomy/scheduler';
import type { AutonomyConfig } from '@/lib/autonomy/types';

function cfg(over: Partial<AutonomyConfig> = {}): AutonomyConfig {
  return {
    enabled: true,
    cadence: 'daily',
    activeCharacterId: 'kael',
    dailyBudgetUsd: 0.5,
    tickHourLocal: 9,
    ...over,
  };
}

// Local-time constructor (year, monthIndex, day, hour) — deterministic per the
// runner's local TZ, which is exactly what the scheduler measures against.
const at = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo, d, h, mi, 0, 0);

describe('localDayKey + weekdayOf', () => {
  it('localDayKey collapses a timestamp to its local YYYY-MM-DD', () => {
    expect(localDayKey(at(2026, 5, 14, 9))).toBe('2026-06-14');
    expect(localDayKey(at(2026, 5, 14, 23))).toBe('2026-06-14');
    expect(localDayKey(at(2026, 0, 1, 0))).toBe('2026-01-01');
  });

  it('weekdayOf maps getDay() to the canon Weekday union', () => {
    // 2026-06-14 is a Sunday; 2026-06-15 is a Monday.
    expect(weekdayOf(at(2026, 5, 14, 12))).toBe('sun');
    expect(weekdayOf(at(2026, 5, 15, 12))).toBe('mon');
    expect(weekdayOf(at(2026, 5, 19, 12))).toBe('fri');
  });
});

describe('shouldTick', () => {
  it('ticks once at/after tickHour when never ticked before', () => {
    expect(shouldTick(at(2026, 5, 15, 9), null, cfg())).toBe(true);
    expect(shouldTick(at(2026, 5, 15, 14), null, cfg())).toBe(true);
  });

  it('does NOT tick before tickHour', () => {
    expect(shouldTick(at(2026, 5, 15, 8, 59), null, cfg())).toBe(false);
  });

  it('does NOT tick again the same local day', () => {
    const firstTick = at(2026, 5, 15, 9).getTime();
    // Later the same local day — already ticked.
    expect(shouldTick(at(2026, 5, 15, 22), firstTick, cfg())).toBe(false);
  });

  it('ticks again the NEXT local day once the hour is reached', () => {
    const firstTick = at(2026, 5, 15, 9).getTime();
    expect(shouldTick(at(2026, 5, 16, 9), firstTick, cfg())).toBe(true);
    // ...but not before the hour on that next day.
    expect(shouldTick(at(2026, 5, 16, 8), firstTick, cfg())).toBe(false);
  });

  it('never ticks when disabled', () => {
    expect(shouldTick(at(2026, 5, 15, 12), null, cfg({ enabled: false }))).toBe(false);
  });

  it('never ticks when cadence is not daily', () => {
    expect(shouldTick(at(2026, 5, 15, 12), null, cfg({ cadence: 'manual' }))).toBe(false);
  });
});

describe('nextTickAt', () => {
  it('is today at tickHour when the hour has not yet arrived', () => {
    const now = at(2026, 5, 15, 7);
    const next = new Date(nextTickAt(now, cfg()));
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(5);
    expect(next.getDate()).toBe(15);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  it('is tomorrow at tickHour once today’s window has opened', () => {
    const now = at(2026, 5, 15, 10);
    const next = new Date(nextTickAt(now, cfg()));
    expect(next.getDate()).toBe(16);
    expect(next.getHours()).toBe(9);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });
});
