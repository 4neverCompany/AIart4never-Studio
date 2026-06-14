// @vitest-environment jsdom
//
// V060-002 / V1.9.2 (#47b): Desktop tab platform toggles. Pins the
// user-visible behavior of the Platforms section in DesktopSettingsPanel:
//   - All four platforms (incl. Instagram since #47b) render a compact row
//     with an enable toggle; their fields render only when the toggle is ON.
//   - Existing creds default a platform ON (graceful migration), so an
//     Instagram user upgrading from a build where IG was always-on keeps
//     IG enabled and its fields visible.
//   - First load with empty config: non-core platforms default OFF.
//   - First load with creds already in config.json: graceful migration
//     keeps the platform expanded so the user's stored keys stay visible.
//   - Toggling fires a PATCH to /api/desktop/config that writes the
//     enable flag — disabled platforms persist as '0', enabled as '1'.
//   - Toggling OFF does NOT wipe the stored API keys; only the
//     enable flag changes.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DesktopSettingsPanel } from '@/components/DesktopSettingsPanel';

interface MockResponse {
  ok: boolean;
  json: () => Promise<unknown>;
}

function jsonResponse(data: unknown, ok = true): MockResponse {
  return { ok, json: async () => data };
}

let fetchMock: ReturnType<typeof vi.fn>;
let patchedBodies: Array<Record<string, unknown>>;
let configStore: Record<string, string>;

function installFetchMock(initialKeys: Record<string, string>) {
  configStore = { ...initialKeys };
  patchedBodies = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/desktop/config') && (!init || !init.method || init.method === 'GET')) {
      return jsonResponse({
        isDesktop: true,
        configPath: '/tmp/config.json',
        keys: { ...configStore },
      });
    }
    if (url.endsWith('/api/desktop/config') && init?.method === 'PATCH') {
      const body = JSON.parse(init.body as string) as { keys: Record<string, string> };
      patchedBodies.push(body.keys);
      for (const [k, v] of Object.entries(body.keys)) {
        if (typeof v === 'string' && v.length > 0) configStore[k] = v;
        else delete configStore[k];
      }
      return jsonResponse({ success: true, configPath: '/tmp/config.json', savedKeys: Object.keys(configStore) });
    }
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  patchedBodies = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DesktopSettingsPanel — V060-002 platform toggles', () => {
  it('renders an Instagram toggle (OFF on empty config) and reveals fields when enabled', async () => {
    installFetchMock({});
    render(<DesktopSettingsPanel />);

    // V1.9.2 (#47b): Instagram is now toggleable. Empty config → no creds →
    // defaults OFF, fields hidden, just like the other platforms.
    const toggle = await waitFor(() => screen.getByLabelText('Enable Instagram'));
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByText('Instagram Account ID')).toBeNull();

    // Enabling reveals the credential fields.
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByLabelText('Disable Instagram')).toBeTruthy();
    });
    expect(screen.getByText('Instagram Account ID')).toBeTruthy();
    expect(screen.getByText('Instagram Access Token')).toBeTruthy();
  });

  it('graceful migration: an existing Instagram setup stays enabled + expanded', async () => {
    installFetchMock({ INSTAGRAM_ACCESS_TOKEN: 'tok', INSTAGRAM_ACCOUNT_ID: 'acct' });
    render(<DesktopSettingsPanel />);

    // Pre-#47b users had IG always-on with creds — after the change those
    // creds default the platform ON so nothing disappears on upgrade.
    await waitFor(() => {
      expect(screen.getByLabelText('Disable Instagram')).toBeTruthy();
    });
    expect(screen.getByText('Instagram Account ID')).toBeTruthy();
  });

  it('renders Twitter / Pinterest / Discord toggles in OFF state when config is empty', async () => {
    installFetchMock({});
    render(<DesktopSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByLabelText('Enable Twitter / X')).toBeTruthy();
    });

    expect(screen.getByLabelText('Enable Pinterest')).toBeTruthy();
    expect(screen.getByLabelText('Enable Discord')).toBeTruthy();

    // Fields hidden while OFF
    expect(screen.queryByText('Twitter App Key')).toBeNull();
    expect(screen.queryByText('Pinterest Access Token')).toBeNull();
    expect(screen.queryByText('Discord Webhook URL')).toBeNull();
  });

  it('expands a group when its toggle is clicked and persists the enable flag', async () => {
    installFetchMock({});
    render(<DesktopSettingsPanel />);

    const toggle = await waitFor(() => screen.getByLabelText('Enable Twitter / X'));
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByLabelText('Disable Twitter / X')).toBeTruthy();
    });

    // Twitter fields now visible
    expect(screen.getByText('Twitter App Key')).toBeTruthy();
    expect(screen.getByText('Twitter App Secret')).toBeTruthy();

    // Auto-save fires after the 800ms debounce window — wait for the PATCH
    await waitFor(
      () => {
        expect(patchedBodies.length).toBeGreaterThan(0);
      },
      { timeout: 2000 },
    );
    const last = patchedBodies[patchedBodies.length - 1];
    expect(last.TWITTER_ENABLED).toBe('1');
  });

  it('graceful migration: existing creds keep the platform expanded on first load', async () => {
    installFetchMock({ TWITTER_APP_KEY: 'preexisting' });
    render(<DesktopSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByLabelText('Disable Twitter / X')).toBeTruthy();
    });

    // Fields visible because the platform defaulted ON from existing creds
    expect(screen.getByText('Twitter App Key')).toBeTruthy();
  });

  it('disabling a platform writes "0" without wiping the stored API keys', async () => {
    installFetchMock({ TWITTER_APP_KEY: 'preexisting', TWITTER_ENABLED: '1' });
    render(<DesktopSettingsPanel />);

    const toggle = await waitFor(() => screen.getByLabelText('Disable Twitter / X'));

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByLabelText('Enable Twitter / X')).toBeTruthy();
    });

    // Fields collapsed
    expect(screen.queryByText('Twitter App Key')).toBeNull();

    await waitFor(
      () => {
        expect(patchedBodies.length).toBeGreaterThan(0);
      },
      { timeout: 2000 },
    );
    const last = patchedBodies[patchedBodies.length - 1];
    // Toggle flip persisted as '0'
    expect(last.TWITTER_ENABLED).toBe('0');
    // Existing creds preserved in the patch — the user's stored key is
    // round-tripped, not blanked. The toggle is a visibility flag, not a wipe.
    expect(last.TWITTER_APP_KEY).toBe('preexisting');
  });
});
