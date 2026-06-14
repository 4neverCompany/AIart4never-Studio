/**
 * POST /api/minimax-video
 *
 * Native MiniMax (Hailuo 2.3) video generation route. Shaped
 * parallel to /api/minimax-image: synchronous-shape request that
 * returns a task ID, with a separate status route for polling.
 *
 * V1.1.1-MULTI-PROVIDER-VIDEO: this is the third video provider
 * alongside /api/leonardo-video (Leonardo) and /api/mmx/video (mmx
 * CLI). The user can select any combination of the three in
 * Settings -> Default Video Settings; clicking "Animate" in the
 * Studio fires parallel submissions to all selected providers.
 *
 * The native direct-API path (this route) is the preferred
 * implementation because it does not shell out to the mmx CLI -
 * useful for Vercel / serverless deploys and for users on machines
 * where mmx is not installed. mmx remains in the stack as the
 * CLI-based fallback, but the Studio default provider is now
 * `minimax` (Hailuo 2.3) and goes through this route.
 *
 * Endpoint: POST {MINIMAX_API_BASE_URL}/video_generation  (defaults
 * to https://api.minimaxi.chat/v1, the same base URL the chat +
 * image paths use).
 * Auth: `Authorization: Bearer ${MINIMAX_API_KEY}`.
 *
 * Model slugs: MiniMax-Hailuo-2.3 (default), MiniMax-Hailuo-02,
 * T2V-01-Director, T2V-01.
 *
 * Camera movement can be controlled inline using [command] syntax
 * (e.g. [Pan left], [Tilt up]) - the cameraAngle picker's prompt
 * fragment is folded in as part of the prompt automatically by the
 * Studio before submission, so users get cinematic movement for
 * free.
 *
 * Response shape: { taskId, status: 'pending' } on submit, 4xx/5xx
 * with a structured error and statusCode on failure. Use GET
 * /api/minimax-video/[taskId] to poll.
 */
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/errors';

interface VideoRequestBody {
  prompt?: unknown;
  options?: {
    model?: unknown;
    duration?: unknown;
    resolution?: unknown;
    firstFrameUrl?: unknown;
  };
}

interface MinimaxSubmitResponse {
  task_id?: string;
  base_resp?: { status_code?: unknown; status_msg?: unknown };
}

function explainStatusCode(code: number, msg: string): string {
  switch (code) {
    case 0:
      return msg || 'Success';
    case 1002:
      return 'MiniMax rate limit hit. Wait a moment and retry.';
    case 1004:
      return 'MiniMax authentication failed - check MINIMAX_API_KEY.';
    case 1008:
      return 'MiniMax account out of quota / credits.';
    case 1026:
      return 'Prompt blocked by MiniMax content filter. Edit the prompt and retry.';
    case 1027:
      return 'Output contains policy-violating content. Edit the prompt and retry.';
    case 2013:
      return 'Invalid input parameters. Check the prompt and options.';
    case 2049:
      return 'Invalid MiniMax API key.';
    default:
      return msg ? `MiniMax error ${code}: ${msg}` : `MiniMax error ${code}.`;
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export async function POST(req: Request): Promise<Response> {
  let body: VideoRequestBody;
  try {
    body = (await req.json()) as VideoRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
  }
  // MiniMax caps video prompts at 2000 chars; truncate rather than
  // reject so a caller that overshoots gets a result instead of a 400.
  const truncatedPrompt = prompt.length > 2000 ? prompt.slice(0, 2000) : prompt;

  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          'MINIMAX_API_KEY is not configured on the server. Set it in .env.local (or Vercel) before generating MiniMax videos.',
      },
      { status: 503 },
    );
  }

  const baseURL = process.env.MINIMAX_API_BASE_URL?.trim() || 'https://api.minimaxi.chat/v1';
  const url = `${baseURL.replace(/\/$/, '')}/video_generation`;

  const opts = body.options ?? {};
  const model = typeof opts.model === 'string' && opts.model.trim().length > 0
    ? opts.model.trim()
    : 'MiniMax-Hailuo-2.3';
  // Duration bounds per the OpenAPI spec: Hailuo 2.3 supports 6 or
  // 10 (768P) or 6 (1080P); other models 6 only. Clamp into a sane
  // range so callers can experiment with longer values without 400ing.
  const duration = clampInt(opts.duration, 1, 60, 6);
  const resolution = typeof opts.resolution === 'string' && /^(720P|768P|1080P)$/i.test(opts.resolution)
    ? opts.resolution.toUpperCase()
    : '768P';
  const firstFrameUrl = typeof opts.firstFrameUrl === 'string' && opts.firstFrameUrl.trim().length > 0
    ? opts.firstFrameUrl.trim()
    : undefined;

  // Build the request shape. first_frame_url is a documented field
  // for i2v (image-to-video); we only include it when the caller
  // supplied one. prompt_optimizer defaults to true on the API side
  // so we leave it alone unless explicitly overridden.
  const minimaxBody: Record<string, unknown> = {
    model,
    prompt: truncatedPrompt,
    duration,
    resolution,
  };
  if (firstFrameUrl) {
    minimaxBody.first_frame_url = firstFrameUrl;
  }

  let apiRes: Response;
  try {
    apiRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(minimaxBody),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: `MiniMax request failed: ${getErrorMessage(e) || 'network error'}` },
      { status: 502 },
    );
  }

  if (!apiRes.ok) {
    const text = await apiRes.text().catch(() => '');
    return NextResponse.json(
      { error: `MiniMax HTTP ${apiRes.status}: ${text.slice(0, 300)}` },
      { status: apiRes.status },
    );
  }

  let parsed: MinimaxSubmitResponse;
  try {
    parsed = (await apiRes.json()) as MinimaxSubmitResponse;
  } catch {
    return NextResponse.json(
      { error: 'MiniMax returned non-JSON response' },
      { status: 502 },
    );
  }

  // Even a 200-OK MiniMax response can carry a non-zero base_resp.status_code.
  // Surface those as proper errors instead of returning a fake task id.
  const statusCode =
    typeof parsed.base_resp?.status_code === 'number' ? parsed.base_resp.status_code : 0;
  const statusMsg =
    typeof parsed.base_resp?.status_msg === 'string' ? parsed.base_resp.status_msg : '';
  if (statusCode !== 0) {
    return NextResponse.json(
      {
        error: explainStatusCode(statusCode, statusMsg),
        statusCode,
      },
      { status: statusCode === 1026 || statusCode === 1027 ? 400 : 502 },
    );
  }

  if (!parsed.task_id) {
    return NextResponse.json(
      { error: 'MiniMax returned no task_id.' },
      { status: 502 },
    );
  }

  return NextResponse.json({
    taskId: parsed.task_id,
    status: 'pending',
    model,
  });
}
