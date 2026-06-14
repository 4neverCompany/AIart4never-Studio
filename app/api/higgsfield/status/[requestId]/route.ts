/**
 * GET /api/higgsfield/status/[requestId]
 *
 * Polls the status of an async Higgsfield job. The MCP server's
 * `higgsfield_generate` tool returns a `requestId` for jobs that
 * take more than a few seconds (e.g. video generation, complex
 * compositions). The client polls this route every 2-3s until
 * `status === 'completed' | 'failed'`.
 *
 * Response shape:
 *   {
 *     status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw',
 *     imageUrl?: string,    // when completed (for image jobs)
 *     videoUrl?: string,    // when completed (for video jobs)
 *     error?: string,       // when failed
 *   }
 *
 * Polling: callers should cap at 150 attempts × 2s = 5 minutes.
 * For longer jobs, prefer the webhook path (Phase 2).
 */

import { NextResponse } from 'next/server';
import { readDesktopConfigValue } from '@/lib/desktop-env';
import { callHiggsfieldTool, getValidAccessToken } from '@/lib/higgsfield/mcp-client';
import { getErrorMessage } from '@/lib/errors';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  context: { params: Promise<{ requestId: string }> },
): Promise<Response> {
  const { requestId } = await context.params;
  if (!requestId || requestId.length < 4) {
    return NextResponse.json({ error: 'requestId is required' }, { status: 400 });
  }

  const clientId = readDesktopConfigValue('HIGGSFIELD_OAUTH_CLIENT_ID');
  if (!clientId) {
    return NextResponse.json({ error: 'Higgsfield not configured' }, { status: 401 });
  }
  const auth = await getValidAccessToken({ clientId });
  if (!auth) {
    return NextResponse.json({ error: 'Not connected' }, { status: 401 });
  }

  // The MCP server doesn't expose a dedicated `status` tool in the
  // 7-tool public surface — `higgsfield_generate` is a fire-and-
  // observe design. We call it again with the same requestId
  // (Higgsfield's REST API treats request_id as the idempotency key)
  // to ask "what's the state of this job?" If the job is still
  // running the tool returns a fresh requestId; if it's done, it
  // returns the final URL. We surface that to the caller.
  //
  // This is intentionally simple: the polling round-trips through
  // MCP rather than the REST status endpoint, so we don't need a
  // second auth path or a separate SDK call.
  try {
    const result = await callHiggsfieldTool({
      clientId,
      accessToken: auth.accessToken,
      tool: 'higgsfield_generate',
      arguments: { request_id: requestId, _poll: true },
    });

    if (result.completed && result.imageUrl) {
      return NextResponse.json({ status: 'completed', imageUrl: result.imageUrl });
    }
    if (result.completed && result.videoUrl) {
      return NextResponse.json({ status: 'completed', videoUrl: result.videoUrl });
    }
    if (result.blocked) {
      return NextResponse.json({ status: 'nsfw', error: result.error });
    }
    if (result.error) {
      return NextResponse.json({ status: 'failed', error: result.error });
    }
    return NextResponse.json({ status: 'in_progress' });
  } catch (e) {
    return NextResponse.json(
      { status: 'failed', error: getErrorMessage(e) },
      { status: 502 },
    );
  }
}
