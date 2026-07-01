/**
 * Story 4-7 (OAQ-10) — MVP standing pre-authorisation SCOPE (ratified + pinned).
 *
 * DECISION (operator-ratified 2026-07-01): the MVP ships EXACTLY ONE standing
 * pre-authorisation — the built-in `spend` rule — which auto-approves ONLY small
 * spends (<= $0.10) that also stay within 95% of the run budget. Nothing else is
 * standing-approved: publish, connector-activation, and every other irreversible
 * action is ALWAYS human-gated (no default rule ships for them). Operators may
 * later persist their own rules (the CRUD in preauth.ts exists), but none ships
 * by default, so a blanket / broadened auto-approve can never arise silently.
 *
 * This test PINS that scope: a future change that raises the ceiling, ships a
 * default publish/connector pre-auth, or otherwise widens what the agent may do
 * without the human trips CI here rather than quietly expanding the trust surface.
 * (The evaluator mechanics + CRUD are covered by preauth.test.ts; this file is
 * about the shipped POLICY, not the mechanism.)
 */
import { describe, it, expect } from 'vitest';
import {
  loadSpendPreAuth,
  evaluatePreAuth,
  DEFAULT_SPEND_AUTO_APPROVE_USD,
  DEFAULT_SPEND_BUDGET_CAP,
} from '@/lib/approval/preauth';
import type { ApprovalRequest } from '@/lib/approval/types';

const spend = (estimatedCostUsd: number, budgetUsd = 1, totalCostSoFarUsd = 0): ApprovalRequest => ({
  kind: 'spend',
  summary: 's',
  estimatedCostUsd,
  totalCostSoFarUsd,
  budgetUsd,
});

describe('Story 4-7 — MVP standing pre-auth scope (ratified + pinned)', () => {
  it('the shipped spend ceiling + budget cap are exactly $0.10 and 0.95', () => {
    expect(DEFAULT_SPEND_AUTO_APPROVE_USD).toBe(0.1);
    expect(DEFAULT_SPEND_BUDGET_CAP).toBe(0.95);
  });

  it('the generation spend gate ships EXACTLY ONE standing rule, and it is spend-only', async () => {
    const rules = await loadSpendPreAuth()();
    expect(rules).toHaveLength(1);
    expect(rules[0].kind).toBe('spend');
    expect(rules[0].enabled).toBe(true);
    // The MVP scope: no standing rule for ANY non-spend (irreversible) kind ships.
    expect(rules.some((r) => r.kind !== 'spend')).toBe(false);
  });

  it('under the shipped defaults, ONLY a small in-budget spend auto-approves', async () => {
    const rules = await loadSpendPreAuth()();
    // The one thing the MVP auto-approves: a small spend within the budget cap.
    expect(evaluatePreAuth(spend(0.04), rules)).toBe(true);
    // Above the ceiling → human-gated.
    expect(evaluatePreAuth(spend(0.5), rules)).toBe(false);
    // Every irreversible / publish / connector-activate action → ALWAYS human-gated.
    expect(evaluatePreAuth({ kind: 'publish', summary: 's', target: 'instagram:x' }, rules)).toBe(false);
    expect(evaluatePreAuth({ kind: 'connector-activate', summary: 's', target: 'hf' }, rules)).toBe(false);
    expect(evaluatePreAuth({ kind: 'irreversible', summary: 's', target: 'x' }, rules)).toBe(false);
  });

  it('the per-run override can only RAISE the spend ceiling — it never adds a non-spend rule', async () => {
    const rules = await loadSpendPreAuth(10)();
    expect(rules).toHaveLength(1);
    expect(rules[0].kind).toBe('spend');
    expect(rules[0].maxCostUsd).toBe(10);
    // Even with a raised spend ceiling, publish/irreversible stay human-gated.
    expect(evaluatePreAuth({ kind: 'publish', summary: 's', target: 'x' }, rules)).toBe(false);
  });
});
