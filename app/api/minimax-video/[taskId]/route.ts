/**
 * GET /api/minimax-video/[taskId]
 *
 * Poll endpoint for a video generation task submitted to MiniMax's
 * native (Hailuo 2.3) video_generation API. Pairs with
 * /api/minimax-video (POST) - the submit response returns the
 * taskId; this route resolves it to a final download URL.
 *
 * Polling contract:
 *   status: 'preparing' | 'queueing' | 'processing' - in flight, keep polling
 *   status: 'success' + videoUrl - done, surface the URL to the user
 *   status: 'fail' + error - terminal failure, surface the reason
 *
 * Internally we hit two MiniMax endpoints:
 *   1. GET /v1/query/video_generation?task_id=X
 *      - returns { status, file_id, video_width, video_height, base_resp }
 *   2. On Success, GET /v1/files/retrieve?file_id=Y
 *      - returns { file: { download_url, ... }, base_resp }
 *
 * The download_url is valid for 1 hour per the API docs; downstream
 * code should treat it like any other signed URL and either fetch
 * it server-side (e.g. via /api/proxy-video) or hand it to the
 * browser directly.
 */
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/errors';

interface MinimaxQueryResponse {
  task_id?: string;
  status?: string;
  file_id?: string | number;
  video_width?: number;
  video_height?: number;
  base_resp?: { status_code?: number; status_msg?: string };
}

interface MinimaxFileResponse {
  file?: {
    file_id?: string | number;
    download_url?: string;
    filename?: string;
    bytes?: number;
  };
  base_resp?: { status_code?: number; status_msg?: string };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  const { taskId } = await params;
  if (!taskId || typeof taskId !== 'string') {
    return NextResponse.json({ error: 'taskId is required' }, { status: 400 });
  }

  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          'MINIMAX_API_KEY is not configured on the server. Set it in .env.local (or Vercel) before polling MiniMax videos.',
      },
      { status: 503 },
    );
  }

  const baseURL = process.env.MINIMAX_API_BASE_URL?.trim() || 'https://api.minimaxi.chat/v1';
  const queryUrl = `${baseURL.replace(/\/$/, '')}/query/video_generation?task_id=${encodeURIComponent(taskId)}`;

  let queryRes: Response;
  try {
    queryRes = await fetch(queryUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: `MiniMax query failed: ${getErrorMessage(e) || 'network error'}` },
      { status: 502 },
    );
  }

  if (!queryRes.ok) {
    const text = await queryRes.text().catch(() => '');
    return NextResponse.json(
      { error: `MiniMax HTTP ${queryRes.status}: ${text.slice(0, 300)}` },
      { status: queryRes.status },
    );
  }

  let parsed: MinimaxQueryResponse;
  try {
    parsed = (await queryRes.json()) as MinimaxQueryResponse;
  } catch {
    return NextResponse.json(
      { error: 'MiniMax query returned non-JSON response' },
      { status: 502 },
    );
  }

  const baseStatus = parsed.base_resp?.status_code ?? 0;
  const baseMsg = parsed.base_resp?.status_msg ?? '';

  // Map MiniMax's PascalCase status to the lowercased vocabulary the
  // Studio expects (matches the leonardo and higgsfield poll routes).
  // The high-level `status` field takes priority over base_resp:
  // a Fail can carry a non-zero base_resp.status_code (e.g. 1026
  // sensitive content), and we want the route to surface that as
  // status:'fail' so the Studio shows the failure reason instead
  // of an opaque 502.
  const rawStatus = (parsed.status ?? '').toString();
  let status: 'preparing' | 'queueing' | 'processing' | 'success' | 'fail';
  switch (rawStatus) {
    case 'Success':
      status = 'success';
      break;
    case 'Fail':
      status = 'fail';
      break;
    case 'Preparing':
      status = 'preparing';
      break;
    case 'Queueing':
      status = 'queueing';
      break;
    case 'Processing':
      status = 'processing';
      break;
    default:
      // Unknown status - treat as still in flight rather than failing
      // closed; the next poll will surface the real state.
      status = 'processing';
  }

  if (status !== 'success') {
    // For terminal Fail, include the base_resp context so the
    // caller can surface a meaningful reason to the user.
    const body: Record<string, unknown> = { status, taskId };
    if (status === 'fail' && baseStatus !== 0) {
      body.error = `MiniMax ${baseStatus} ${baseMsg}`.trim();
    }
    return NextResponse.json(body);
  }

  // Success - resolve file_id -> download_url via the files endpoint.
  if (parsed.file_id === undefined) {
    return NextResponse.json(
      { status: 'fail', taskId, error: 'MiniMax reported success but returned no file_id' },
      { status: 502 },
    );
  }

  const fileUrl = `${baseURL.replace(/\/$/, '')}/files/retrieve?file_id=${encodeURIComponent(String(parsed.file_id))}`;
  let fileRes: Response;
  try {
    fileRes = await fetch(fileUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: `MiniMax file retrieve failed: ${getErrorMessage(e) || 'network error'}` },
      { status: 502 },
    );
  }

  if (!fileRes.ok) {
    const text = await fileRes.text().catch(() => '');
    return NextResponse.json(
      { error: `MiniMax file retrieve HTTP ${fileRes.status}: ${text.slice(0, 300)}` },
      { status: fileRes.status },
    );
  }

  let fileParsed: MinimaxFileResponse;
  try {
    fileParsed = (await fileRes.json()) as MinimaxFileResponse;
  } catch {
    return NextResponse.json(
      { error: 'MiniMax file retrieve returned non-JSON response' },
      { status: 502 },
    );
  }

  const downloadUrl = fileParsed.file?.download_url;
  if (!downloadUrl) {
    return NextResponse.json(
      { status: 'fail', taskId, error: 'MiniMax file retrieve returned no download_url' },
      { status: 502 },
    );
  }

  return NextResponse.json({
    status: 'success',
    taskId,
    videoUrl: downloadUrl,
    fileId: fileParsed.file?.file_id,
    filename: fileParsed.file?.filename,
    width: parsed.video_width,
    height: parsed.video_height,
  });
}
