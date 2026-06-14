// V041-HOTFIX-IG: shared platform-availability helper consolidates the
// PipelinePanel hasCreds() check and pipeline-processor inferredPlatforms
// derivation, both of which previously diverged (the latter ignored desktop
// config.json creds entirely).

import { describe, it, expect } from 'vitest';
import {
  configuredPlatforms,
  isPlatformConfigured,
  type DesktopCredentialFlags,
} from '@/lib/platform-credentials';
import type { UserSettings } from '@/types/mashup';

const EMPTY_DESKTOP: DesktopCredentialFlags = {
  hasInstagramToken: false,
  hasInstagramAccountId: false,
  hasLeonardoKey: false,
  hasZaiKey: false,
  hasTwitterCreds: false,
  hasPinterestCreds: false,
  hasDiscordCreds: false,
};

function mkSettings(apiKeys: UserSettings['apiKeys']): UserSettings {
  return {
    enabledProviders: ['leonardo'],
    apiKeys,
    defaultLeonardoModel: 'phoenix',
  };
}

describe('isPlatformConfigured — Instagram', () => {
  it('true when settings.apiKeys.instagram has both fields', () => {
    const s = mkSettings({ instagram: { accessToken: 'tok', igAccountId: 'id' } });
    expect(isPlatformConfigured('instagram', s)).toBe(true);
  });

  it('false when settings.apiKeys.instagram is { accessToken: "", igAccountId: "" }', () => {
    // Pre-fix bug: pipeline-processor treated this as "configured" because
    // the object itself was truthy. The shared helper must field-validate.
    const s = mkSettings({ instagram: { accessToken: '', igAccountId: '' } });
    expect(isPlatformConfigured('instagram', s)).toBe(false);
  });

  it('false when settings.apiKeys.instagram has only one field', () => {
    const s = mkSettings({ instagram: { accessToken: 'tok', igAccountId: '' } });
    expect(isPlatformConfigured('instagram', s)).toBe(false);
  });

  it('true when desktop creds present but settings.apiKeys.instagram absent', () => {
    // The actual user-reported V041 bug: IG creds in config.json (desktop),
    // settings.apiKeys.instagram is undefined, pipeline must still detect IG.
    const s = mkSettings({});
    const desktop: DesktopCredentialFlags = {
      ...EMPTY_DESKTOP,
      hasInstagramToken: true,
      hasInstagramAccountId: true,
    };
    expect(isPlatformConfigured('instagram', s, desktop)).toBe(true);
  });

  it('false when desktop only has token but missing account id', () => {
    const s = mkSettings({});
    const desktop: DesktopCredentialFlags = {
      ...EMPTY_DESKTOP,
      hasInstagramToken: true,
      hasInstagramAccountId: false,
    };
    expect(isPlatformConfigured('instagram', s, desktop)).toBe(false);
  });
});

describe('isPlatformConfigured — Pinterest / Twitter / Discord', () => {
  it('pinterest true via settings, true via desktop, false otherwise', () => {
    expect(isPlatformConfigured('pinterest', mkSettings({ pinterest: { accessToken: 'p' } }))).toBe(true);
    expect(isPlatformConfigured('pinterest', mkSettings({}), { ...EMPTY_DESKTOP, hasPinterestCreds: true })).toBe(true);
    expect(isPlatformConfigured('pinterest', mkSettings({}))).toBe(false);
  });

  it('twitter requires all four OAuth1 fields in settings', () => {
    const partial = mkSettings({
      twitter: { appKey: 'a', appSecret: 'b', accessToken: 'c', accessSecret: '' },
    });
    expect(isPlatformConfigured('twitter', partial)).toBe(false);
    const full = mkSettings({
      twitter: { appKey: 'a', appSecret: 'b', accessToken: 'c', accessSecret: 'd' },
    });
    expect(isPlatformConfigured('twitter', full)).toBe(true);
  });

  it('twitter true via desktop creds bag', () => {
    expect(isPlatformConfigured('twitter', mkSettings({}), { ...EMPTY_DESKTOP, hasTwitterCreds: true })).toBe(true);
  });

  it('discord true via discordWebhook string OR desktop flag', () => {
    expect(isPlatformConfigured('discord', mkSettings({ discordWebhook: 'https://...' }))).toBe(true);
    expect(isPlatformConfigured('discord', mkSettings({}), { ...EMPTY_DESKTOP, hasDiscordCreds: true })).toBe(true);
    expect(isPlatformConfigured('discord', mkSettings({}))).toBe(false);
  });
});

describe('configuredPlatforms', () => {
  it('returns platforms in fixed order, deduped against the credential sources', () => {
    const s = mkSettings({
      discordWebhook: 'wh',
      instagram: { accessToken: 't', igAccountId: 'id' },
    });
    expect(configuredPlatforms(s)).toEqual(['instagram', 'discord']);
  });

  it('merges settings + desktop creds without double-counting', () => {
    const s = mkSettings({ instagram: { accessToken: 't', igAccountId: 'id' } });
    const desktop: DesktopCredentialFlags = {
      ...EMPTY_DESKTOP,
      hasInstagramToken: true,
      hasInstagramAccountId: true,
      hasPinterestCreds: true,
    };
    expect(configuredPlatforms(s, desktop)).toEqual(['instagram', 'pinterest']);
  });

  it('returns [] when nothing is configured anywhere', () => {
    expect(configuredPlatforms(mkSettings({}))).toEqual([]);
    expect(configuredPlatforms(mkSettings({}), EMPTY_DESKTOP)).toEqual([]);
  });
});
