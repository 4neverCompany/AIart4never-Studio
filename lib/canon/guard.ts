/**
 * Canon compliance guard (M1 / FR-4, FR-5 — "locks").
 *
 * The canon system block ASKS the model to honor each character's identity;
 * this guard CHECKS that a finished prompt/caption actually anchored to a
 * resolved Higgsfield Element, so a from-scratch (un-anchored) generation is
 * flagged before it reaches the approval UI. Heuristic + conservative.
 *
 * Story 2.8: the per-character LORE that the old cyberdeck / channel-tag rules
 * hardcoded now lives in the live Higgsfield Element `description` (resolved at
 * runtime), so those lore-specific rules are GONE — a guard cannot hardcode a
 * character's current look without re-introducing the very drift this story
 * removed. What remains is the ONE lore-agnostic, machine-checkable identity
 * guarantee: a recurring-character prompt must carry the resolved Element token.
 */

import type { CharacterId } from './types';

export type CanonSeverity = 'error' | 'warn';

export interface CanonViolation {
  /** Stable rule id for telemetry / UI. */
  rule: string;
  severity: CanonSeverity;
  detail: string;
}

export interface CanonCheck {
  /** No `error`-severity violations. `warn`s don't block. */
  ok: boolean;
  violations: CanonViolation[];
}

/** The STRUCTURAL identity anchor: a resolved Higgsfield Element token `<<<uuid>>>`. */
const ELEMENT_TOKEN_RE = /<<<[0-9a-f-]{8,}>>>/i;
/**
 * A weaker, PROSE-only identity signal. Satisfiable by boilerplate ("same man",
 * "reference"), so it is NOT an identity guarantee — advisory telemetry only.
 */
const WEAK_ANCHOR_RE = /--image|reference|locked ref|same man|same face|same bone structure|identity lock|keep the same/i;

/**
 * Check a generated prompt/caption against the character's structural canon.
 * `text` is the finished prompt (or caption) to validate.
 *
 * Two rules only (Story 2.8):
 *   - `missing-element-token` (ERROR) — a recurring-character prompt with no
 *     `<<<Element>>>` anchor. The one lore-agnostic identity guarantee; keeps
 *     `canon.ok` meaningfully failable.
 *   - `weak-identity-lock` (WARN) — no prose identity reinforcement. Advisory.
 */
export function checkCanonCompliance(characterId: CharacterId, text: string): CanonCheck {
  const violations: CanonViolation[] = [];

  if (!ELEMENT_TOKEN_RE.test(text)) {
    violations.push({
      rule: 'missing-element-token',
      severity: 'error',
      detail: `Generation prompt for "${characterId}" carries no <<<Element>>> anchor — resolve the character's current Higgsfield Element first (the edit-from-reference identity lock).`,
    });
  }

  if (!WEAK_ANCHOR_RE.test(text)) {
    violations.push({
      rule: 'weak-identity-lock',
      severity: 'warn',
      detail: 'No prose identity reinforcement detected (e.g. "same man/face", "reference", "locked ref"). Advisory only — the Element token is the real anchor.',
    });
  }

  return { ok: !violations.some((v) => v.severity === 'error'), violations };
}

/** One-line human summary of a check (for logs / the approval UI). */
export function formatCanonCheck(check: CanonCheck): string {
  if (check.violations.length === 0) return 'canon: ok';
  const errs = check.violations.filter((v) => v.severity === 'error').length;
  const warns = check.violations.filter((v) => v.severity === 'warn').length;
  const head = check.ok ? `canon: ok (${warns} warning${warns === 1 ? '' : 's'})` : `canon: ${errs} violation${errs === 1 ? '' : 's'}`;
  return `${head} — ${check.violations.map((v) => `[${v.severity}] ${v.rule}`).join(', ')}`;
}
