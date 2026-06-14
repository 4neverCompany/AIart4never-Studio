// V040-HOTFIX-003: ghost-memory utilities for the carousel approval card.

import { describe, it, expect } from 'vitest';
import {
  GHOST_TTL_MS,
  pruneExpiredGhosts,
  nextGhostExpiry,
  type CarouselGhost,
} from '@/lib/carousel-ghost';

const ghost = (state: 'approved' | 'rejected', expiresAt: number): CarouselGhost<{ id: string }> => ({
  state,
  img: { id: 'whatever' },
  expiresAt,
});

describe('GHOST_TTL_MS', () => {
  it('exposes the 6-second floor required by the approval-flicker fix', () => {
    expect(GHOST_TTL_MS).toBe(6000);
  });
});

describe('pruneExpiredGhosts', () => {
  it('drops entries whose expiresAt is in the past', () => {
    const now = 10_000;
    const input = {
      a: ghost('approved', 5_000),
      b: ghost('rejected', 15_000),
    };
    const out = pruneExpiredGhosts(input, now);
    expect(Object.keys(out)).toEqual(['b']);
  });

  it('drops entries whose expiresAt equals now (already expired)', () => {
    const out = pruneExpiredGhosts({ a: ghost('approved', 100) }, 100);
    expect(out).toEqual({});
  });

  it('keeps entries whose expiresAt is strictly in the future', () => {
    const input = { a: ghost('approved', 200), b: ghost('rejected', 300) };
    const out = pruneExpiredGhosts(input, 100);
    expect(Object.keys(out).sort()).toEqual(['a', 'b']);
  });

  it('returns the input reference unchanged when nothing expired (referential equality preserved)', () => {
    const input = { a: ghost('approved', 200) };
    const out = pruneExpiredGhosts(input, 100);
    expect(out).toBe(input);
  });

  it('handles an empty map cleanly (returns same reference)', () => {
    const input: Record<string, CarouselGhost<{ id: string }>> = {};
    expect(pruneExpiredGhosts(input, 100)).toBe(input);
  });
});

describe('nextGhostExpiry', () => {
  it('returns null for an empty map (no timer to schedule)', () => {
    expect(nextGhostExpiry({})).toBe(null);
  });

  it('returns the soonest expiresAt across all entries', () => {
    const input = {
      a: ghost('approved', 5_000),
      b: ghost('rejected', 1_000),
      c: ghost('approved', 3_000),
    };
    expect(nextGhostExpiry(input)).toBe(1_000);
  });

  it('returns the lone entry when the map has one ghost', () => {
    expect(nextGhostExpiry({ a: ghost('approved', 4_242) })).toBe(4_242);
  });
});
