// @vitest-environment jsdom
//
// V060-003: Settings → Updates section. Pins the user-visible behavior
// when the updater check throws — specifically the BUG-ACL-005 case
// where tauri-plugin-updater raises "plugin:updater|check not allowed
// by ACL" on Windows.
//
//   - Clicking "Check for updates" stamps the LAST_CHECKED_AT_KEY in
//     localStorage even when the check throws. Previously this only
//     fired on success, so the panel stayed stuck on "Last checked:
//     never" on every load while the ACL bug tripped — which read as
//     "the system never tried" when it actually had.
//   - When the thrown message matches the ACL pattern, the section
//     renders the calm 'unavailable' note + "Visit GitHub Releases"
//     link instead of a red error. The user has nothing to action
//     beyond downloading manually, so the warning was misleading.
//   - Non-ACL errors still render in the red 'error' state.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DesktopSettingsPanel } from '@/components/DesktopSettingsPanel';
import { LAST_CHECKED_AT_KEY } from '@/components/UpdateChecker';

let checkImpl: () => Promise<unknown>;

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: () => checkImpl(),
}));

function jsonResponse(data: unknown) {
  return { ok: true, json: async () => data };
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/desktop/config')) {
        return jsonResponse({ isDesktop: true, configPath: '/tmp/c.json', keys: {} });
      }
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('DesktopSettingsPanel — V060-003 update check ACL handling', () => {
  it('records LAST_CHECKED_AT_KEY even when the check throws an ACL error', async () => {
    checkImpl = async () => {
      throw new Error('plugin:updater|check not allowed by ACL');
    };

    render(<DesktopSettingsPanel />);

    const button = await waitFor(() => screen.getByRole('button', { name: /Check for updates/i }));
    expect(localStorage.getItem(LAST_CHECKED_AT_KEY)).toBeNull();

    fireEvent.click(button);

    await waitFor(() => {
      const stamp = localStorage.getItem(LAST_CHECKED_AT_KEY);
      expect(stamp).not.toBeNull();
      expect(Number(stamp)).toBeGreaterThan(0);
    });
  });

  it('renders the calm "unavailable" state with a Releases link on ACL denial — no red AlertCircle', async () => {
    checkImpl = async () => {
      throw new Error('plugin:updater|check not allowed by ACL');
    };

    render(<DesktopSettingsPanel />);

    const button = await waitFor(() => screen.getByRole('button', { name: /Check for updates/i }));
    fireEvent.click(button);

    const note = await waitFor(() =>
      screen.getByRole('status', { name: /unavailable/i }),
    );
    expect(note.textContent).toMatch(/GitHub/i);

    const link = screen.getByRole('link', { name: /Releases/i });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/4neverCompany/MashupForge/releases',
    );

    // The friendly state must not appear in the red 'error' AlertCircle path.
    expect(screen.queryByText(/Auto-update check unavailable —/i)).toBeNull();
  });

  it('keeps red error styling for non-ACL failures (e.g. network error)', async () => {
    checkImpl = async () => {
      throw new Error('NetworkError: failed to fetch update manifest');
    };

    render(<DesktopSettingsPanel />);

    const button = await waitFor(() => screen.getByRole('button', { name: /Check for updates/i }));
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText(/NetworkError/i)).toBeTruthy();
    });

    // No "unavailable" status was used — non-ACL errors stay actionable.
    expect(screen.queryByRole('status', { name: /unavailable/i })).toBeNull();
  });

  it('shows the latest-version success state when the check returns no update', async () => {
    checkImpl = async () => ({
      available: false,
      version: '0.6.0',
    });

    render(<DesktopSettingsPanel />);

    const button = await waitFor(() => screen.getByRole('button', { name: /Check for updates/i }));
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText(/latest version/i)).toBeTruthy();
    });

    // Success path also stamps the timestamp.
    expect(localStorage.getItem(LAST_CHECKED_AT_KEY)).not.toBeNull();
  });
});
