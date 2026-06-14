/**
 * Post-lifecycle state machine.
 *
 * Pure functions over PostRecord values. No I/O, no persistence, no
 * side effects. The persistence layer wraps these and handles
 * atomic writes.
 *
 * If you add a state, update:
 *   1. PostState in types.ts
 *   2. VALID_TRANSITIONS below
 *   3. The contract tests in tests/post-lifecycle/
 *
 * The state machine is the source of truth for what transitions are
 * allowed. The reconciler and the API routes call `transition()` —
 * they do not mutate `post.state` directly.
 */

import {
  type PostRecord,
  type PostState,
  type PostFailureReason,
  type StateTransition,
  InvalidTransitionError,
} from './types';

// ── The transition table ─────────────────────────────────────────────────
//
// This is the heart of the design. Every legal transition is listed
// here. Illegal transitions throw InvalidTransitionError.
//
// To make a transition illegal: remove it from the list.
// To add a new state: add it to PostState AND to this table.

const VALID_TRANSITIONS: Readonly<Record<PostState, readonly PostState[]>> = {
  draft:             ['generating_image'],
  generating_image:  ['image_ready', 'failed'],
  image_ready:       ['captioning', 'failed', 'draft'], // user rejected the image
  captioning:        ['caption_ready', 'failed', 'draft'], // user rejected mid-caption
  caption_ready:     ['scheduled', 'failed', 'draft'], // user rejected the caption
  scheduled:         ['posting', 'failed'],
  // scheduled → image_ready: the reconciler can re-promote a scheduled
  // post back to image_ready if the image was re-uploaded. Not a normal
  // application transition — only the reconciler does this.
  // (Listed here but guarded by `transition` for explicit allowlist.)
  posting:           ['posted', 'failed'],
  posted:            [], // terminal
  failed:            ['draft'], // user-initiated restart
};

// The reconciler's special re-promote. Not a normal transition.
const RECONCILER_TRANSITIONS: Readonly<Record<PostState, readonly PostState[]>> = {
  ...VALID_TRANSITIONS,
  scheduled: ['posting', 'failed', 'image_ready'], // re-promote allowed
  image_ready: ['captioning', 'failed', 'captioning', 'draft'], // no-op, but allowed
  caption_ready: ['scheduled', 'failed', 'image_ready', 'draft'], // re-promote to regenerate
};

export function canTransition(
  from: PostState,
  to: PostState,
  opts: { reconciler?: boolean } = {}
): boolean {
  const table = opts.reconciler ? RECONCILER_TRANSITIONS : VALID_TRANSITIONS;
  return table[from]?.includes(to) ?? false;
}

// ── Retry policy ─────────────────────────────────────────────────────────
//
// Drives the auto-retry behavior on `failed` transitions. Trivial
// failures (network blips, AI rate-limits) are auto-retried with
// backoff. Critical failures (data integrity, user-fixable) require
// explicit user action.

const RETRYABLE_REASONS: ReadonlySet<PostFailureReason> = new Set([
  'image_upload_failed',
  'image_generation_failed',
  'caption_failed',
  'unknown',
]);

const BACKOFF_MS: Readonly<Record<PostFailureReason, number>> = {
  image_missing:          0,
  image_upload_failed:    5 * 60 * 1000,         // 5 min
  image_generation_failed: 2 * 60 * 1000,        // 2 min
  caption_failed:         60 * 1000,             // 1 min
  caption_blocked:        0,                     // surface to user
  platform_rejected:      0,                     // surface to user
  malformed_schedule:     0,                     // surface to user
  unknown:                60 * 1000,             // 1 min
};

const MAX_RETRIES: Readonly<Record<PostFailureReason, number>> = {
  image_missing:          0,
  image_upload_failed:    3,
  image_generation_failed: 2,
  caption_failed:         2,
  caption_blocked:        0,
  platform_rejected:      0,
  malformed_schedule:     0,
  unknown:                3,
};

export function isRetryable(reason: PostFailureReason | null): boolean {
  if (!reason) return false;
  return RETRYABLE_REASONS.has(reason);
}

export function nextRetryDelay(reason: PostFailureReason, attempt: number): number {
  const base = BACKOFF_MS[reason];
  // Exponential backoff: base * 2^attempt, capped at 1 hour
  return Math.min(base * Math.pow(2, attempt), 60 * 60 * 1000);
}

export function isExhausted(reason: PostFailureReason, retryCount: number): boolean {
  return retryCount >= MAX_RETRIES[reason];
}

// ── Core transition function ─────────────────────────────────────────────

export interface TransitionOptions {
  /** The reason for the transition. Required when transitioning to `failed`. */
  reason?: PostFailureReason;
  /** Human-readable note, e.g. "AI caption generated" or "uguu upload returned 503". */
  note?: string;
  /** If true, allow the reconciler's special re-promote transitions. */
  reconciler?: boolean;
}

/**
 * Transition a post to a new state. Returns a new PostRecord.
 *
 * This is a PURE function. It does not write to storage. The caller
 * is responsible for persisting the new state atomically with any
 * associated writes (e.g. image blob).
 *
 * Throws InvalidTransitionError if the transition is not allowed.
 */
export function transition(
  post: PostRecord,
  to: PostState,
  opts: TransitionOptions = {}
): PostRecord {
  if (!canTransition(post.state, to, { reconciler: opts.reconciler })) {
    throw new InvalidTransitionError(post.state, to);
  }

  if (to === 'failed' && !opts.reason) {
    throw new Error('Transitioning to failed requires a reason');
  }

  const now = new Date().toISOString();
  const failureReason = to === 'failed' ? opts.reason! : null;
  const retryCount = to === 'failed' ? post.retryCount + 1 : 0;
  const retryable = to === 'failed' ? isRetryable(failureReason) : false;
  const nextRetryAt = to === 'failed' && retryable
    ? new Date(Date.now() + nextRetryDelay(failureReason!, 0)).toISOString()
    : null;

  const entry: StateTransition = {
    from: post.state,
    to,
    at: now,
    reason: failureReason,
    note: opts.note ?? null,
  };

  return {
    ...post,
    state: to,
    stateChangedAt: now,
    updatedAt: now,
    failureReason,
    failureContext: to === 'failed' ? buildFailureContext(opts) : null,
    retryCount,
    retryable,
    nextRetryAt,
    history: [...post.history, entry],
  };
}

function buildFailureContext(opts: TransitionOptions): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  if (opts.note) ctx.note = opts.note;
  return ctx;
}

// ── Factories ────────────────────────────────────────────────────────────

/**
 * Create a new post in `draft` state.
 */
export function createDraftPost(opts: { id: PostRecord['id']; ideaId?: string | null }): PostRecord {
  const now = new Date().toISOString();
  return {
    id: opts.id,
    state: 'draft',
    imageBlobId: null,
    hostedImageUrl: null,
    caption: null,
    hashtags: [],
    scheduledFor: null,
    platform: null,
    createdAt: now,
    updatedAt: now,
    stateChangedAt: now,
    failureReason: null,
    failureContext: null,
    retryCount: 0,
    retryable: false,
    nextRetryAt: null,
    history: [],
    ideaId: opts.ideaId ?? null,
    imageModelId: null,
  };
}
