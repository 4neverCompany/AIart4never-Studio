/**
 * Story 2.8 — `getElementRef` reads the per-turn RunContext memo (the live,
 * agent-resolved Higgsfield Element), keyed by character. This is the end-state
 * anchor source; the hardcoded-record fallback (coexistence) is removed in Task 8.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getElementRef } from '@/lib/canon';
import { __setCurrentRunContextForTests } from '@/lib/agent-loop/run-context';

afterEach(() => __setCurrentRunContextForTests(null));

describe('getElementRef — live RunContext memo', () => {
  it('returns the live resolved element token when the memo has one', () => {
    __setCurrentRunContextForTests({
      runId: 'r', stepCounter: 0, totalCostUsd: 0, budgetUsd: 1, characterId: 'kael',
      resolvedElements: new Map([['kael', { elementId: 'live-uuid-123', name: 'X' }]]),
    });
    expect(getElementRef('kael')).toBe('<<<live-uuid-123>>>');
  });

  it('resolves per character key (multi-character beat)', () => {
    __setCurrentRunContextForTests({
      runId: 'r', stepCounter: 0, totalCostUsd: 0, budgetUsd: 1, characterId: 'kael',
      resolvedElements: new Map([
        ['kael', { elementId: 'kael-uuid', name: 'K' }],
        ['kaelus-vorne', { elementId: 'kv-uuid', name: 'KV' }],
      ]),
    });
    expect(getElementRef('kael')).toBe('<<<kael-uuid>>>');
    expect(getElementRef('kaelus-vorne')).toBe('<<<kv-uuid>>>');
  });
});
