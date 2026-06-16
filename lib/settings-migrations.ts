import type { UserSettings } from '../types/mashup';

type AutoApproveMap = UserSettings['pipelineAutoApprove'];

/**
 * Load-time settings migrations (LIVE path).
 *
 * Extracted from lib/pipeline-daemon-utils.ts so the live settings
 * hydration path (hooks/useSettings.ts) no longer depends on the
 * daemon-web module. The daemon-only helpers (post-status resolution,
 * platform auto-approve lookup, continuous-branch decision, the idea
 * timeout error) stay in pipeline-daemon-utils.ts; that module now
 * re-exports the four migrations below for backwards compatibility
 * with the existing daemon-zone tests.
 */

/**
 * V040-HOTFIX-001: legacy-user migration shim.
 *
 * Applied once on settings load. If `pipelineAutoApprove` is absent
 * from the saved payload (the case for every 0.3.x user on first
 * upgrade), persist an explicit auto-everywhere map. This:
 *   1. Locks in the user's pre-upgrade behavior — every platform stays
 *      auto-approved even if the future shifts the runtime default.
 *   2. Makes the user's choices visible in the settings UI instead of
 *      hiding them behind undefined-fallback semantics.
 *
 * Idempotent: returns the input unchanged when `pipelineAutoApprove`
 * is already an object (the user has either explicitly configured it
 * or has already been migrated). Safe to run on every load.
 *
 * Returns the input reference unchanged when no migration is needed,
 * so consumers can use referential equality to skip re-renders.
 */
export function applyV040AutoApproveMigration<T extends { pipelineAutoApprove?: AutoApproveMap }>(
  settings: T,
): T {
  if (settings.pipelineAutoApprove !== undefined) return settings;
  return {
    ...settings,
    pipelineAutoApprove: {
      instagram: true,
      pinterest: true,
      twitter: true,
      discord: true,
    },
  };
}

/**
 * V1.6: Director-default migration.
 *
 * The agentic Director pipeline shipped opt-in in v1.5.0 and became
 * the DEFAULT path in v1.6.0 (roadmap decision, 2026-06-10: "Default
 * machen, sobald M1 stabil ist"). Because useSettings persists the
 * full merged settings object, every pre-v1.6 user has
 * `useDirectorPipeline: false` written into their store from the old
 * default — flipping `defaultSettings` alone would never reach them.
 *
 * This shim runs on every settings load (same slot as the V040
 * migration above) and turns the Director on UNLESS the user has
 * explicitly touched the toggle: the Settings switch stamps
 * `directorPipelineUserSet: true` on every click (from v1.6.0 on),
 * and a stamped choice — on OR off — is never overridden again.
 *
 * Idempotent + referential-equality friendly: returns the input
 * reference unchanged when the Director is already on or the user
 * has made an explicit choice.
 */
export function applyV160DirectorDefaultMigration<
  T extends { useDirectorPipeline?: boolean; directorPipelineUserSet?: boolean },
>(settings: T): T {
  if (settings.directorPipelineUserSet === true) return settings;
  if (settings.useDirectorPipeline === true) return settings;
  return { ...settings, useDirectorPipeline: true };
}

/**
 * M3.3-P3 commit a — aiClient-default flip.
 *
 * Retires the pi/nca/mmx subprocess agents in v1.8.0. The runtime
 * default in `lib/aiClient.ts` now reads `?? 'vercel-ai'`; this
 * shim rewrites the *persisted* user choice so a v1.7.0 install
 * that explicitly picked 'pi' (or 'nca' / 'mmx') silently lands
 * on the new default on first post-upgrade load — no broken
 * /api/pi/prompt 404, no user-visible "please re-pick" prompt.
 *
 * Writes the rewrite back to the persisted store via the
 * settings-hydration caller (see useSettings.ts:applySettingsMigrations
 * invocation), so the next debounced save round-trips the cleaned
 * state. Idempotent + referential-equality friendly: a value that's
 * already 'vercel-ai' (or undefined) returns the input reference
 * unchanged.
 *
 * Q1 of the M3.3-P3 recon: picked option A1 (one-shot IDB rewrite
 * on first load) over A2 (rely on union narrowing to crash) and
 * A3 (keep the legacy routes as no-op fallbacks for one release).
 */
export function applyM33AiAgentFlip<
  T extends { activeAiAgent?: string; aiAgentProvider?: string },
>(settings: T): T {
  const LEGACY = new Set(['pi', 'nca', 'mmx']);
  const aaa = settings.activeAiAgent;
  const aap = settings.aiAgentProvider;
  const aaaIsLegacy = typeof aaa === 'string' && LEGACY.has(aaa);
  const aapIsLegacy = typeof aap === 'string' && LEGACY.has(aap);
  if (!aaaIsLegacy && !aapIsLegacy) return settings;
  return {
    ...settings,
    ...(aaaIsLegacy ? { activeAiAgent: 'vercel-ai' } : {}),
    ...(aapIsLegacy ? { aiAgentProvider: 'vercel-ai' } : {}),
  };
}

/**
 * MashupForge rip — Leonardo engine removal migration.
 *
 * The Leonardo image/video engine has been removed; MiniMax + Higgsfield
 * are the only providers. Pre-rip stores carry leftover `'leonardo'`
 * references that the narrowed types no longer permit and that would
 * orphan gallery metadata or trip `persist-asset` on a legacy ref. This
 * additive one-shot rewrite cleans the persisted SETTINGS-level provider
 * fields on hydration:
 *
 *   - `enabledProviders`: every `'leonardo'` → `'minimax'` (deduped).
 *   - `videoProviders`:   every `'leonardo'` → `'minimax'` (deduped).
 *   - `defaultLeonardoModel`: a stale Leonardo-catalog id (the deleted
 *     nano-banana* / gpt-image* slugs) → `'minimax-image-01'` so the
 *     model picker / `pickDefaultImageModel` resolve to a live model.
 *
 * The UserSettings `apiKeys.leonardo` and `defaultLeonardoModel` FIELDS
 * are intentionally preserved (IDB safety) — only stale VALUES that the
 * narrowed unions reject are rewritten. Idempotent + referential-equality
 * friendly: a clean store returns the input reference unchanged.
 *
 * The companion {@link rewriteLegacyLeonardoImageProvider} helper rewrites
 * a single persisted `GeneratedImage.modelInfo.provider === 'leonardo'`
 * value to `'higgsfield'` for the gallery-hydration path.
 */
const DELETED_LEONARDO_MODEL_IDS = new Set([
  'nano-banana',
  'nano-banana-2',
  'nano-banana-pro',
  'gpt-image-1.5',
  'gpt-image-2',
]);

export function applyLeonardoRemovalMigration<
  T extends {
    enabledProviders?: string[];
    videoProviders?: string[];
    defaultLeonardoModel?: string;
  },
>(settings: T): T {
  const hasLegacyEnabled = Array.isArray(settings.enabledProviders)
    && settings.enabledProviders.includes('leonardo');
  const hasLegacyVideo = Array.isArray(settings.videoProviders)
    && settings.videoProviders.includes('leonardo');
  const hasLegacyDefault = typeof settings.defaultLeonardoModel === 'string'
    && DELETED_LEONARDO_MODEL_IDS.has(settings.defaultLeonardoModel);

  if (!hasLegacyEnabled && !hasLegacyVideo && !hasLegacyDefault) return settings;

  const dedupe = (xs: string[]) => Array.from(new Set(xs));

  return {
    ...settings,
    ...(hasLegacyEnabled
      ? { enabledProviders: dedupe(settings.enabledProviders!.map((p) => (p === 'leonardo' ? 'minimax' : p))) }
      : {}),
    ...(hasLegacyVideo
      ? { videoProviders: dedupe(settings.videoProviders!.map((p) => (p === 'leonardo' ? 'minimax' : p))) }
      : {}),
    ...(hasLegacyDefault ? { defaultLeonardoModel: 'minimax-image-01' } : {}),
  };
}

/**
 * Rewrite a single persisted gallery-image provider value. A pre-rip
 * `GeneratedImage.modelInfo.provider === 'leonardo'` becomes
 * `'higgsfield'` (the closest live image engine) so the narrowed
 * `modelInfo.provider` union stays valid and `persist-asset` never sees
 * a legacy ref. Any non-leonardo value passes through unchanged. Pure +
 * idempotent — safe for the images-hydration migration to map over the
 * persisted gallery on load.
 */
export function rewriteLegacyLeonardoImageProvider(provider: string | undefined): string | undefined {
  return provider === 'leonardo' ? 'higgsfield' : provider;
}

/**
 * Composition of every load-time settings migration, applied by
 * useSettings on each hydration path. Order: oldest first, so later
 * migrations see the post-migration state of earlier ones.
 *
 * M3.3-P3 commit a: added `applyM33AiAgentFlip` as the innermost
 * step — runs first so the older migrations see the post-flip
 * `activeAiAgent` / `aiAgentProvider` values. The flip is a pure
 * rewrite of legacy `'pi' | 'nca' | 'mmx'` string values to
 * `'vercel-ai'`. Idempotent: a value that's already `'vercel-ai'`
 * (or `undefined`) returns the input reference unchanged.
 *
 * MashupForge rip: `applyLeonardoRemovalMigration` is the outermost
 * step — it rewrites stale `'leonardo'` provider/model references left
 * in pre-rip stores after the earlier migrations have settled the rest.
 */
export function applySettingsMigrations<
  T extends {
    pipelineAutoApprove?: AutoApproveMap;
    useDirectorPipeline?: boolean;
    directorPipelineUserSet?: boolean;
    activeAiAgent?: string;
    aiAgentProvider?: string;
    enabledProviders?: string[];
    videoProviders?: string[];
    defaultLeonardoModel?: string;
  },
>(settings: T): T {
  return applyLeonardoRemovalMigration(
    applyV160DirectorDefaultMigration(
      applyV040AutoApproveMigration(applyM33AiAgentFlip(settings)),
    ),
  );
}
