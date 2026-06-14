/**
 * POST /api/higgsfield/oauth/disconnect
 *
 * Clears the user's Higgsfield OAuth tokens from IDB and closes the
 * cached MCP client. We don't call the MCP server's /revoke endpoint
 * (Higgsfield's OAuth server doesn't expose one as of 2026-06-03);
 * the user is responsible for revoking the grant from their
 * Higgsfield account settings page if they want a hard cut.
 *
 * The registered OAuth client_id is KEPT in config.json — it's
 * not a secret and re-registering would orphan the user's grants
 * if they ever reconnect.
 */

import { NextResponse } from 'next/server';
import { clearTokens } from '@/lib/higgsfield/token-store';
import { disconnectMcp } from '@/lib/higgsfield/mcp-client';

export const runtime = 'nodejs';

export async function POST(): Promise<Response> {
  try {
    await clearTokens();
    await disconnectMcp();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Disconnect failed' },
      { status: 500 },
    );
  }
}
