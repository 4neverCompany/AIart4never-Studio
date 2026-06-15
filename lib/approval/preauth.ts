/**
 * 4NE-26 — Pre-authorisation rules (persisted) + the PURE evaluator.
 *
 * A {@link PreAuthRule} is an operator-defined standing approval: it lets the
 * gate auto-approve a kind of request without an interactive prompt. Storage
 * mirrors the Skills layer (`lib/connectors/skills.ts`) and the MCP registry —
 * a single key holding the whole `PreAuthRule[]`, read/modified/written through
 * `@/lib/persistence`. The CRUD is thin; the decision logic
 * ({@link evaluatePreAuth}) is PURE and unit-tested without touching storage.
 */

import { get, set } from '@/lib/persistence';
import type { ApprovalRequest, PreAuthRule } from './types';

/** Storage key holding the full `PreAuthRule[]`. */
export const PREAUTH_KEY = 'aiart4never_preauth';

// ---------------------------------------------------------------------------
// Internal storage helpers
// ---------------------------------------------------------------------------

/** Read the raw array, tolerating a missing / corrupted value. */
async function readAll(): Promise<PreAuthRule[]> {
  const raw = await get<PreAuthRule[]>(PREAUTH_KEY);
  return Array.isArray(raw) ? raw : [];
}

async function writeAll(rules: PreAuthRule[]): Promise<void> {
  await set(PREAUTH_KEY, rules);
}

// ---------------------------------------------------------------------------
// CRUD surface
// ---------------------------------------------------------------------------

/** All persisted pre-auth rules, in stored order. */
export async function listPreAuthRules(): Promise<PreAuthRule[]> {
  return readAll();
}

/**
 * Upsert a rule. At most ONE rule per `kind` is meaningful — the evaluator only
 * needs one matching rule — so this matches on `kind`: replaces in place if a
 * rule for that kind exists, otherwise appends.
 */
export async function savePreAuthRule(rule: PreAuthRule): Promise<PreAuthRule[]> {
  const rules = await readAll();
  const idx = rules.findIndex((r) => r.kind === rule.kind);
  if (idx >= 0) {
    rules[idx] = rule;
  } else {
    rules.push(rule);
  }
  await writeAll(rules);
  return rules;
}

/** Remove the rule for a kind. No-op if none exists. */
export async function removePreAuthRule(kind: PreAuthRule['kind']): Promise<PreAuthRule[]> {
  const rules = await readAll();
  const next = rules.filter((r) => r.kind !== kind);
  await writeAll(next);
  return next;
}

// ---------------------------------------------------------------------------
// PURE evaluator (no storage) — unit-tested directly
// ---------------------------------------------------------------------------

/**
 * Decide whether the given request is standing-approved by ANY of `rules`.
 * PURE: no storage, no clock, no randomness.
 *
 * A rule auto-approves iff it MATCHES the request's `kind`, is `enabled`, and:
 *  - for `spend`: the rule has a numeric `maxCostUsd` AND
 *    `req.estimatedCostUsd <= maxCostUsd`. A spend rule with no `maxCostUsd`
 *    never auto-approves (a blanket "any cost" spend rule would defeat the
 *    purpose of the cost ceiling), and a request with no `estimatedCostUsd`
 *    can't be bounded, so it isn't auto-approved either.
 *  - for the other kinds (`publish`, `connector-activate`, `irreversible`):
 *    `req.target` is in `rule.targetAllow`. NOTE: an undefined OR empty
 *    `targetAllow` on a non-spend rule means "allow ANY target for this kind".
 *    That is the operator's EXPLICIT choice — to enable such a rule, the
 *    operator must save a rule with `enabled:true` and no/empty `targetAllow`,
 *    so a blanket auto-approve never arises by accident.
 *
 * Returns `true` as soon as one rule matches.
 */
export function evaluatePreAuth(req: ApprovalRequest, rules: PreAuthRule[]): boolean {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.kind !== req.kind) continue;

    if (req.kind === 'spend') {
      if (typeof rule.maxCostUsd !== 'number') continue;
      if (typeof req.estimatedCostUsd !== 'number') continue;
      if (req.estimatedCostUsd <= rule.maxCostUsd) return true;
      continue;
    }

    // Non-spend: target allow-list. Undefined/empty => allow-any (operator's
    // explicit choice — they enabled a rule with no target restriction).
    const allow = rule.targetAllow;
    if (allow === undefined || allow.length === 0) return true;
    if (req.target !== undefined && allow.includes(req.target)) return true;
  }
  return false;
}
