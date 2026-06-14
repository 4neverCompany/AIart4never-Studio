/**
 * Public API for the post-lifecycle module.
 * Re-exports the state machine, types, persistence, reconciler, AND
 * the migration bridge from the legacy IDB shape.
 */

export {
  PostId,
  ImageBlobId,
  InvalidTransitionError,
  AtomicityViolationError,
} from './types';

export type {
  PostId as PostIdType,
  ImageBlobId as ImageBlobIdType,
  PostRecord,
  PostState,
  PostFailureReason,
  Platform,
  ImageBlob,
  StateTransition,
} from './types';

export {
  canTransition,
  transition,
  isRetryable,
  isExhausted,
  nextRetryDelay,
  createDraftPost,
} from './state-machine';

export type { TransitionOptions } from './state-machine';

export type { PostLifecycleStorage } from './persistence';
export { InMemoryStorage } from './persistence';

export { Reconciler } from './reconciler';
export type { ReconcileResult } from './reconciler';

// Migration bridge
export {
  loadPostRecords,
  savePostRecords,
  runMigrationIfNeeded,
  buildPostRecords,
  syncLegacyScheduledPost,
  applyTransition,
  postIdFromScheduledPostId,
} from './migration';
