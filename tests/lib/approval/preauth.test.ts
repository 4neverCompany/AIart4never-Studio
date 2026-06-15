/**
 * 4NE-26 — Pre-auth tests: the PURE evaluator + persisted CRUD.
 *
 * Persistence is mocked with an in-memory store (same pattern as
 * tests/lib/connectors/skills.test.ts) so CRUD exercises real read/modify/write
 * without idb/tauri. `evaluatePreAuth` is pure and tested directly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/persistence', () => ({
  get: vi.fn(),
  set: vi.fn(),
  __resetStoreForTests: vi.fn(),
}));

import {
  PREAUTH_KEY,
  listPreAuthRules,
  savePreAuthRule,
  removePreAuthRule,
  evaluatePreAuth,
} from '@/lib/approval/preauth';
import type { ApprovalRequest, PreAuthRule } from '@/lib/approval/types';
import * as persistenceModule from '@/lib/persistence';

const persistenceMock = {
  get: persistenceModule.get as ReturnType<typeof vi.fn>,
  set: persistenceModule.set as ReturnType<typeof vi.fn>,
};

let store: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  store = {};
  persistenceMock.get.mockImplementation(async (k: string) => store[k]);
  persistenceMock.set.mockImplementation(async (k: string, v: unknown) => {
    store[k] = v;
  });
});

function spend(cost: number): ApprovalRequest {
  return { kind: 'spend', summary: 's', estimatedCostUsd: cost };
}
function publishReq(target: string): ApprovalRequest {
  return { kind: 'publish', summary: 's', target };
}

describe('evaluatePreAuth — spend', () => {
  it('auto-approves when cost is at or under the ceiling', () => {
    const rules: PreAuthRule[] = [{ kind: 'spend', enabled: true, maxCostUsd: 5 }];
    expect(evaluatePreAuth(spend(4.99), rules)).toBe(true);
    expect(evaluatePreAuth(spend(5), rules)).toBe(true);
  });

  it('does NOT auto-approve when cost exceeds the ceiling', () => {
    const rules: PreAuthRule[] = [{ kind: 'spend', enabled: true, maxCostUsd: 5 }];
    expect(evaluatePreAuth(spend(5.01), rules)).toBe(false);
  });

  it('does NOT auto-approve a spend rule with no maxCostUsd', () => {
    const rules: PreAuthRule[] = [{ kind: 'spend', enabled: true }];
    expect(evaluatePreAuth(spend(0), rules)).toBe(false);
  });

  it('does NOT auto-approve when the request has no estimatedCostUsd', () => {
    const rules: PreAuthRule[] = [{ kind: 'spend', enabled: true, maxCostUsd: 5 }];
    expect(evaluatePreAuth({ kind: 'spend', summary: 's' }, rules)).toBe(false);
  });

  it('ignores a disabled rule', () => {
    const rules: PreAuthRule[] = [{ kind: 'spend', enabled: false, maxCostUsd: 100 }];
    expect(evaluatePreAuth(spend(1), rules)).toBe(false);
  });
});

describe('evaluatePreAuth — non-spend (target allow-list)', () => {
  it('auto-approves when target is in the allow-list', () => {
    const rules: PreAuthRule[] = [
      { kind: 'publish', enabled: true, targetAllow: ['instagram:a', 'pinterest:b'] },
    ];
    expect(evaluatePreAuth(publishReq('instagram:a'), rules)).toBe(true);
  });

  it('does NOT auto-approve a target outside the allow-list', () => {
    const rules: PreAuthRule[] = [{ kind: 'publish', enabled: true, targetAllow: ['instagram:a'] }];
    expect(evaluatePreAuth(publishReq('instagram:z'), rules)).toBe(false);
  });

  it('an undefined targetAllow means allow-any (operator explicit choice)', () => {
    const rules: PreAuthRule[] = [{ kind: 'publish', enabled: true }];
    expect(evaluatePreAuth(publishReq('anything'), rules)).toBe(true);
  });

  it('an EMPTY targetAllow means allow-any (operator explicit choice)', () => {
    const rules: PreAuthRule[] = [{ kind: 'publish', enabled: true, targetAllow: [] }];
    expect(evaluatePreAuth(publishReq('whatever'), rules)).toBe(true);
  });

  it('does not match a rule of a different kind', () => {
    const rules: PreAuthRule[] = [{ kind: 'connector-activate', enabled: true, targetAllow: [] }];
    expect(evaluatePreAuth(publishReq('x'), rules)).toBe(false);
  });
});

describe('preauth CRUD', () => {
  it('lists empty when nothing is stored', async () => {
    expect(await listPreAuthRules()).toEqual([]);
  });

  it('saves under the PREAUTH_KEY and reads back', async () => {
    await savePreAuthRule({ kind: 'spend', enabled: true, maxCostUsd: 2 });
    expect(store[PREAUTH_KEY]).toBeDefined();
    expect(await listPreAuthRules()).toEqual([{ kind: 'spend', enabled: true, maxCostUsd: 2 }]);
  });

  it('upserts in place on a matching kind (no duplicate)', async () => {
    await savePreAuthRule({ kind: 'spend', enabled: true, maxCostUsd: 2 });
    await savePreAuthRule({ kind: 'spend', enabled: false, maxCostUsd: 9 });
    const rules = await listPreAuthRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({ kind: 'spend', enabled: false, maxCostUsd: 9 });
  });

  it('appends a rule of a new kind', async () => {
    await savePreAuthRule({ kind: 'spend', enabled: true, maxCostUsd: 2 });
    await savePreAuthRule({ kind: 'publish', enabled: true, targetAllow: ['x'] });
    expect(await listPreAuthRules()).toHaveLength(2);
  });

  it('removes a rule by kind', async () => {
    await savePreAuthRule({ kind: 'spend', enabled: true, maxCostUsd: 2 });
    const after = await removePreAuthRule('spend');
    expect(after).toEqual([]);
    expect(await listPreAuthRules()).toEqual([]);
  });

  it('tolerates a corrupted (non-array) stored value', async () => {
    store[PREAUTH_KEY] = { not: 'an array' };
    expect(await listPreAuthRules()).toEqual([]);
  });
});
