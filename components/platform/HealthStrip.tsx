'use client';

/**
 * V040-007 — sidebar-bottom platform health strip.
 * Derives a HealthState per platform from existing UserSettings data
 * (apiKeys for credential presence, scheduledPosts for last-post /
 * last-failure / queue-depth), renders a row of four HealthDots.
 *
 * Exports two variants:
 *  - `HealthStrip` — full-width, labels visible; mounts in the open
 *    sidebar footer.
 *  - `HealthMiniRail` — dots-only column/row for a future collapsed-
 *    sidebar state (currently unmounted — the sidebar has no
 *    collapsed-icon variant yet, see V040-007 review).
 *
 * No new schema, no active credential pings. Token validation is
 * flagged in the spec as a separate future PROP.
 */

import React, { useMemo } from 'react';
import { useMashup } from '../MashupContext';
import { HealthDot, type HealthState } from './HealthDot';
import type { ScheduledPost } from '@/types/mashup';
import { useDesktopConfig } from '@/hooks/useDesktopConfig';
import { isPlatformConfigured } from '@/lib/platform-credentials';

type PlatformKey = 'instagram' | 'pinterest' | 'twitter' | 'discord';

interface PlatformSpec {
  key: PlatformKey;
  code: 'IG' | 'PN' | 'TW' | 'DC';
  label: string;
}

const PLATFORMS: PlatformSpec[] = [
  { key: 'instagram', code: 'IG', label: 'Instagram' },
  { key: 'pinterest', code: 'PN', label: 'Pinterest' },
  { key: 'twitter', code: 'TW', label: 'Twitter' },
  { key: 'discord', code: 'DC', label: 'Discord' },
];

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const formatRelative = (ms: number): string => {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < ONE_DAY_MS) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / ONE_DAY_MS)}d ago`;
};

const postTimestamp = (p: ScheduledPost): number => {
  const t = new Date(`${p.date}T${p.time}:00`).getTime();
  return Number.isFinite(t) ? t : 0;
};

interface Derived {
  state: HealthState;
  detail: string;
}

const derive = (
  platform: PlatformKey,
  credsPresent: boolean,
  inPipeline: boolean,
  posts: ScheduledPost[],
): Derived => {
  const owned = posts.filter((p) => (p.platforms || []).includes(platform));
  const queueDepth = owned.filter((p) => p.status === 'scheduled').length;

  let lastPostedTs = 0;
  let lastFailedTs = 0;
  for (const p of owned) {
    const ts = postTimestamp(p);
    if (ts === 0) continue;
    if (p.status === 'posted' && ts > lastPostedTs) lastPostedTs = ts;
    if (p.status === 'failed' && ts > lastFailedTs) lastFailedTs = ts;
  }

  const anyActivity = lastPostedTs > 0 || queueDepth > 0 || owned.length > 0;

  if (!credsPresent) {
    if (inPipeline) {
      return { state: 'broken', detail: 'Missing credentials — platform enabled in pipeline' };
    }
    if (!anyActivity) {
      return { state: 'unused', detail: 'Not configured · not in pipeline' };
    }
    return { state: 'broken', detail: 'Missing credentials — posts exist for this platform' };
  }

  if (lastFailedTs > lastPostedTs && lastFailedTs > 0) {
    return {
      state: 'broken',
      detail: `Last post failed ${formatRelative(lastFailedTs)} · ${queueDepth} in queue`,
    };
  }

  if (lastPostedTs > 0 && Date.now() - lastPostedTs <= ONE_DAY_MS) {
    return {
      state: 'healthy',
      detail: `Last post: ${formatRelative(lastPostedTs)} · ${queueDepth} in queue`,
    };
  }

  return {
    state: 'stale',
    detail:
      lastPostedTs === 0
        ? `Configured but unused · ${queueDepth} in queue`
        : `Last post: ${formatRelative(lastPostedTs)} · credentials may have expired`,
  };
};

const usePlatformHealth = () => {
  const { settings } = useMashup();
  // Desktop creds (config.json) are an alternative source of truth for the
  // Tauri shell — without consulting them, IG configured via the desktop
  // settings panel reads as "Missing credentials" (BUG-UI-008). Single
  // source of truth: lib/platform-credentials.isPlatformConfigured.
  const { credentials: desktopCreds, platformEnabled } = useDesktopConfig();
  return useMemo(() => {
    const posts = settings.scheduledPosts || [];
    const inPipeline = new Set(settings.pipelinePlatforms || []);
    return PLATFORMS.map((p) => {
      // V1.9.2 (#48): a platform the user turned OFF in Desktop settings keeps
      // its creds on disk, so the credential check below would still read it as
      // "configured" (or "missing creds" if removed) and show a red dot. A
      // disabled platform is simply off — render it as neutral/unused, never
      // as a "not set up" warning.
      if (!platformEnabled[p.key]) {
        return { ...p, state: 'unused' as HealthState, detail: 'Disabled in Desktop settings' };
      }
      const credsPresent = isPlatformConfigured(p.key, settings, desktopCreds);
      const { state, detail } = derive(p.key, credsPresent, inPipeline.has(p.key), posts);
      return { ...p, state, detail };
    });
  }, [settings, desktopCreds, platformEnabled]);
};

export const HealthStrip: React.FC = () => {
  const health = usePlatformHealth();
  const anyConfigured = health.some((h) => h.state !== 'unused');
  if (!anyConfigured) return null;
  return (
    <div
      role="status"
      aria-label="Platform health"
      aria-live="polite"
      className="px-3 py-2 border-t border-zinc-800/70 bg-zinc-950/60 flex items-center gap-1"
    >
      {health.map((h) => (
        <HealthDot
          key={h.key}
          code={h.code}
          platformLabel={h.label}
          state={h.state}
          detail={h.detail}
        />
      ))}
    </div>
  );
};

export const HealthMiniRail: React.FC = () => {
  const health = usePlatformHealth();
  const anyConfigured = health.some((h) => h.state !== 'unused');
  if (!anyConfigured) return null;
  return (
    <div
      role="status"
      aria-label="Platform health"
      className="flex flex-col items-center gap-1 py-2"
    >
      {health.map((h) => (
        <HealthDot
          key={h.key}
          code={h.code}
          platformLabel={h.label}
          state={h.state}
          detail={h.detail}
          compact
        />
      ))}
    </div>
  );
};
