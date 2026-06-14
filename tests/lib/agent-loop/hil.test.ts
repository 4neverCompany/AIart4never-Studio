/**
 * v1.2.3 — HIL guard unit tests.
 *
 * Tests the `requireApproval` client with a stubbed fetch
 * so we don't hit the real /api/ai/confirm route. The
 * endpoint itself has its own test file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  requireApproval,
  HilDeniedError,
  __setHilFetchForTests,
  type HilGuardInput,
} from '@/lib/agent-loop/hil';
import {
  enterRunContext,
  exitRunContext,
  __setCurrentRunContextForTests,
} from '@/lib/agent-loop/run-context';

const VALID_INPUT: HilGuardInput = {
  runId: 'run_test_001',
  stepId: 'step_001',
  toolName: 'generate_image',
  estimatedCostUsd: 0.04,
  totalCostSoFarUsd: 0.10,
  budgetUsd: 0.5,
  prompt: 'A test prompt',
  model: 'higgsfield:seedance_2_0',
};

function makeFetchReturning(json: unknown, status = 200): (input: string, init?: unknown) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}> {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(json),
  });
}

describe('requireApproval', () => {
  beforeEach(() => {
    __setHilFetchForTests(null);
    __setCurrentRunContextForTests({
      runId: 'run_test_001',
      stepCounter: 0,
      totalCostUsd: 0.1,
      budgetUsd: 0.5,
    });
  });

  afterEach(() => {
    __setHilFetchForTests(null);
    __setCurrentRunContextForTests(null);
  });

  it('returns approved when endpoint says so', async () => {
    __setHilFetchForTests(
      makeFetchReturning({ status: 'approved', autoApproved: true, decidedAt: 1 }) as never,
    );
    const r = await requireApproval(VALID_INPUT);
    expect(r.status).toBe('approved');
    expect(r.autoApproved).toBe(true);
  });

  it('throws HilDeniedError when endpoint says denied', async () => {
    __setHilFetchForTests(
      makeFetchReturning({ status: 'denied', reason: 'too expensive', decidedAt: 1 }) as never,
    );
    await expect(requireApproval(VALID_INPUT)).rejects.toBeInstanceOf(HilDeniedError);
  });

  it('throws HilDeniedError on HTTP 5xx (fail-closed)', async () => {
    __setHilFetchForTests(
      makeFetchReturning({ error: 'service down' }, 503) as never,
    );
    await expect(requireApproval(VALID_INPUT)).rejects.toBeInstanceOf(HilDeniedError);
  });

  it('skips the HTTP call when _skipHilForTest is true', async () => {
    const fetchSpy = vi.fn();
    __setHilFetchForTests(fetchSpy as never);
    const r = await requireApproval({ ...VALID_INPUT, _skipHilForTest: true });
    expect(r.status).toBe('approved');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads run context if set and forwards totalCostSoFarUsd', async () => {
    let capturedBody: string | undefined;
    const stub = vi.fn(async (_url: string, init?: { body?: string }) => {
      capturedBody = init?.body;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ status: 'approved', autoApproved: true, decidedAt: 1 }),
      };
    });
    __setHilFetchForTests(stub as never);
    await requireApproval(VALID_INPUT);
    expect(capturedBody).toBeDefined();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.totalCostSoFarUsd).toBe(0.1); // From the run context
    expect(parsed.budgetUsd).toBe(0.5);
  });
});

describe('HilDeniedError', () => {
  it('has the correct name and fields', () => {
    const e = new HilDeniedError('denied', 'too expensive');
    expect(e.name).toBe('HilDeniedError');
    expect(e.status).toBe('denied');
    expect(e.reason).toBe('too expensive');
    expect(e.message).toBe('HIL denied: too expensive');
  });
});

describe('run-context wiring', () => {
  it('enterRunContext + exitRunContext roundtrip', () => {
    enterRunContext({
      runId: 'run_x',
      stepCounter: 5,
      totalCostUsd: 0.2,
      budgetUsd: 0.5,
    });
    expect(__setCurrentRunContextForTests.toString()).toContain('__setCurrentRunContextForTests');
    exitRunContext();
  });
});
