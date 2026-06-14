/**
 * GET /api/higgsfield/oauth/status
 *
 * Returns the current Higgsfield OAuth connection state. Used by
 * the Settings UI to decide whether to show "Connect Higgsfield"
 * or "Disconnect". The response includes the account email / name
 * / org_id from the ID token (for display) but never the tokens
 * themselves.
 *
 * Response shape:
 *   {
 *     connected: boolean,
 *     email?: string,
 *     name?: string,
 *     orgId?: string,
 *     expiresAt?: number,  // epoch ms
 *     needsRefresh?: boolean,
 *   }
 */

import { NextResponse } from 'next/server';
import { loadTokens, isTokenExpiringSoon } from '@/lib/higgsfield/token-store';

export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  const tokens = await loadTokens();
  if (!tokens) {
    return NextResponse.json({ connected: false });
  }
  return NextResponse.json({
    connected: true,
    email: tokens.email,
    name: tokens.name,
    orgId: tokens.orgId,
    expiresAt: tokens.accessTokenExpiresAt || undefined,
    needsRefresh: isTokenExpiringSoon(tokens),
  });
}
