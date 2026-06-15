/**
 * 4NE-26 (FR-10 / AD-4) — THE approval chokepoint.
 *
 * `requestApproval` is the single function every irreversible action funnels
 * through to obtain proof-of-approval. It is FAIL-CLOSED by construction:
 *
 *   1. If a pre-auth loader is provided and a {@link PreAuthRule} standing-
 *      approves the request → approved, auto + pre-authorized, token minted.
 *   2. Else if an operator channel is provided → await its verdict. `approved`
 *      mints a token; `denied`/`timeout` mint NO token. ANY throw from the
 *      operator channel → FAIL CLOSED (denied, no token) — an approval-channel
 *      outage must never become a silent bypass.
 *   3. Else (no pre-auth, no operator channel) → FAIL CLOSED (denied, no token).
 *      A missing channel is treated as "cannot obtain approval", never as
 *      "approved by default".
 *
 * The operator channel and the pre-auth loader are INJECTED via `deps` (the
 * test-seam pattern from `hil.ts`), so tests exercise every branch without a
 * network. `now` is injected so token timestamps are deterministic in tests.
 *
 * A token is bound to its EXACT request via {@link stableHash}. The
 * side-effecting layer (publish dispatcher, connector activation) calls
 * {@link verifyToken} against the request it is ABOUT to perform and refuses to
 * proceed on a mismatch — this is what makes the chokepoint un-bypassable: a
 * token approving action A cannot authorise a different action B.
 */

import { stableHash } from './hash';
import {
  ApprovalDeniedError,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalToken,
  type ApprovalVerdict,
  type PreAuthRule,
} from './types';
import { evaluatePreAuth } from './preauth';

/**
 * Dependencies injected into {@link requestApproval}. All optional; their
 * ABSENCE is meaningful (see the fail-closed rules in the module docs).
 *
 *  - `askOperator`  — the interactive channel (UI modal / long-poll / IPC). A
 *    throw is treated as a channel outage → fail closed.
 *  - `loadPreAuth`  — loads the persisted standing-approval rules. Omit to skip
 *    the pre-auth check entirely (e.g. when the caller already knows there are
 *    none, or for a one-off interactive-only flow).
 *  - `now`          — clock for the token's `grantedAt`. Defaults to `Date.now`.
 */
export interface ApprovalDeps {
  askOperator?: (req: ApprovalRequest) => Promise<{ verdict: ApprovalVerdict; reason?: string }>;
  loadPreAuth?: () => Promise<PreAuthRule[]>;
  now?: () => number;
}

/**
 * Mint proof-of-approval bound to the exact request. ONLY called after an
 * `approved` verdict (auto or operator). The `requestHash` is what
 * {@link verifyToken} checks downstream.
 */
export function mintToken(req: ApprovalRequest, now: () => number): ApprovalToken {
  return {
    kind: req.kind,
    requestHash: stableHash(req),
    grantedAt: now(),
    scope: req.target,
  };
}

/**
 * Verify a token authorises the EXACT request the caller is about to perform.
 * True iff the token exists, its `kind` matches, and its `requestHash` equals
 * the freshly-computed hash of `req`. A tampered request (different target or
 * payload) recomputes to a different hash and is rejected.
 */
export function verifyToken(token: ApprovalToken | undefined, req: ApprovalRequest): boolean {
  if (!token) return false;
  if (token.kind !== req.kind) return false;
  return token.requestHash === stableHash(req);
}

/**
 * THE chokepoint. Returns an {@link ApprovalDecision}; a token is present IFF
 * `verdict === 'approved'`. See module docs for the fail-closed ordering.
 */
export async function requestApproval(
  req: ApprovalRequest,
  deps: ApprovalDeps = {},
): Promise<ApprovalDecision> {
  const now = deps.now ?? Date.now;

  // (1) Pre-auth: a standing operator rule auto-approves without a prompt.
  if (deps.loadPreAuth) {
    let rules: PreAuthRule[] = [];
    try {
      rules = await deps.loadPreAuth();
    } catch {
      // A pre-auth load failure must NOT auto-approve. Fall through to the
      // operator channel (or, if none, the fail-closed default below).
      rules = [];
    }
    if (evaluatePreAuth(req, rules)) {
      return {
        verdict: 'approved',
        autoApproved: true,
        preAuthorized: true,
        token: mintToken(req, now),
      };
    }
  }

  // (2) Interactive operator channel.
  if (deps.askOperator) {
    let result: { verdict: ApprovalVerdict; reason?: string };
    try {
      result = await deps.askOperator(req);
    } catch {
      // FAIL CLOSED: an approval-channel error is never an approval. We deny
      // rather than throw so the gate's contract (always returns a decision)
      // holds; `assertApproved` turns this into a throw for call sites that
      // want one.
      return {
        verdict: 'denied',
        reason: 'approval channel error',
        autoApproved: false,
        preAuthorized: false,
      };
    }

    if (result.verdict === 'approved') {
      return {
        verdict: 'approved',
        reason: result.reason,
        autoApproved: false,
        preAuthorized: false,
        token: mintToken(req, now),
      };
    }

    // denied / timeout → no token.
    return {
      verdict: result.verdict,
      reason: result.reason,
      autoApproved: false,
      preAuthorized: false,
    };
  }

  // (3) No pre-auth match AND no operator channel → FAIL CLOSED. A missing
  // channel means we cannot obtain approval, which is a denial — never a
  // default-allow.
  return {
    verdict: 'denied',
    reason: 'no approval channel available',
    autoApproved: false,
    preAuthorized: false,
  };
}

/**
 * Convenience wrapper for call sites that want a token-or-throw: runs
 * {@link requestApproval} and returns the minted token on approval, or throws
 * {@link ApprovalDeniedError} on denial/timeout. This is how the autonomy loop
 * / CLI / route obtains the token it then hands to the side-effecting layer.
 */
export async function assertApproved(
  req: ApprovalRequest,
  deps: ApprovalDeps = {},
): Promise<ApprovalToken> {
  const decision = await requestApproval(req, deps);
  if (decision.verdict !== 'approved' || !decision.token) {
    const verdict: 'denied' | 'timeout' =
      decision.verdict === 'timeout' ? 'timeout' : 'denied';
    throw new ApprovalDeniedError(verdict, decision.reason ?? 'not approved');
  }
  return decision.token;
}
