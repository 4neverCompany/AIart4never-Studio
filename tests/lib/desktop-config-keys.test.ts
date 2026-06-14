import { describe, it, expect } from 'vitest';
import { DESKTOP_CONFIG_KEYS } from '@/lib/desktop-config-keys';

// INSTAGRAM-CRED-FIX regression gate. The Instagram credential
// persistence fix depends on these two keys being present in
// DESKTOP_CONFIG_KEYS so (a) DesktopSettingsPanel auto-renders their
// KeyField inputs, (b) /api/desktop/config PATCH round-trips them to
// config.json, and (c) tauri-server-wrapper.js hydrates them into
// process.env at sidecar boot. If any future edit drops them, IG
// credentials silently revert to being persisted in origin-scoped
// IndexedDB and Maurice's "credentials wiped on restart" bug returns.
describe('DESKTOP_CONFIG_KEYS', () => {
  const keyNames = DESKTOP_CONFIG_KEYS.map((k) => k.key);

  it('includes LEONARDO_API_KEY', () => {
    expect(keyNames).toContain('LEONARDO_API_KEY');
  });

  it('includes ZAI_API_KEY', () => {
    expect(keyNames).toContain('ZAI_API_KEY');
  });

  it('includes INSTAGRAM_ACCOUNT_ID (INSTAGRAM-CRED-FIX)', () => {
    expect(keyNames).toContain('INSTAGRAM_ACCOUNT_ID');
  });

  it('includes INSTAGRAM_ACCESS_TOKEN (INSTAGRAM-CRED-FIX)', () => {
    expect(keyNames).toContain('INSTAGRAM_ACCESS_TOKEN');
  });

  it('includes Twitter OAuth 1.0a keys (CRED-001)', () => {
    expect(keyNames).toContain('TWITTER_APP_KEY');
    expect(keyNames).toContain('TWITTER_APP_SECRET');
    expect(keyNames).toContain('TWITTER_ACCESS_TOKEN');
    expect(keyNames).toContain('TWITTER_ACCESS_SECRET');
  });

  it('includes Pinterest keys (CRED-001)', () => {
    expect(keyNames).toContain('PINTEREST_ACCESS_TOKEN');
    expect(keyNames).toContain('PINTEREST_BOARD_ID');
  });

  it('includes Discord webhook URL (CRED-001)', () => {
    expect(keyNames).toContain('DISCORD_WEBHOOK_URL');
  });

  it('includes BRAVE_API_KEY (web-search provider)', () => {
    expect(keyNames).toContain('BRAVE_API_KEY');
  });

  it('includes SERPER_API_KEY (default web-search provider)', () => {
    expect(keyNames).toContain('SERPER_API_KEY');
  });

  it('every entry has a non-empty label and hint', () => {
    for (const entry of DESKTOP_CONFIG_KEYS) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.hint.length).toBeGreaterThan(0);
    }
  });

  it('every key is a SCREAMING_SNAKE_CASE env-var name', () => {
    for (const { key } of DESKTOP_CONFIG_KEYS) {
      expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('contains no duplicate keys', () => {
    const unique = new Set(keyNames);
    expect(unique.size).toBe(keyNames.length);
  });
});
