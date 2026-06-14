/**
 * GET /api/mmx/availability
 *
 * Cheap probe used by the studio UI to gate the music / speech / video
 * affordances AND, post-MMX-AVAILABILITY, the AI Agent settings card.
 * Wraps `isAvailable()` (mmx --version probe) and `isAuthenticated()`
 * (env-key presence) from lib/mmx-client. Same auth model as the
 * other /api/mmx routes — unauthenticated, intended for the single-user
 * desktop deployment.
 *
 * Response shape:
 *   { available: boolean, authenticated: boolean }
 *
 * `available` = the binary is callable.
 * `authenticated` = MMX_API_KEY or MINIMAX_API_KEY is set in env.
 *   When mmx is available but unauthenticated the AI Agent card shows
 *   the "Set MMX_API_KEY" hint instead of the green Available pill.
 */

import { NextResponse } from 'next/server';
import { isAvailable, isAuthenticated } from '@/lib/mmx-client';

export async function GET(): Promise<Response> {
  const available = await isAvailable();
  const authenticated = isAuthenticated();
  return NextResponse.json(
    { available, authenticated },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
