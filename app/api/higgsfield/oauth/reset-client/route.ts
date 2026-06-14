/**
 * POST /api/higgsfield/oauth/reset-client
 *
 * Wipes the locally-cached `HIGGSFIELD_OAUTH_CLIENT_ID` from desktop
 * config so the next `/authorize` call re-registers a fresh client
 * with the current redirect-URI allowlist.
 *
 * Why: users who connected before v1.0.7.1 have an OAuth client
 * registered without the `mashupforge://` redirect URI. When they
 * upgrade to v1.0.7.1+ and try to connect in the Tauri desktop app,
 * the authorize route sends `mashupforge://oauth/callback` as the
 * redirect_uri, the Higgsfield authorize page rejects it (not in the
 * allowlist), the redirect falls through to the HTTPS callback, and
 * the user lands on `/studio?higgsfield=error&reason=expired_flow`.
 *
 * This endpoint is the one-click fix: the UI shows it inside the
 * migration banner (see components/Settings/HiggsfieldConnection.tsx),
 * the user clicks it, and the next connect registers a fresh client
 * whose allowlist includes `mashupforge://oauth/callback`.
 *
 * On the web build, this is a no-op (config.json is not present) —
 * the desktop-config module handles the no-file case by reading
 * undefined and writing back the same empty state. We treat that as
 * a successful 200 so the UI doesn't show a confusing error to web
 * users.
 *
 * Idempotency: the underlying `writeDesktopConfigValue` deletes the
 * key when given an empty string, so calling this twice is safe.
 */

import { NextResponse } from 'next/server';
import { readDesktopConfigValue, writeDesktopConfigValue } from '@/lib/desktop-env';

export const runtime = 'nodejs';

export async function POST(): Promise<Response> {
  try {
    const before = readDesktopConfigValue('HIGGSFIELD_OAUTH_CLIENT_ID');
    // Empty string == delete (see lib/desktop-env.ts contract).
    writeDesktopConfigValue('HIGGSFIELD_OAUTH_CLIENT_ID', '');
    return NextResponse.json({
      ok: true,
      // Echo whether anything was actually cleared — useful for
      // telemetry and for the migration banner to decide whether
      // to show a "first time" vs "already cleared" message.
      cleared: Boolean(before && before.length > 0),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Reset failed' },
      { status: 500 },
    );
  }
}
