/**
 * Post-lifecycle types.
 *
 * The state machine is a pure module — these types are the contract
 * between the state machine, the persistence layer, and the rest of
 * the application.
 *
 * If you change any type, run the contract tests:
 *   npm test -- tests/post-lifecycle/
 */

// ── Branded primitives ───────────────────────────────────────────────────
//
// Branded types prevent accidentally mixing PostId and ImageBlobId,
// which are both strings at runtime but represent different things.

declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

export type PostId = Brand<string, 'PostId'>;
export type ImageBlobId = Brand<string, 'ImageBlobId'>;

// Constructors with runtime validation. Use these instead of `as PostId`
// so bad inputs fail loudly at the construction site.

export const PostId = (s: string): PostId => {
  if (!/^post_[A-Za-z0-9_-]{6,}$/.test(s)) {
    throw new Error(`Invalid PostId: ${s}`);
  }
  return s as PostId;
};

export const ImageBlobId = (s: string): ImageBlobId => {
  if (!/^blob_[A-Za-z0-9_-]{6,}$/.test(s)) {
    throw new Error(`Invalid ImageBlobId: ${s}`);
  }
  return s as ImageBlobId;
};

// ── State and failure types ──────────────────────────────────────────────

/**
 * The state of a post in its lifecycle.
 *
 * State graph:
 *   draft → generating_image → image_ready → captioning
 *        → caption_ready → scheduled → posting → posted
 *
 *   Any state can transition to `failed` with a reason.
 *   `failed` can transition back to `draft` (user-initiated restart).
 *   `posted` is terminal.
 */
export type PostState =
  | 'draft'
  | 'generating_image'
  | 'image_ready'
  | 'captioning'
  | 'caption_ready'
  | 'scheduled'
  | 'posting'
  | 'posted'
  | 'failed';

export type PostFailureReason =
  | 'image_missing'         // blob was deleted, but metadata remains (the v0.9.41 bug)
  | 'image_upload_failed'   // could not upload to uguu / cdn
  | 'image_generation_failed' // all image providers failed
  | 'caption_failed'        // AI captioning failed
  | 'caption_blocked'       // moderation/trademark blocked the caption
  | 'platform_rejected'     // Instagram / Twitter rejected the post
  | 'malformed_schedule'    // scheduled date is invalid
  | 'unknown';

export type Platform = 'instagram' | 'twitter' | 'both';

// ── Core records ─────────────────────────────────────────────────────────

/**
 * A post. One record per post. State is explicit.
 *
 * Invariant: when state is in {image_ready, captioning, caption_ready,
 * scheduled, posting}, imageBlobId MUST be set and the blob MUST exist
 * in the storage layer. The reconciler enforces this at startup.
 */
export interface PostRecord {
  readonly id: PostId;

  state: PostState;

  // Image
  imageBlobId: ImageBlobId | null;
  hostedImageUrl: string | null;  // the URL after upload to uguu / cdn

  // Caption
  caption: string | null;
  hashtags: readonly string[];

  // Scheduling
  scheduledFor: string | null;     // ISO 8601, null if not scheduled
  platform: Platform | null;

  // Lifecycle metadata
  readonly createdAt: string;       // ISO 8601
  updatedAt: string;                // ISO 8601
  stateChangedAt: string;           // ISO 8601

  // Failure tracking
  failureReason: PostFailureReason | null;
  failureContext: Readonly<Record<string, unknown>> | null;
  retryCount: number;
  retryable: boolean;
  nextRetryAt: string | null;       // ISO 8601

  // Audit trail — append-only log of state transitions
  history: readonly StateTransition[];

  // Optional: the idea that generated this post
  ideaId: string | null;
  // Optional: the model that generated the image
  imageModelId: string | null;
}

/**
 * A single state transition in a post's history.
 * Append-only. Never edit or delete entries.
 */
export interface StateTransition {
  readonly from: PostState;
  readonly to: PostState;
  readonly at: string;              // ISO 8601
  readonly reason: PostFailureReason | null;
  readonly note: string | null;     // human-readable, e.g. "AI caption generated"
}

/**
 * An image blob — the actual image data plus metadata.
 *
 * Stored separately from the post record so the storage layer can
 * enforce atomicity: post metadata + blob are written together.
 */
export interface ImageBlob {
  readonly id: ImageBlobId;
  readonly postId: PostId;
  readonly format: 'jpeg' | 'png' | 'webp';
  readonly sizeBytes: number;
  readonly createdAt: string;
  lastVerifiedAt: string;            // updated by the reconciler
  data: ArrayBuffer;                 // the raw image bytes
}

// ── Error types ──────────────────────────────────────────────────────────

export class InvalidTransitionError extends Error {
  readonly from: PostState;
  readonly to: PostState;
  constructor(from: PostState, to: PostState) {
    super(`Invalid state transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export class AtomicityViolationError extends Error {
  constructor(message: string) {
    super(`Atomicity violation in savePostWithBlob: ${message}`);
    this.name = 'AtomicityViolationError';
  }
}
