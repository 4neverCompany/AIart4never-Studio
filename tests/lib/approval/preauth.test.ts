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
  defaultSpendRule,
  loadSpendPreAuth,
  DEFAULT_SPEND_AUTO_APPROVE_USD,
  DEFAULT_SPEND_BUDGET_CAP,
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

  // Story 10.1 — budget-accumulation safety tier (preserves the old hil.ts 95% ceiling).
  it('refuses a within-ceiling spend that would breach the budget cap', () => {
    const rules: PreAuthRule[] = [
      { kind: 'spend', enabled: true, maxCostUsd: 5, budgetCapFraction: 0.95 },
    ];
    // cost 1 ≤ ceiling 5, but projected 1.5 + 1 = 2.5 > budget 2 * 0.95 = 1.9 → refused.
    const req: ApprovalRequest = {
      kind: 'spend',
      summary: 's',
      estimatedCostUsd: 1,
      totalCostSoFarUsd: 1.5,
      budgetUsd: 2,
    };
    expect(evaluatePreAuth(req, rules)).toBe(false);
  });

  it('auto-approves a within-ceiling spend that stays within the budget cap', () => {
    const rules: PreAuthRule[] = [
      { kind: 'spend', enabled: true, maxCostUsd: 5, budgetCapFraction: 0.95 },
    ];
    const req: ApprovalRequest = {
      kind: 'spend',
      summary: 's',
      estimatedCostUsd: 0.04,
      totalCostSoFarUsd: 0.1,
      budgetUsd: 1,
    };
    expect(evaluatePreAuth(req, rules)).toBe(true);
  });

  it('defaults the budget cap to 0.95 when the rule omits budgetCapFraction', () => {
    const rules: PreAuthRule[] = [{ kind: 'spend', enabled: true, maxCostUsd: 5 }];
    // projected 0.46 + 0.5 = 0.96 > 1 * 0.95 = 0.95 → refused.
    const over: ApprovalRequest = {
      kind: 'spend',
      summary: 's',
      estimatedCostUsd: 0.5,
      totalCostSoFarUsd: 0.46,
      budgetUsd: 1,
    };
    expect(evaluatePreAuth(over, rules)).toBe(false);
    // projected 0 + 0.5 = 0.5 ≤ 0.95 → approved.
    const under: ApprovalRequest = {
      kind: 'spend',
      summary: 's',
      estimatedCostUsd: 0.5,
      totalCostSoFarUsd: 0,
      budgetUsd: 1,
    };
    expect(evaluatePreAuth(under, rules)).toBe(true);
  });

  it('ignores the budget cap when the request carries no budgetUsd (ceiling-only)', () => {
    const rules: PreAuthRule[] = [{ kind: 'spend', enabled: true, maxCostUsd: 5 }];
    expect(evaluatePreAuth({ kind: 'spend', summary: 's', estimatedCostUsd: 4 }, rules)).toBe(true);
  });
});

describe('defaultSpendRule + loadSpendPreAuth (Story 10.1 — canonical-gate replacement for /api/ai/confirm)', () => {
  it('defaultSpendRule encodes the $0.10 ceiling + 0.95 budget cap', () => {
    expect(defaultSpendRule()).toEqual({
      kind: 'spend',
      enabled: true,
      maxCostUsd: DEFAULT_SPEND_AUTO_APPROVE_USD,
      budgetCapFraction: DEFAULT_SPEND_BUDGET_CAP,
    });
    expect(DEFAULT_SPEND_AUTO_APPROVE_USD).toBe(0.1);
    expect(DEFAULT_SPEND_BUDGET_CAP).toBe(0.95);
  });

  it('defaultSpendRule honours an override ceiling', () => {
    expect(defaultSpendRule(0.5).maxCostUsd).toBe(0.5);
  });

  it('loadSpendPreAuth returns the default rule when no override is given', async () => {
    const rules = await loadSpendPreAuth()();
    expect(rules).toEqual([defaultSpendRule()]);
  });

  it('loadSpendPreAuth raises the ceiling with a per-run override', async () => {
    const rules = await loadSpendPreAuth(0.5)();
    expect(rules[0].maxCostUsd).toBe(0.5);
  });

  it('a $0.04 image spend auto-approves under the default rule; a $0.30 video does not', () => {
    const rule = defaultSpendRule();
    const img: ApprovalRequest = {
      kind: 'spend',
      summary: 's',
      estimatedCostUsd: 0.04,
      totalCostSoFarUsd: 0,
      budgetUsd: 1,
    };
    const vid: ApprovalRequest = {
      kind: 'spend',
      summary: 's',
      estimatedCostUsd: 0.3,
      totalCostSoFarUsd: 0,
      budgetUsd: 1,
    };
    expect(evaluatePreAuth(img, [rule])).toBe(true);
    expect(evaluatePreAuth(vid, [rule])).toBe(false);
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
