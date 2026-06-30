/**
 * 4NE-26 — Gate (chokepoint) tests.
 *
 * The gate is pure aside from the injected deps (askOperator / loadPreAuth /
 * now), so no network is needed — every branch is exercised via injected stubs,
 * using the dependency-injection test-seam the approval module is built around.
 *
 * Coverage:
 *   - pre-auth auto-approve → token, autoApproved+preAuthorized,
 *   - operator approve → token (not auto, not pre),
 *   - operator deny / timeout → NO token, and assertApproved throws,
 *   - askOperator throws → FAIL CLOSED (denied, 'approval channel error'),
 *   - no channel + no pre-auth → FAIL CLOSED,
 *   - loadPreAuth throws → falls through (does not auto-approve),
 *   - verifyToken accepts a matching request and rejects a tampered one,
 *   - assertApproved returns the token on approval.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  requestApproval,
  assertApproved,
  mintToken,
  verifyToken,
} from '@/lib/approval/gate';
import { ApprovalDeniedError } from '@/lib/approval/types';
import type { ApprovalRequest, PreAuthRule } from '@/lib/approval/types';

const fixedNow = () => 1_700_000_000_000;

function req(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    kind: 'publish',
    summary: 'Publish to instagram',
    target: 'instagram:c1',
    payloadPreview: { assetIds: ['a'], caption: 'cap' },
    ...over,
  };
}

describe('requestApproval — pre-auth path', () => {
  it('auto-approves via a matching enabled rule and mints a token', async () => {
    const rules: PreAuthRule[] = [{ kind: 'publish', enabled: true, targetAllow: ['instagram:c1'] }];
    const askOperator = vi.fn();
    const decision = await requestApproval(req(), {
      loadPreAuth: async () => rules,
      askOperator,
      now: fixedNow,
    });

    expect(decision.verdict).toBe('approved');
    expect(decision.autoApproved).toBe(true);
    expect(decision.preAuthorized).toBe(true);
    expect(decision.token).toBeDefined();
    expect(decision.token!.grantedAt).toBe(fixedNow());
    // Pre-auth short-circuits BEFORE the operator is ever asked.
    expect(askOperator).not.toHaveBeenCalled();
  });

  it('falls through to the operator when no rule matches', async () => {
    const askOperator = vi.fn(async () => ({ verdict: 'approved' as const }));
    const decision = await requestApproval(req(), {
      loadPreAuth: async () => [],
      askOperator,
      now: fixedNow,
    });
    expect(askOperator).toHaveBeenCalledTimes(1);
    expect(decision.verdict).toBe('approved');
    expect(decision.preAuthorized).toBe(false);
    expect(decision.autoApproved).toBe(false);
  });

  it('a loadPreAuth throw does NOT auto-approve (falls through to operator)', async () => {
    const askOperator = vi.fn(async () => ({ verdict: 'denied' as const, reason: 'no' }));
    const decision = await requestApproval(req(), {
      loadPreAuth: async () => {
        throw new Error('store down');
      },
      askOperator,
    });
    expect(askOperator).toHaveBeenCalledTimes(1);
    expect(decision.verdict).toBe('denied');
    expect(decision.token).toBeUndefined();
  });
});

describe('requestApproval — operator path', () => {
  it('operator approve → token, not auto, not pre', async () => {
    const decision = await requestApproval(req(), {
      askOperator: async () => ({ verdict: 'approved' }),
      now: fixedNow,
    });
    expect(decision.verdict).toBe('approved');
    expect(decision.autoApproved).toBe(false);
    expect(decision.preAuthorized).toBe(false);
    expect(decision.token).toBeDefined();
  });

  it('operator deny → NO token', async () => {
    const decision = await requestApproval(req(), {
      askOperator: async () => ({ verdict: 'denied', reason: 'operator said no' }),
    });
    expect(decision.verdict).toBe('denied');
    expect(decision.reason).toBe('operator said no');
    expect(decision.token).toBeUndefined();
  });

  it('operator timeout → NO token', async () => {
    const decision = await requestApproval(req(), {
      askOperator: async () => ({ verdict: 'timeout' }),
    });
    expect(decision.verdict).toBe('timeout');
    expect(decision.token).toBeUndefined();
  });

  it('askOperator THROW → FAIL CLOSED (denied, channel error, no token)', async () => {
    const decision = await requestApproval(req(), {
      askOperator: async () => {
        throw new Error('socket closed');
      },
    });
    expect(decision.verdict).toBe('denied');
    expect(decision.reason).toBe('approval channel error');
    expect(decision.token).toBeUndefined();
  });
});

describe('requestApproval — fail closed with no channel', () => {
  it('no pre-auth and no operator → denied, no token', async () => {
    const decision = await requestApproval(req(), {});
    expect(decision.verdict).toBe('denied');
    expect(decision.token).toBeUndefined();
  });

  it('pre-auth present but non-matching, and no operator → denied', async () => {
    const decision = await requestApproval(req(), {
      loadPreAuth: async () => [{ kind: 'spend', enabled: true, maxCostUsd: 1 }],
    });
    expect(decision.verdict).toBe('denied');
    expect(decision.token).toBeUndefined();
  });
});

describe('verifyToken', () => {
  it('accepts a token minted for the same request', () => {
    const token = mintToken(req(), fixedNow);
    expect(verifyToken(token, req())).toBe(true);
  });

  it('rejects undefined', () => {
    expect(verifyToken(undefined, req())).toBe(false);
  });

  it('rejects a token whose request was tampered (different target)', () => {
    const token = mintToken(req({ target: 'instagram:c1' }), fixedNow);
    expect(verifyToken(token, req({ target: 'pinterest:c2' }))).toBe(false);
  });

  it('rejects a token whose request was tampered (different payload)', () => {
    const token = mintToken(req({ payloadPreview: { assetIds: ['a'], caption: 'real' } }), fixedNow);
    expect(verifyToken(token, req({ payloadPreview: { assetIds: ['a'], caption: 'evil' } }))).toBe(
      false,
    );
  });

  it('rejects a token of a different kind', () => {
    const token = mintToken(req({ kind: 'publish' }), fixedNow);
    expect(verifyToken(token, req({ kind: 'irreversible' }))).toBe(false);
  });
});

describe('assertApproved', () => {
  it('returns the token on approval', async () => {
    const token = await assertApproved(req(), {
      askOperator: async () => ({ verdict: 'approved' }),
      now: fixedNow,
    });
    expect(token.kind).toBe('publish');
    expect(verifyToken(token, req())).toBe(true);
  });

  it('throws ApprovalDeniedError(denied) on a deny', async () => {
    await expect(
      assertApproved(req(), { askOperator: async () => ({ verdict: 'denied', reason: 'nope' }) }),
    ).rejects.toBeInstanceOf(ApprovalDeniedError);
  });

  it('throws ApprovalDeniedError with verdict "timeout" on a timeout', async () => {
    await expect(
      assertApproved(req(), { askOperator: async () => ({ verdict: 'timeout' }) }),
    ).rejects.toMatchObject({ verdict: 'timeout' });
  });

  it('throws (fail closed) when there is no channel at all', async () => {
    await expect(assertApproved(req(), {})).rejects.toBeInstanceOf(ApprovalDeniedError);
  });
});
