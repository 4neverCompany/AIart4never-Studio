'use client';

// IG-FB-TOKEN-REFRESH (client): expiry-window check + auto-refresh helper.
//
// Pairs with /api/social/refresh-token. The route is stateless and
// returns the new Facebook Page Access Token; THIS module is what
// decides when to call the route and where to store the result.
//
// Refresh policy:
//   - Facebook long-lived Page Access Tokens are good for ~60 days.
//   - Schedule a refresh when the token is within 7 days of expiry.
//   - On app start, read the stored token + its expiresAt. If
//     expiresAt - now < 7 days, call /api/social/refresh-token with
//     the current token and persist the response.
//
// Storage:
//   - Desktop: tauri-plugin-store via lib/persistence (BUG-DEV-012
//     abstraction that survives WebView2 folder moves).
//   - Web: idb-keyval via the same lib/persistence wrapper.
//
// Integration:
//   The actual "call on app start" wiring is a follow-up. The
//   integration point is the root layout's mount effect, or a
//   startup task in the desktop main process. This module just
//   exposes the function — callers import `checkAndRefreshToken`
//   and invoke it once per app load.

import { get as persistenceGet, set as persistenceSet } from './persistence';

const SETTINGS_KEY = 'mashup_settings';
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface InstagramTokenState {
  /** EAA-prefixed Facebook Page Access Token. */
  accessToken: string;
  /** Numeric Instagram Business Account ID. */
  igAccountId: string;
  /** Unix ms when the token expires. Optional for legacy configs. */
  expiresAt?: number;
}

export type RefreshResult =
  | { kind: 'skipped'; reason: 'no-token' | 'not-near-expiry' | 'not-in-browser' }
  | { kind: 'refreshed'; token: InstagramTokenState }
  | { kind: 'failed'; error: string };

/**
 * Read the current Instagram credentials from persistence.
 * Returns null if the user hasn't configured Instagram yet.
 */
export async function readInstagramTokenState(): Promise<InstagramTokenState | null> {
  try {
    const settings = await persistenceGet<{
      apiKeys?: { instagram?: InstagramTokenState };
    }>(SETTINGS_KEY);
    const ig = settings?.apiKeys?.instagram;
    if (!ig?.accessToken || !ig?.igAccountId) return null;
    return ig;
  } catch {
    return null;
  }
}

/**
 * Write the new Instagram credentials back to persistence. Mirrors
 * the mergeSettings shape used by useSettings so a partial update
 * doesn't clobber unrelated fields.
 */
async function writeInstagramTokenState(next: InstagramTokenState): Promise<void> {
  const current = (await persistenceGet<Record<string, unknown>>(SETTINGS_KEY)) ?? {};
  const apiKeys = (current.apiKeys as Record<string, unknown> | undefined) ?? {};
  await persistenceSet(SETTINGS_KEY, {
    ...current,
    apiKeys: { ...apiKeys, instagram: next },
  });
}

/**
 * If the stored Instagram token is within REFRESH_WINDOW_MS of its
 * `expiresAt`, call /api/social/refresh-token and persist the new
 * token + expiresAt. Returns a tagged union describing what happened.
 *
 * Safe to call on every app start. No-op if the token is fresh or
 * if the user hasn't connected Instagram yet.
 *
 * The route is auth-protected with CRON_SHARED_SECRET — the desktop
 * app reads it from `tauri-plugin-store` (or the env at build time
 * for web) and forwards it as a Bearer header.
 */
export async function checkAndRefreshToken(
  refreshEndpoint: string = '/api/social/refresh-token',
  sharedSecret?: string,
): Promise<RefreshResult> {
  if (typeof window === 'undefined') {
    return { kind: 'skipped', reason: 'not-in-browser' };
  }

  const current = await readInstagramTokenState();
  if (!current) return { kind: 'skipped', reason: 'no-token' };

  // Legacy configs (pre-refresh-flow) have no expiresAt — assume
  // the token is mid-life and skip the refresh check. The user
  // can manually trigger a refresh via the Settings panel.
  if (typeof current.expiresAt !== 'number') {
    return { kind: 'skipped', reason: 'not-near-expiry' };
  }

  const timeRemaining = current.expiresAt - Date.now();
  if (timeRemaining > REFRESH_WINDOW_MS) {
    return { kind: 'skipped', reason: 'not-near-expiry' };
  }

  try {
    const res = await fetch(refreshEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sharedSecret ? { Authorization: `Bearer ${sharedSecret}` } : {}),
      },
      body: JSON.stringify({ accessToken: current.accessToken }),
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const data = (await res.json()) as { error?: string };
        if (data?.error) detail = `${detail}: ${data.error}`;
      } catch {
        // Non-JSON body — stick with the status code.
      }
      return { kind: 'failed', error: detail };
    }

    const data = (await res.json()) as {
      accessToken: string;
      expiresIn: number;
      expiresAt: number;
    };

    if (!data.accessToken || !data.expiresAt) {
      return { kind: 'failed', error: 'Refresh endpoint returned an empty token' };
    }

    const next: InstagramTokenState = {
      accessToken: data.accessToken,
      igAccountId: current.igAccountId,
      expiresAt: data.expiresAt,
    };
    await writeInstagramTokenState(next);
    return { kind: 'refreshed', token: next };
  } catch (e) {
    return { kind: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Force a refresh regardless of the expiry window. Used by the
 * Settings panel "Refresh now" button so the user can recover from
 * a token that already expired.
 */
export async function forceRefreshToken(
  refreshEndpoint: string = '/api/social/refresh-token',
  sharedSecret?: string,
): Promise<RefreshResult> {
  if (typeof window === 'undefined') {
    return { kind: 'skipped', reason: 'not-in-browser' };
  }

  const current = await readInstagramTokenState();
  if (!current) return { kind: 'skipped', reason: 'no-token' };

  // Inline the refresh call so we don't have to fake an expiresAt
  // to bypass the window check.
  try {
    const res = await fetch(refreshEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sharedSecret ? { Authorization: `Bearer ${sharedSecret}` } : {}),
      },
      body: JSON.stringify({ accessToken: current.accessToken }),
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const data = (await res.json()) as { error?: string };
        if (data?.error) detail = `${detail}: ${data.error}`;
      } catch {
        // Non-JSON — status code is the only signal we have.
      }
      return { kind: 'failed', error: detail };
    }

    const data = (await res.json()) as {
      accessToken: string;
      expiresIn: number;
      expiresAt: number;
    };

    if (!data.accessToken || !data.expiresAt) {
      return { kind: 'failed', error: 'Refresh endpoint returned an empty token' };
    }

    const next: InstagramTokenState = {
      accessToken: data.accessToken,
      igAccountId: current.igAccountId,
      expiresAt: data.expiresAt,
    };
    await writeInstagramTokenState(next);
    return { kind: 'refreshed', token: next };
  } catch (e) {
    return { kind: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}
