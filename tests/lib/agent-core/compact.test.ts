/**
 * Story 10.5 — history compaction (sliding-window) unit tests.
 *
 * `compactMessages` is PURE, so every branch is exercised directly with a
 * deterministic 1-token-per-char estimator (`est`). Messages are built with a
 * loose cast so we can construct `role: 'tool'` with a plain-string content for
 * precise size control (the SDK's structured tool shape isn't what this pure
 * function inspects — it reads `.role` and `.content`).
 */
import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import { compactMessages } from '@/lib/agent-core/compact';

const est = (t: string): number => t.length; // 1 token/char — deterministic

function m(role: string, content: string): ModelMessage {
  return { role, content } as unknown as ModelMessage;
}

describe('compactMessages — Story 10.5 sliding-window', () => {
  it('AC2: returns the SAME array reference when the history already fits', () => {
    const msgs = [m('user', 'hi'), m('assistant', 'yo'), m('user', 'go')];
    const out = compactMessages(msgs, {
      contextWindowTokens: 1000,
      reserveTokens: 100,
      systemTokens: 10,
      estimateTokens: est,
    });
    expect(out).toBe(msgs); // identity — byte-for-byte parity, no allocation
  });

  it('AC2: a single message is returned unchanged even if it exceeds the budget', () => {
    const msgs = [m('user', 'x'.repeat(9999))];
    const out = compactMessages(msgs, {
      contextWindowTokens: 10,
      reserveTokens: 1,
      systemTokens: 1,
      estimateTokens: est,
    });
    expect(out).toBe(msgs);
  });

  it('AC1: over-budget → keeps the newest turns and always the last user message', () => {
    const msgs = [
      m('user', 'aaaa'),
      m('assistant', 'bbbb'),
      m('user', 'cccc'),
      m('assistant', 'dddd'),
      m('user', 'EEEE'),
    ];
    // available = 14 − 0 − 0 = 14. newest-first: E(4),D(4),C(4)=12; +B(4)=16>14 → stop.
    const out = compactMessages(msgs, {
      contextWindowTokens: 14,
      reserveTokens: 0,
      systemTokens: 0,
      estimateTokens: est,
    });
    expect(out).not.toBe(msgs);
    expect(out.map((x) => x.content)).toEqual(['cccc', 'dddd', 'EEEE']);
    expect(out[out.length - 1].content).toBe('EEEE'); // operator intent retained (AC1)
  });

  it('correctness: never begins the window with an orphaned tool result (snaps to a user boundary)', () => {
    const msgs = [
      m('user', 'u1'),
      m('assistant', 'a1'),
      m('tool', 'tt'), // a tool-result whose assistant tool-call would be trimmed
      m('user', 'u2'),
      m('assistant', 'a2'),
    ];
    // available = 6. newest-first: a2(2),u2(2),tt(2)=6; +a1 → 8>6 → stop. Naive window
    // = [tool, user, assistant]; snap forward past the leading tool → [user, assistant].
    const out = compactMessages(msgs, {
      contextWindowTokens: 6,
      reserveTokens: 0,
      systemTokens: 0,
      estimateTokens: est,
    });
    expect(out.map((x) => x.role)).toEqual(['user', 'assistant']);
    expect(out[0].content).toBe('u2');
  });

  it('edge: the last user message alone exceeds the budget → keeps just it', () => {
    const msgs = [m('user', 'short'), m('assistant', 'x'.repeat(100)), m('user', 'y'.repeat(100))];
    const out = compactMessages(msgs, {
      contextWindowTokens: 10,
      reserveTokens: 0,
      systemTokens: 0,
      estimateTokens: est,
    });
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    expect(out[0].content).toBe('y'.repeat(100));
  });

  it('edge: no user survives the raw window → falls back to the last user message', () => {
    // History ends on a huge tool result; the window would be tool-only.
    const msgs = [m('user', 'U'), m('assistant', 'x'.repeat(100)), m('tool', 'y'.repeat(100))];
    const out = compactMessages(msgs, {
      contextWindowTokens: 10,
      reserveTokens: 0,
      systemTokens: 0,
      estimateTokens: est,
    });
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    expect(out[0].content).toBe('U');
  });

  it('uses the chars/4 default estimator when none is injected', () => {
    // 4000 chars ≈ 1000 tokens each; window 2000, reserve 100, system 100 →
    // available 1800 → only the newest ~1 message fits.
    const big = 'z'.repeat(4000);
    const msgs = [m('user', big), m('assistant', big), m('user', 'LAST' + big)];
    const out = compactMessages(msgs, {
      contextWindowTokens: 2000,
      reserveTokens: 100,
      systemTokens: 100,
    });
    expect(out.length).toBeLessThan(msgs.length);
    expect(out[out.length - 1].content).toBe('LAST' + big);
  });

  it('provider-validity: a fitting but tool-LEADING history is cleaned (never starts with a tool)', () => {
    const msgs = [m('tool', 'orphan'), m('user', 'u'), m('assistant', 'a')];
    const out = compactMessages(msgs, {
      contextWindowTokens: 1000,
      reserveTokens: 100,
      systemTokens: 10,
      estimateTokens: est,
    });
    expect(out.map((x) => x.role)).toEqual(['user', 'assistant']); // leading orphan tool dropped
  });

  it('provider-validity: a lone tool message never leaks through as an orphan', () => {
    const out = compactMessages([m('tool', 'x'.repeat(50))], {
      contextWindowTokens: 10,
      reserveTokens: 1,
      systemTokens: 1,
      estimateTokens: est,
    });
    expect(out.every((x) => x.role !== 'tool')).toBe(true);
  });

  it('empty history is returned as-is (the caller owns the empty guard)', () => {
    const empty: ModelMessage[] = [];
    expect(
      compactMessages(empty, {
        contextWindowTokens: 100,
        reserveTokens: 10,
        systemTokens: 1,
        estimateTokens: est,
      }),
    ).toBe(empty);
  });
});
