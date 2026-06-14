// V081-TEST-GAPS: pin the CountdownBadge helpers (V080-DES-002).
//
// QA flagged the time-dependent helpers as missing unit coverage in
// V080-QA-REVIEW.md (gap #1). Both `toTimestamp` and `formatCountdown`
// are pure — toTimestamp parses two strings into a local-time epoch,
// formatCountdown buckets a delta into label + tone. They drive the
// scheduled-card pill so a regression silently miscolors urgency or
// shows wrong "in 2h" text on cards the user is staring at.

import { describe, it, expect } from 'vitest';
import { toTimestamp, formatCountdown } from '@/components/postready/CountdownBadge';

describe('toTimestamp', () => {
  it('parses YYYY-MM-DD + HH:MM into a local-time epoch', () => {
    // Local time so the epoch matches the user's wall clock — not UTC.
    const ts = toTimestamp('2026-04-23', '09:30');
    expect(ts).not.toBeNull();
    const d = new Date(ts!);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(3); // 0-indexed
    expect(d.getDate()).toBe(23);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(30);
  });

  it('returns null when time has non-numeric parts', () => {
    expect(toTimestamp('2026-04-23', 'AB:CD')).toBeNull();
    expect(toTimestamp('2026-04-23', '')).toBeNull();
  });

  it('returns null when date is malformed (missing parts)', () => {
    expect(toTimestamp('2026-04', '09:00')).toBeNull();
    expect(toTimestamp('', '09:00')).toBeNull();
    expect(toTimestamp('not-a-date', '09:00')).toBeNull();
  });

  it('returns null when any date part parses to 0 (defensive — no year-0 / month-0)', () => {
    expect(toTimestamp('0000-04-23', '09:00')).toBeNull();
    expect(toTimestamp('2026-00-23', '09:00')).toBeNull();
    expect(toTimestamp('2026-04-00', '09:00')).toBeNull();
  });
});

describe('formatCountdown', () => {
  // ms helpers (kept inline for readability)
  const min = (n: number) => n * 60_000;
  const hr = (n: number) => n * 60 * 60_000;
  const day = (n: number) => n * 24 * 60 * 60_000;

  // ── future deltas ────────────────────────────────────────────────
  it('labels a 2+ day future as "in Xd Yh" with tone=active', () => {
    expect(formatCountdown(day(3) + hr(4))).toEqual({ label: 'in 3d 4h', tone: 'active' });
  });

  it('labels exactly 1 day future as "in 1d Xh" with tone=active', () => {
    expect(formatCountdown(day(1) + hr(2))).toEqual({ label: 'in 1d 2h', tone: 'active' });
  });

  it('labels >=1h future as "in Xh Ym" with tone=active', () => {
    expect(formatCountdown(hr(2) + min(15))).toEqual({ label: 'in 2h 15m', tone: 'active' });
  });

  it('labels exactly 1h boundary as tone=active (≥1h is not "soon")', () => {
    expect(formatCountdown(hr(1))).toEqual({ label: 'in 1h 0m', tone: 'active' });
  });

  it('labels <1h future as "in Xm" with tone=soon (amber)', () => {
    expect(formatCountdown(min(45))).toEqual({ label: 'in 45m', tone: 'soon' });
    expect(formatCountdown(min(1))).toEqual({ label: 'in 1m', tone: 'soon' });
  });

  it('labels <1m future as "in now" with tone=soon (about-to-fire)', () => {
    expect(formatCountdown(30_000)).toEqual({ label: 'in now', tone: 'soon' });
    expect(formatCountdown(0)).toEqual({ label: 'in now', tone: 'soon' });
  });

  // ── past deltas (overdue) ────────────────────────────────────────
  it('labels overdue minutes as "overdue by Xm" with tone=overdue (red)', () => {
    expect(formatCountdown(-min(15))).toEqual({ label: 'overdue by 15m', tone: 'overdue' });
  });

  it('labels overdue hours as "overdue by Xh Ym" with tone=overdue', () => {
    expect(formatCountdown(-(hr(3) + min(20)))).toEqual({
      label: 'overdue by 3h 20m', tone: 'overdue',
    });
  });

  it('labels overdue 1 day as "overdue by 1d Xh" with tone=overdue', () => {
    expect(formatCountdown(-(day(1) + hr(5)))).toEqual({
      label: 'overdue by 1d 5h', tone: 'overdue',
    });
  });

  it('labels overdue 2+ days as "overdue by Xd Yh" with tone=overdue', () => {
    expect(formatCountdown(-(day(4) + hr(2)))).toEqual({
      label: 'overdue by 4d 2h', tone: 'overdue',
    });
  });

  it('labels sub-minute past as "overdue by now" with tone=overdue', () => {
    expect(formatCountdown(-1)).toEqual({ label: 'overdue by now', tone: 'overdue' });
  });
});
