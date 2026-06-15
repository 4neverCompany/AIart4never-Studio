/**
 * Canon compliance guard (M1 / FR-4, FR-5 — "locks").
 *
 * The canon system block ASKS the model to honor each character's hard rules;
 * this guard CHECKS that a finished prompt/caption actually did, so a drift
 * (e.g. a cyberdeck rendered on a variant, or a missing identity anchor) is
 * caught before it reaches the approval gate. Heuristic + conservative: it
 * flags clear violations, not stylistic nuance.
 */

import { getCharacter } from './index';
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

const CYBERDECK_RE = /\bcyberdeck\b|forehead tech-core|nanotech tech-core|tech[- ]core/i;
const TAG_RE = /aiart4never/i;
const TAG_WORN_RE = /(tag|wears?|worn|collar|jacket|sleeve|chest|clothing|back-print|label)/i;
const ANCHOR_SIGNAL_RE = /<<<|--image|reference|locked ref|same man|same face|same bone structure|identity lock|keep the same/i;

/**
 * Check a generated prompt/caption against a character's hard canon rules.
 * `text` is the finished prompt (or caption) to validate.
 */
export function checkCanonCompliance(characterId: CharacterId, text: string): CanonCheck {
  const c = getCharacter(characterId);
  const violations: CanonViolation[] = [];

  if (!c.isPrime) {
    // PRIME-only traits must NOT appear on a variant.
    if (CYBERDECK_RE.test(text)) {
      violations.push({
        rule: 'no-cyberdeck-on-variant',
        severity: 'error',
        detail: `${c.name} is a variant and must NOT have the forehead cyberdeck (PRIME-only).`,
      });
    }
    if (TAG_RE.test(text) && TAG_WORN_RE.test(text)) {
      violations.push({
        rule: 'no-channel-tag-on-variant',
        severity: 'error',
        detail: `${c.name} (variant) must NOT wear the AIART4NEVER channel tag (PRIME-only); it is applied as a watermark at publish instead.`,
      });
    }
  } else {
    // PRIME musts — the model should include them; absence is a soft warning.
    if (!CYBERDECK_RE.test(text)) {
      violations.push({
        rule: 'prime-cyberdeck-missing',
        severity: 'warn',
        detail: 'Kael (PRIME) should wear his signature forehead cyberdeck — it is missing from the prompt.',
      });
    }
    if (!TAG_RE.test(text)) {
      violations.push({
        rule: 'prime-channel-tag-missing',
        severity: 'warn',
        detail: 'Kael (PRIME) should wear the AIART4NEVER channel tag somewhere legible — it is missing from the prompt.',
      });
    }
  }

  // Consistency mandate: a generation prompt should anchor to the locked
  // Element / reference rather than describing a from-scratch character.
  if (!ANCHOR_SIGNAL_RE.test(text)) {
    violations.push({
      rule: 'missing-identity-anchor',
      severity: 'warn',
      detail: 'No identity anchor detected (Element token, reference image, or explicit "same man/face" lock) — the edit-from-reference rule may be violated.',
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
