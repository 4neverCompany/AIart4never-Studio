import { describe, it, expect } from 'vitest';
import { postDueState } from '@/lib/autopost-due';

const NOW = new Date('2026-05-20T08:00:00');

describe('postDueState — happy paths', () => {
  it('future-dated post is "future"', () => {
    expect(postDueState({ date: '2026-05-25', time: '14:30' }, NOW)).toBe('future');
  });

  it('same-day later-hour post is "future"', () => {
    expect(postDueState({ date: '2026-05-20', time: '15:00' }, NOW)).toBe('future');
  });

  it('past-dated post is "due"', () => {
    expect(postDueState({ date: '2026-05-19', time: '10:00' }, NOW)).toBe('due');
  });

  it('post scheduled exactly at "now" is "due" (>= boundary)', () => {
    expect(postDueState({ date: '2026-05-20', time: '08:00' }, NOW)).toBe('due');
  });
});

describe('postDueState — Invalid Date guard (AUTOPOST-INVALID-DATE-FIX)', () => {
  // The pre-fix predicate (`if (now < postDate) continue;`) let every
  // one of these slip through and fire unconditionally because NaN
  // comparisons evaluate to false. The 'invalid' branch is the fix.

  it('empty time string is "invalid"', () => {
    expect(postDueState({ date: '2026-05-25', time: '' }, NOW)).toBe('invalid');
  });

  it('12-hour PM time is "invalid"', () => {
    expect(postDueState({ date: '2026-05-25', time: '2:30 PM' }, NOW)).toBe('invalid');
  });

  it('slashed date format is "invalid"', () => {
    expect(postDueState({ date: '05/25/2026', time: '14:30' }, NOW)).toBe('invalid');
  });

  it('time accidentally prefixed with T is "invalid"', () => {
    expect(postDueState({ date: '2026-05-25', time: 'T14:30' }, NOW)).toBe('invalid');
  });

  it('empty date string is "invalid"', () => {
    expect(postDueState({ date: '', time: '14:30' }, NOW)).toBe('invalid');
  });

  it('garbage in both fields is "invalid"', () => {
    expect(postDueState({ date: 'not-a-date', time: 'not-a-time' }, NOW)).toBe('invalid');
  });
});
