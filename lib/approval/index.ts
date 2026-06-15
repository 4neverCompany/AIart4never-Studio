/**
 * 4NE-26 (FR-10 / AD-4) — Unified approval chokepoint: public surface.
 *
 * THE one safety-critical invariant: every irreversible action obtains a token
 * here via {@link assertApproved} (or {@link requestApproval}) and the side-
 * effecting layer VERIFIES that token against the exact request it is about to
 * perform via {@link verifyToken} before doing anything one-way. No code path
 * may bypass the gate — a missing/mismatched token is fail-closed.
 *
 * Import from `@/lib/approval` rather than reaching into the individual files.
 */

export {
  ApprovalDeniedError,
} from './types';
export type {
  ApprovalKind,
  ApprovalRequest,
  ApprovalVerdict,
  ApprovalToken,
  ApprovalDecision,
  PreAuthRule,
} from './types';

export { stableHash, canonicalize, fnv1a32 } from './hash';

export {
  PREAUTH_KEY,
  listPreAuthRules,
  savePreAuthRule,
  removePreAuthRule,
  evaluatePreAuth,
} from './preauth';

export {
  requestApproval,
  assertApproved,
  mintToken,
  verifyToken,
} from './gate';
export type { ApprovalDeps } from './gate';
