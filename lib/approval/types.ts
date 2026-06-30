/**
 * 4NE-26 (FR-10 / AD-4) — Unified approval chokepoint: shared types.
 *
 * A SINGLE gate every irreversible action funnels through — the publish path,
 * the connector-activation path, the spend-heavy generation tools (Story 10.1
 * migrated `generate_image`/`generate_video` onto this gate and retired the
 * old `lib/agent-loop/hil.ts` + `/api/ai/confirm` sibling), and any future
 * irreversible action. This is the generalised, transport-free approval
 * primitive they all route through. The contract is proof-based: an approval mints an
 * {@link ApprovalToken} bound (via {@link import('./hash').stableHash}) to the
 * EXACT request it approved; a side-effecting layer must VERIFY that token
 * against the request it is about to perform before doing anything irreversible.
 *
 * Nothing here speaks HTTP or imports a transport — the operator channel is
 * injected as a dependency (see `gate.ts`), mirroring the test-seam pattern in
 * `hil.ts`. These types are framework-free so the gate, the persisted pre-auth
 * store, the publish/connector layers, and any future UI all share them.
 */

/**
 * The categories of irreversible action that funnel through the gate.
 *  - `spend`             — a credit-burning provider call (estimated cost in USD).
 *  - `publish`           — posting to an external surface (Instagram / Pinterest).
 *  - `connector-activate`— trusting + enabling an MCP connector.
 *  - `irreversible`      — the catch-all for any other one-way action.
 */
export type ApprovalKind = 'spend' | 'publish' | 'connector-activate' | 'irreversible';

/**
 * The exact action shown to the operator. The MATERIAL fields (`kind`,
 * `target`, `payloadPreview`) are what bind a token to a request via
 * {@link import('./hash').stableHash}; `summary` and `requestId` are
 * human/correlation-only and deliberately NOT hashed (see `hash.ts`).
 */
export interface ApprovalRequest {
  kind: ApprovalKind;
  /** One-line human-readable description shown in the approval prompt. */
  summary: string;
  /** The thing being acted on (e.g. `'instagram:my-connector'`, a connector id). */
  target?: string;
  /** For `spend`: the estimated USD cost the pre-auth rule compares against. */
  estimatedCostUsd?: number;
  /**
   * For `spend` budget-accumulation safety (Story 10.1): the run's cost so far
   * and its per-run budget. Carried so a spend pre-auth rule can refuse a small
   * within-ceiling call that would still push the run past its budget cap.
   * Deliberately NOT hashed (transient run state, not part of the bound action
   * identity — see `hash.ts`, which hashes only `kind`/`target`/`payloadPreview`).
   */
  totalCostSoFarUsd?: number;
  budgetUsd?: number;
  /** A canonical preview of the payload (e.g. `{ assetIds, caption }`). */
  payloadPreview?: unknown;
  /** Optional correlation id for logging — NOT part of the bound hash. */
  requestId?: string;
}

/** The operator's (or the gate's) decision on a request. */
export type ApprovalVerdict = 'approved' | 'denied' | 'timeout';

/**
 * Proof-of-approval. Minted ONLY on an `approved` verdict. `requestHash` binds
 * this token to the exact {@link ApprovalRequest} it approved — a side-effecting
 * layer recomputes the hash of the request it is about to perform and rejects a
 * token whose `requestHash` doesn't match (so an approval for action A can never
 * authorise action B).
 */
export interface ApprovalToken {
  kind: ApprovalKind;
  /** Deterministic hash of the request's MATERIAL fields. */
  requestHash: string;
  /** Wall-clock time (ms) the approval was granted, from the injected `now`. */
  grantedAt: number;
  /** The request's `target`, carried for convenience / logging. */
  scope?: string;
}

/**
 * The full outcome of a gate evaluation.
 *  - `verdict`       — approved / denied / timeout.
 *  - `autoApproved`  — the gate decided without an operator round-trip.
 *  - `preAuthorized` — the decision came from a persisted {@link PreAuthRule}.
 *  - `token`         — present IFF `verdict === 'approved'`.
 */
export interface ApprovalDecision {
  verdict: ApprovalVerdict;
  reason?: string;
  autoApproved: boolean;
  preAuthorized: boolean;
  token?: ApprovalToken;
}

/**
 * A persisted operator-defined rule that auto-approves a kind of request
 * without an interactive prompt. The operator opts in explicitly; an absent or
 * disabled rule means the action still needs an interactive approval.
 *
 *  - `spend`            — auto-approves when `req.estimatedCostUsd <= maxCostUsd`
 *    AND (Story 10.1) the projected run total stays within `budgetCapFraction`
 *    of `req.budgetUsd`.
 *  - the other kinds    — auto-approve when `targetAllow` includes `req.target`,
 *    OR when `targetAllow` is undefined/empty (which the operator has chosen to
 *    mean "allow any target for this kind" — see `evaluatePreAuth`).
 */
export interface PreAuthRule {
  kind: ApprovalKind;
  enabled: boolean;
  /** For `spend`: the inclusive USD ceiling that auto-approves. */
  maxCostUsd?: number;
  /**
   * For `spend`: the fraction of the per-run budget above which even a
   * within-`maxCostUsd` call is refused auto-approval (Story 10.1 — preserves
   * the old `hil.ts` 95 % budget-accumulation safety). Defaults to `0.95` when
   * undefined. Only applied when the request carries a positive `budgetUsd`.
   */
  budgetCapFraction?: number;
  /** For non-spend kinds: the allow-list of targets (empty/undefined = any). */
  targetAllow?: string[];
}

/**
 * Thrown by {@link import('./gate').assertApproved} when a request is not
 * approved (denied or timed out). Prototype fix-up mirrors `McpError` so
 * `instanceof` survives transpilation to ES5-ish targets.
 */
export class ApprovalDeniedError extends Error {
  readonly verdict: 'denied' | 'timeout';
  readonly reason: string;
  constructor(verdict: 'denied' | 'timeout', reason: string) {
    super(`Approval ${verdict}: ${reason}`);
    this.name = 'ApprovalDeniedError';
    this.verdict = verdict;
    this.reason = reason;
    // Restore the prototype chain — without this, `instanceof
    // ApprovalDeniedError` is false when transpiled (mirrors McpError).
    Object.setPrototypeOf(this, ApprovalDeniedError.prototype);
  }
}
