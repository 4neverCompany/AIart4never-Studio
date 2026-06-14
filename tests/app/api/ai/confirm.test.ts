/**
 * v1.2.3 — HIL endpoint unit tests.
 *
 * Tests the in-memory decision store and the auto-approve
 * rule. The HTTP round-trip is tested separately in
 * `lib/agent-loop/hil.test.ts` (with a stub fetch); the
 * endpoint tests here focus on the verdict logic.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  POST,
  GET,
  HIL_DEFAULT_AUTO_APPROVE_USD,
  readDecision,
  writeDecision,
  __clearDecisionsForTests,
  type HilConfirmRequest,
  type HilConfirmResponse,
} from '@/app/api/ai/confirm/route';
import { NextRequest } from 'next/server';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://test/api/ai/confirm', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeGet(key: string): NextRequest {
  return new NextRequest(`http://test/api/ai/confirm?key=${encodeURIComponent(key)}`);
}

const VALID_REQ: HilConfirmRequest = {
  runId: 'run_test_001',
  stepId: 'step_001',
  toolName: 'generate_image',
  estimatedCostUsd: 0.04,
  totalCostSoFarUsd: 0,
  budgetUsd: 0.5,
  prompt: 'A test prompt',
  model: 'higgsfield:seedance_2_0',
};

describe('POST /api/ai/confirm', () => {
  beforeEach(() => {
    // Wipe the in-memory store so each test computes its
    // own verdict from scratch (otherwise a previous
    // test's "approved" verdict for the same key would be
    // returned idempotently, masking real logic).
    __clearDecisionsForTests();
  });

  it('returns 400 on invalid JSON body', async () => {
    const res = await POST(
      new NextRequest('http://test/api/ai/confirm', {
        method: 'POST',
        body: 'not json',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 on missing fields', async () => {
    const res = await POST(makeRequest({ runId: 'x' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 on negative estimatedCostUsd', async () => {
    const res = await POST(
      makeRequest({ ...VALID_REQ, estimatedCostUsd: -0.01 }),
    );
    expect(res.status).toBe(400);
  });

  it('auto-approves a small call under the default threshold', async () => {
    const res = await POST(makeRequest(VALID_REQ));
    expect(res.status).toBe(200);
    const body = (await res.json()) as HilConfirmResponse;
    expect(body.status).toBe('approved');
    expect(body.autoApproved).toBe(true);
    expect(body.decidedAt).toBeGreaterThan(0);
  });

  it('denies a large call above the default threshold', async () => {
    const res = await POST(makeRequest({ ...VALID_REQ, estimatedCostUsd: 0.5 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as HilConfirmResponse;
    expect(body.status).toBe('denied');
    expect(body.reason).toContain('exceeds auto-approve threshold');
  });

  it('denies when projected total exceeds 95% of budget', async () => {
    const res = await POST(
      makeRequest({ ...VALID_REQ, totalCostSoFarUsd: 0.48, budgetUsd: 0.5 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as HilConfirmResponse;
    expect(body.status).toBe('denied');
    expect(body.reason).toContain('budget');
  });

  it('honours the request body autoApproveBelowUsd override', async () => {
    // Override the threshold to 1.0 USD AND set the
    // budget high enough that the budget check doesn't
    // also deny the call (the budget check would catch
    // 0.5 + 0 = 0.5 vs budget 0.5 * 0.95 = 0.475).
    const res = await POST(
      makeRequest({
        ...VALID_REQ,
        estimatedCostUsd: 0.5,
        autoApproveBelowUsd: 1.0,
        budgetUsd: 2.0,
      }),
    );
    const body = (await res.json()) as HilConfirmResponse;
    expect(body.status).toBe('approved');
  });

  it('is idempotent on the same (runId, stepId, tool, cost) tuple', async () => {
    const first = await POST(makeRequest(VALID_REQ));
    const second = await POST(makeRequest(VALID_REQ));
    const firstBody = (await first.json()) as HilConfirmResponse;
    const secondBody = (await second.json()) as HilConfirmResponse;
    expect(secondBody.decidedAt).toBe(firstBody.decidedAt);
  });
});

describe('GET /api/ai/confirm', () => {
  it('returns 400 without key', async () => {
    const res = await GET(new NextRequest('http://test/api/ai/confirm'));
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown key', async () => {
    const res = await GET(makeGet('never-recorded-key'));
    expect(res.status).toBe(404);
  });

  it('returns the recorded decision for a known key', async () => {
    writeDecision('recorded', { status: 'denied', reason: 'manual', decidedAt: 42 });
    const res = await GET(makeGet('recorded'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as HilConfirmResponse;
    expect(body.status).toBe('denied');
    expect(body.reason).toBe('manual');
    expect(body.decidedAt).toBe(42);
  });
});

describe('constants', () => {
  it('default auto-approve is 10 cents', () => {
    expect(HIL_DEFAULT_AUTO_APPROVE_USD).toBe(0.1);
  });
});
