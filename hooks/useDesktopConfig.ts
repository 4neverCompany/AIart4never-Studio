'use client';

import { useEffect, useState } from 'react';
import type { DesktopCredentialFlags } from '@/lib/platform-credentials';
import { PLATFORM_GROUPS, isPlatformEnabled } from '@/lib/desktop-config-keys';

export type { DesktopCredentialFlags };

/** Per-platform enable state from the desktop config.json toggles. */
export type PlatformEnabledMap = Record<'instagram' | 'pinterest' | 'twitter' | 'discord', boolean>;

export interface DesktopConfig {
  isDesktop: boolean | null;
  credentials: DesktopCredentialFlags;
  /**
   * V1.9.2 (#48): per-platform enable state. On desktop it reflects the
   * config.json `*_ENABLED` toggles so UI can stop warning about platforms
   * the user deliberately turned off (a disabled platform keeps its creds on
   * disk, so credential-presence checks alone read it as "configured" and the
   * health strip showed a red "not set up" dot). On web there is no config.json
   * so all platforms default to enabled (web gates on settings.apiKeys instead).
   */
  platformEnabled: PlatformEnabledMap;
}

const EMPTY_FLAGS: DesktopCredentialFlags = {
  hasInstagramToken: false,
  hasInstagramAccountId: false,
  hasLeonardoKey: false,
  hasZaiKey: false,
  hasTwitterCreds: false,
  hasPinterestCreds: false,
  hasDiscordCreds: false,
};

const ALL_ENABLED: PlatformEnabledMap = {
  instagram: true,
  pinterest: true,
  twitter: true,
  discord: true,
};

function toPlatformEnabled(keys: Record<string, string>): PlatformEnabledMap {
  const out: PlatformEnabledMap = { ...ALL_ENABLED };
  for (const g of PLATFORM_GROUPS) {
    out[g.id] = isPlatformEnabled(g, keys);
  }
  return out;
}

function toFlags(keys: Record<string, string>): DesktopCredentialFlags {
  return {
    hasInstagramToken: Boolean(keys.INSTAGRAM_ACCESS_TOKEN),
    hasInstagramAccountId: Boolean(keys.INSTAGRAM_ACCOUNT_ID),
    hasLeonardoKey: Boolean(keys.LEONARDO_API_KEY),
    hasZaiKey: Boolean(keys.ZAI_API_KEY),
    hasTwitterCreds: Boolean(
      keys.TWITTER_APP_KEY && keys.TWITTER_APP_SECRET &&
      keys.TWITTER_ACCESS_TOKEN && keys.TWITTER_ACCESS_SECRET,
    ),
    hasPinterestCreds: Boolean(keys.PINTEREST_ACCESS_TOKEN),
    hasDiscordCreds: Boolean(keys.DISCORD_WEBHOOK_URL),
  };
}

/**
 * Fetches desktop config once on mount and exposes boolean credential-presence
 * flags — raw token values never enter React state.  DesktopSettingsPanel
 * reads the full GET response directly; this hook is for UI gating only.
 */
export function useDesktopConfig(): DesktopConfig {
  const [config, setConfig] = useState<DesktopConfig>({
    isDesktop: null,
    credentials: EMPTY_FLAGS,
    platformEnabled: ALL_ENABLED,
  });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/desktop/config')
      .then((r) => r.json() as Promise<{ isDesktop?: boolean; keys?: Record<string, string> }>)
      .then((data) => {
        if (!cancelled) {
          const isDesktop = Boolean(data?.isDesktop);
          const keys = data?.keys && typeof data.keys === 'object' ? data.keys : {};
          setConfig({
            isDesktop,
            credentials: toFlags(keys),
            // Only the desktop config.json carries the *_ENABLED toggles. On
            // web there are no keys, so leave everything enabled and let the
            // settings.apiKeys-based checks decide.
            platformEnabled: isDesktop ? toPlatformEnabled(keys) : ALL_ENABLED,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setConfig({ isDesktop: false, credentials: EMPTY_FLAGS, platformEnabled: ALL_ENABLED });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}
