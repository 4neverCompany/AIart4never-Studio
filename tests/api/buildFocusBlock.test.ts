// V081-TEST-GAPS: pin the buildFocusBlock clause format (V080-DES-003).
//
// QA flagged this in V080-QA-REVIEW.md (gap #2). The function is pure
// and trivially testable, but the AI side may rely on the *exact*
// "Focus areas:" phrasing for instruction-following — locking the
// clause format prevents a future "tidy-up" rewrite from quietly
// breaking generation quality.

import { describe, it, expect } from 'vitest';
// M3.3-P3 commit c: import the helper from its new home in
// lib/ai-prompt-helpers.ts (the re-export shim on the pi route is
// gone with the pi route).
import { buildFocusBlock } from '@/lib/ai-prompt-helpers';

describe('buildFocusBlock', () => {
  it('returns an empty string when both arrays are empty (safe no-op)', () => {
    // Caller's `.filter(Boolean)` drops the result cleanly.
    expect(buildFocusBlock([], [])).toBe('');
  });

  it('emits the niches-only clause when only niches are provided', () => {
    expect(buildFocusBlock(['cyberpunk', 'mecha'], [])).toBe(
      'Focus areas: The user creates content in: cyberpunk, mecha. Every output should visibly reflect these areas.',
    );
  });

  it('emits the genres-only clause when only genres are provided', () => {
    expect(buildFocusBlock([], ['noir', 'sci-fi'])).toBe(
      'Focus areas: Favor themes and styles like: noir, sci-fi. Every output should visibly reflect these areas.',
    );
  });

  it('emits both clauses joined by spaces when both arrays are populated', () => {
    expect(buildFocusBlock(['anime', 'fantasy'], ['dark fantasy', 'cosmic horror'])).toBe(
      'Focus areas: The user creates content in: anime, fantasy. Favor themes and styles like: dark fantasy, cosmic horror. Every output should visibly reflect these areas.',
    );
  });

  it('handles a single-item array on each side without trailing-comma artifacts', () => {
    expect(buildFocusBlock(['solo'], ['only'])).toBe(
      'Focus areas: The user creates content in: solo. Favor themes and styles like: only. Every output should visibly reflect these areas.',
    );
  });

  it('preserves the literal "Focus areas:" prefix the AI uses for instruction-following', () => {
    const out = buildFocusBlock(['x'], ['y']);
    expect(out.startsWith('Focus areas: ')).toBe(true);
  });

  it('preserves the literal "Every output should visibly reflect these areas." closer', () => {
    const out = buildFocusBlock(['x'], ['y']);
    expect(out.endsWith('Every output should visibly reflect these areas.')).toBe(true);
  });
});
