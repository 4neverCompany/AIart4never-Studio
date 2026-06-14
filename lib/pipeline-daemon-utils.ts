import type { ScheduledPost, UserSettings } from '../types/mashup';
import type { WeekFillStatus } from './weekly-fill';

type AutoApproveMap = UserSettings['pipelineAutoApprove'];
type PlatformKey = 'instagram' | 'pinterest' | 'twitter' | 'discord';

/**
 * V040-008 + V040-HOTFIX-001: per-platform approval defaults.
 *
 * All platforms default to auto-approval. The original V040-008 shipped
 * with `instagram: false` for safety reasons (the Graph API is the most
 * failure-prone integration), but that silently flipped behavior for
 * existing 0.3.x users on upgrade — Instagram posts started piling up
 * in the approval queue with no in-app explanation. The hotfix flips
 * the default back to auto so upgrades are non-breaking; users who
 * want manual gating must opt in via the PipelinePanel checkboxes.
 *
 * `applyV040AutoApproveMigration` (below) writes the explicit
 * auto-everywhere config into a legacy user's saved settings on first
 * post-upgrade load, so their state shows up in the settings UI rather
 * than relying on an undefined-fallback that could shift again later.
 */
const DEFAULT_AUTO_APPROVE: Record<PlatformKey, boolean> = {
  instagram: true,
  pinterest: true,
  twitter: true,
  discord: true,
};

const isKnownPlatform = (p: string): p is PlatformKey =>
  p === 'instagram' || p === 'pinterest' || p === 'twitter' || p === 'discord';

/**
 * Returns `true` when a given platform is auto-approved (post lands
 * as `scheduled`) and `false` when it requires manual approval
 * (post lands as `pending_approval`). Unknown platforms default to
 * manual approval — unrecognized channels shouldn't silently publish.
 */
export function isPlatformAutoApproved(
  platform: string,
  config: AutoApproveMap | undefined,
): boolean {
  if (!isKnownPlatform(platform)) return false;
  const explicit = config?.[platform];
  if (typeof explicit === 'boolean') return explicit;
  return DEFAULT_AUTO_APPROVE[platform];
}

/**
 * BUG-CRIT-001: pipeline-produced posts ALWAYS land as
 * `pending_approval`. Two reasons:
 *
 *   1. Safety. Auto-scheduling without a human review step means
 *      AI-generated content can hit live channels with zero gating.
 *      A bad caption, mis-tagged image, or model hallucination
 *      goes straight to the audience.
 *   2. Watermark. The watermark pass is performed inside
 *      MashupContext.approveScheduledPost (via
 *      finalizePipelineImagesForPosts). Posts that bypass approval
 *      ALSO bypass the watermark. The fastest way to guarantee
 *      every published image is watermarked is to require every
 *      published post to pass through approval.
 *
 * The `platforms` and `config` parameters are accepted for
 * backwards compatibility with existing call sites; the previous
 * `pipelineAutoApprove` per-platform fast-path is no longer
 * consulted. The setting is kept on `UserSettings` for now (the
 * PipelinePanel UI still renders the checkboxes) so saved user
 * configurations don't get blown away — wiring will be cleaned up
 * in a follow-up. Any platforms array — empty or not — returns
 * `'pending_approval'`.
 */
export function resolvePipelinePostStatus(
  _platforms: string[],
  _config: AutoApproveMap | undefined,
): 'scheduled' | 'pending_approval' {
  return 'pending_approval';
}


/**
 * Counts future scheduled posts within a lookahead window.
 * Excludes posted/failed entries; counts pending_approval, scheduled, and
 * status-undefined posts whose datetime falls in [now, now+daysAhead].
 */
export function countFutureScheduledPosts(
  posts: ScheduledPost[] | undefined,
  daysAhead: number,
): number {
  if (!posts || posts.length === 0) return 0;
  const now = Date.now();
  const horizon = now + daysAhead * 24 * 60 * 60 * 1000;
  return posts.filter(p => {
    if (p.status === 'posted' || p.status === 'failed' || p.status === 'rejected') return false;
    const t = new Date(`${p.date}T${p.time}:00`).getTime();
    return t >= now && t <= horizon;
  }).length;
}

/**
 * V040-HOTFIX-001: legacy-user migration shim.
 *
 * Applied once on settings load. If `pipelineAutoApprove` is absent
 * from the saved payload (the case for every 0.3.x user on first
 * upgrade), persist an explicit auto-everywhere map. This:
 *   1. Locks in the user's pre-upgrade behavior — every platform stays
 *      auto-approved even if the future shifts the runtime default.
 *   2. Makes the user's choices visible in the PipelinePanel checkbox
 *      grid instead of hiding them behind undefined-fallback semantics.
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
 */
export function applySettingsMigrations<
  T extends {
    pipelineAutoApprove?: AutoApproveMap;
    useDirectorPipeline?: boolean;
    directorPipelineUserSet?: boolean;
    activeAiAgent?: string;
    aiAgentProvider?: string;
  },
>(settings: T): T {
  return applyV160DirectorDefaultMigration(
    applyV040AutoApproveMigration(applyM33AiAgentFlip(settings)),
  );
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

/** Hard timeout error thrown by the per-idea race in usePipelineDaemon. */
export class IdeaTimeoutError extends Error {
  readonly kind = 'timeout' as const;
  constructor() {
    super('__IDEA_TIMEOUT__');
    this.name = 'IdeaTimeoutError';
  }
}

/**
 * PIPELINE-CONT-V2 — three possible per-cycle decisions for the daemon's
 * continuous-mode block.
 *
 *   continue-not-filled  — horizon has gaps in `scheduled` posts; generate more
 *   continue-pending     — horizon's `scheduled` count meets target but there
 *                          are still `pending_approval` posts in flight; keep
 *                          generating because pending posts won't publish
 *                          until the user approves them
 *   sleep-confirmed      — horizon is fully scheduled (publishable) AND no
 *                          posts are awaiting approval; sleep `interval`
 *                          minutes before the next week
 */
export type ContinuousBranch =
  | 'continue-not-filled'
  | 'continue-pending'
  | 'sleep-confirmed';

/**
 * Pure decision function used by the daemon's continuous-mode block.
 * Lifted out of the hook so the contract is tested against the actual
 * production code rather than a mirror — see V091-QA-FOLLOWUP.
 */
export function pickContinuousBranch(fill: WeekFillStatus): ContinuousBranch {
  if (!fill.filled) return 'continue-not-filled';
  if (fill.pendingApprovalTotal > 0) return 'continue-pending';
  return 'sleep-confirmed';
}
