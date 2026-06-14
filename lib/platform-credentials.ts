// V041-HOTFIX-IG: single source of truth for "is this platform configured".
//
// Pre-fix, PipelinePanel and pipeline-processor each had their own answer.
// PipelinePanel's was correct (settings.apiKeys + desktop config.json).
// pipeline-processor's was a naive `Object.entries(apiKeys).filter(([k, v]) => v)`
// which (a) treated `{ accessToken: '', igAccountId: '' }` as configured and
// (b) had no idea desktop creds existed. Result: desktop users with IG creds
// in config.json saw "No platforms configured" because their UserSettings
// apiKeys.instagram was undefined.

import type { UserSettings } from '@/types/mashup';

export type PipelinePlatform = 'instagram' | 'pinterest' | 'twitter' | 'discord';

/**
 * Boolean presence flags for credentials stored in the desktop config.json.
 * Matches the shape returned by useDesktopConfig — defined here so both the
 * hook and pure-function pipeline code can share it without lib/ -> hooks/ cycles.
 */
export interface DesktopCredentialFlags {
  hasInstagramToken: boolean;
  hasInstagramAccountId: boolean;
  hasLeonardoKey: boolean;
  hasZaiKey: boolean;
  hasTwitterCreds: boolean;
  hasPinterestCreds: boolean;
  hasDiscordCreds: boolean;
}

export function isPlatformConfigured(
  platform: PipelinePlatform,
  settings: UserSettings,
  desktopCreds?: DesktopCredentialFlags,
): boolean {
  const ig = settings.apiKeys?.instagram;
  const tw = settings.apiKeys?.twitter;
  const pn = settings.apiKeys?.pinterest;
  switch (platform) {
    case 'instagram':
      if (ig?.accessToken && ig?.igAccountId) return true;
      if (desktopCreds?.hasInstagramToken && desktopCreds?.hasInstagramAccountId) return true;
      return false;
    case 'pinterest':
      if (pn?.accessToken) return true;
      if (desktopCreds?.hasPinterestCreds) return true;
      return false;
    case 'twitter':
      if (tw?.appKey && tw?.appSecret && tw?.accessToken && tw?.accessSecret) return true;
      if (desktopCreds?.hasTwitterCreds) return true;
      return false;
    case 'discord':
      if (settings.apiKeys?.discordWebhook) return true;
      if (desktopCreds?.hasDiscordCreds) return true;
      return false;
  }
}

const ALL_PLATFORMS: readonly PipelinePlatform[] = [
  'instagram',
  'pinterest',
  'twitter',
  'discord',
];

export function configuredPlatforms(
  settings: UserSettings,
  desktopCreds?: DesktopCredentialFlags,
): PipelinePlatform[] {
  return ALL_PLATFORMS.filter((p) => isPlatformConfigured(p, settings, desktopCreds));
}
