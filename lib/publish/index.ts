/**
 * M2 — Gated publish path: public surface.
 *
 * The one safety-critical invariant this module guards: NOTHING reaches
 * Instagram / Pinterest unless a human approved it. The gate
 * ({@link assertPublishable}) runs first in the dispatcher, before any network.
 *
 * Import from `@/lib/publish` rather than reaching into the individual files.
 */

export type {
  PublishTarget,
  PublishAsset,
  PublishRequest,
  PublishStep,
  PublishPlan,
  PublishResult,
} from './types';

export {
  PublishGateError,
  assertPublishable,
  softWatermarkWarnings,
  WATERMARK_TAG_MARKER,
} from './gate';
export type { PublishGateErrorCode } from './gate';

export {
  buildInstagramPlan,
  IG_CREATE_MEDIA,
  IG_PUBLISH_MEDIA,
  childToken,
  PARENT_TOKEN,
  DEFAULT_IG_USER_ID,
  PUBLISH_MAX_WAIT_SECONDS,
} from './instagram';

export { buildPinterestPlan, PINTEREST_CREATE_PIN } from './pinterest';

export { publish, extractId, ApprovalRequiredError, buildPublishApprovalRequest } from './dispatch';
export type { DispatchRequest, PublishDeps } from './dispatch';
