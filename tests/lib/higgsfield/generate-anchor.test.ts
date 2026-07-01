/**
 * Story 2.8 — submitHiggsfieldGeneration canon anchoring (spend fail-safe).
 *
 * Asserts the two governance behaviors of Step 2:
 *  - an UNRESOLVED character REFUSES (throws UnresolvedElementError) and never
 *    reaches the Higgsfield submit (no spend);
 *  - a RESOLVED character prepends the server-resolved memo token and STRIPS any
 *    <<<...>>> the model smuggled into its prompt (the id is never model-supplied).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const callSpy = vi.fn();
const closeSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/mcp', () => ({
  connectMcp: vi.fn(async () => ({ client: {}, close: closeSpy })),
  callMcpTool: (...a: unknown[]) => callSpy(...a),
}));

import { submitHiggsfieldGeneration, UnresolvedElementError } from '@/lib/higgsfield/generate';
import { __setCurrentRunContextForTests } from '@/lib/agent-loop/run-context';
import type { McpServerConfig } from '@/lib/mcp';

const CONNECTOR: McpServerConfig = {
  id: 'hf-1', name: 'Higgsfield', transport: 'http',
  url: 'https://hf.example/mcp', headers: {}, enabled: true, trusted: true, addedAt: 0,
};

beforeEach(() => { callSpy.mockReset(); closeSpy.mockClear(); __setCurrentRunContextForTests(null); });
afterEach(() => { __setCurrentRunContextForTests(null); });

describe('submitHiggsfieldGeneration — Story 2.8 anchor fail-safe', () => {
  it('REFUSES (UnresolvedElementError) and never submits when no Element is resolved', async () => {
    // kaelus-alt has no live memo and no hardcoded Element id → unresolved.
    __setCurrentRunContextForTests({
      runId: 'r', stepCounter: 0, totalCostUsd: 0, budgetUsd: 1, characterId: 'kaelus-alt',
    });
    await expect(
      submitHiggsfieldGeneration({
        connector: CONNECTOR, characterId: 'kaelus-alt', prompt: 'a beat', aspectRatio: '1:1', enhance: false,
      }),
    ).rejects.toBeInstanceOf(UnresolvedElementError);
    // Fail-safe proof: the Higgsfield submit never fired → no credit spent.
    expect(callSpy).not.toHaveBeenCalled();
  });

  it('prepends the resolved memo token and STRIPS a model-smuggled token', async () => {
    callSpy.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ results: [{ id: 'job-1', status: 'pending' }] }) }],
    });
    __setCurrentRunContextForTests({
      runId: 'r', stepCounter: 0, totalCostUsd: 0, budgetUsd: 1, characterId: 'kael',
      resolvedElements: new Map([['kael', { elementId: 'MEMO-1111-2222', name: 'K' }]]),
    });
    const res = await submitHiggsfieldGeneration({
      connector: CONNECTOR, characterId: 'kael',
      // Includes BOTH a clean smuggled token and a MALFORMED one (inner `>`),
      // to prove the hardened non-greedy strip removes both.
      prompt: 'a rooftop <<<SMUGGLED-9999>>> and <<<x>y>>> at night', aspectRatio: '1:1', enhance: false,
    });
    expect(res.jobId).toBe('job-1');
    expect(res.anchored).toBe(true);
    expect(callSpy).toHaveBeenCalledTimes(1);
    const args = callSpy.mock.calls[0][2] as { params: { prompt: string } };
    // The server-resolved anchor is present; both smuggled tokens are gone.
    expect(args.params.prompt).toContain('<<<MEMO-1111-2222>>>');
    expect(args.params.prompt).not.toContain('SMUGGLED');
    expect(args.params.prompt).not.toContain('9999');
    expect(args.params.prompt).not.toContain('x>y');
  });
});
