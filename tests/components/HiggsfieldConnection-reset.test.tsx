// V1.1.0-HOTFIX-HIGGSFIELD-RESET: regression test for the always-
// visible "Reset OAuth client" link in the HiggsfieldConnection
// settings panel.
//
// Why: the OAuth 2.0 spec requires the `redirect_uri parameter
// does not match` error to be returned IN THE BROWSER, not via
// redirect to our callback. That means the migration banner
// (which fires only when the URL has `?higgsfield=error&reason=...`)
// never gets a chance to display for that class of failure. The
// user is stranded unless they have a recovery action they can
// trigger from the settings panel itself.
//
// This test pins the contract:
//   1. The "Reset OAuth client" link is ALWAYS visible (not gated
//      on the migration banner).
//   2. Clicking it POSTs to /api/higgsfield/oauth/reset-client.
//   3. After a successful reset, it navigates to the authorize
//      endpoint with `?via=desktop` (in Tauri) or bare (in web)
//      so the next connect registers a fresh client.
//
// The migration-banner path is exercised in the existing
// HiggsfieldConnection component test (if present) and in
// integration tests; this one is the recovery-via-UI-button
// invariant.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, act } from '@testing-library/react';
import { HiggsfieldConnection } from '@/components/Settings/HiggsfieldConnection';

// Mute window.confirm if anything accidentally triggers it.
const origConfirm = window.confirm;
const origLocation = window.location;
beforeEach(() => {
  window.confirm = () => true;
  // jsdom doesn't allow `window.location` reassignment; mock the
  // methods we touch instead. Tests that need to observe the
  // redirect read `window.location.href` after the click.
});
afterEach(() => {
  window.confirm = origConfirm;
  cleanup();
  vi.restoreAllMocks();
});

// Minimal props the component requires; the rest are optional.
const baseProps = {
  selectedImageModel: 'nano_banana_2' as never,
  selectedVideoModel: 'seedance_2_0' as never,
  onSelectImageModel: () => {},
  onSelectVideoModel: () => {},
};

describe('HiggsfieldConnection — always-visible "Reset OAuth client" link', () => {
  it('renders the Reset link regardless of migration banner state', async () => {
    // Mock /api/higgsfield/oauth/status to return a "not connected"
    // payload so the panel mounts the Disconnect-or-Connect button
    // row (where the new Reset link lives) instead of the default
    // "loading…" skeleton.
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/api/higgsfield/oauth/status')) {
        return new Response(JSON.stringify({ connected: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    render(<HiggsfieldConnection {...baseProps} />);
    // The refresh() is fired inside a queueMicrotask; flush so the
    // status update lands before we look for the Reset link.
    await act(async () => {
      await Promise.resolve();
    });

    // The Reset link is always visible (not conditional on the
    // migration banner). Look for the visible label, not the title.
    const link = screen.getByRole('button', { name: /reset oauth client/i });
    expect(link).toBeTruthy();
    // The link is muted (text-white/40) so it doesn't compete with
    // the primary Connect button — but it's definitely there.
    expect(link.className).toContain('text-white/40');
  });

  it('clicking Reset posts to /api/higgsfield/oauth/reset-client and bounces into the authorize flow', async () => {
    let resetPostCalled = 0;
    let lastResetUrl: string | null = null;
    // Track the navigate target after a successful reset.
    let navigatedTo: string | null = null;
    const origLocationHrefSetter = Object.getOwnPropertyDescriptor(
      window.Location.prototype,
      'href',
    );
    Object.defineProperty(window.location, 'href', {
      configurable: true,
      get: () => origLocationHrefSetter?.get?.call(window.location) ?? '',
      set: (v: string) => {
        navigatedTo = v;
      },
    });

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/api/higgsfield/oauth/status')) {
        return new Response(JSON.stringify({ connected: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.endsWith('/api/higgsfield/oauth/reset-client')) {
        resetPostCalled += 1;
        lastResetUrl = u;
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({ ok: true, cleared: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    render(<HiggsfieldConnection {...baseProps} />);
    await act(async () => {
      await Promise.resolve();
    });

    const link = screen.getByRole('button', { name: /reset oauth client/i });
    await act(async () => {
      fireEvent.click(link);
      // Let the POST's promise resolve + the navigation fire.
      await Promise.resolve();
    });

    expect(resetPostCalled).toBe(1);
    expect(lastResetUrl).not.toBeNull();
    // The component redirects to /api/higgsfield/oauth/authorize
    // (no `?via=desktop` in jsdom because the Tauri globals aren't
    // wired in this test env).
    expect(navigatedTo).toMatch(/\/api\/higgsfield\/oauth\/authorize(\?.*)?$/);

    // Restore the location.href setter so we don't leak mocks to
    // other test files in the same suite.
    if (origLocationHrefSetter) {
      Object.defineProperty(window.location, 'href', origLocationHrefSetter);
    }
  });

  it('does NOT show the migration banner reset button when the banner is hidden', async () => {
    // Without `?higgsfield=error&reason=...` in the URL, the banner
    // stays hidden. The amber "Reset OAuth client and retry"
    // button inside the banner should not be in the document — but
    // the always-visible "Reset OAuth client" link MUST still be.
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/api/higgsfield/oauth/status')) {
        return new Response(JSON.stringify({ connected: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    render(<HiggsfieldConnection {...baseProps} />);
    await act(async () => {
      await Promise.resolve();
    });

    // The big amber banner button is named "Reset OAuth client and retry".
    // It should NOT be present without the banner.
    expect(
      screen.queryByRole('button', { name: /reset oauth client and retry/i }),
    ).toBeNull();

    // The always-visible small link is named "Reset OAuth client" and
    // IS present.
    expect(
      screen.getByRole('button', { name: /reset oauth client$/i }),
    ).toBeTruthy();
  });
});
