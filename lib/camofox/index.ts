/**
 * CAMOFOX-CAMOUFOX-1.1.0 (2026-06-06): barrel export for the camofox
 * client. The route call-sites import from `@/lib/camofox` only —
 * never from the sub-modules. That keeps the public surface small
 * and gives us one place to flip internals.
 */
export {
  camofoxSearch,
  camofoxStatus,
  withCamofoxHealth,
  scrubPii,
  CamofoxUnavailableError,
  CamofoxParseError,
  type CamofoxSearchOpts,
  type CamofoxStatus,
} from './client';

export {
  CAMOFOX_MACROS,
  CAMOFOX_DEFAULT_PORT,
  JSON_RETURNING_MACROS,
  buildManualSearchUrl,
  type CamofoxMacro,
} from './macros';
