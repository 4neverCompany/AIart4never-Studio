/**
 * POST /api/mmx/video
 *
 * Kick off a video generation via the MMX CLI (`mmx video generate`)
 * and return the task ID immediately. v1 does not block on completion
 * or stream the file back — the studio UI surfaces the task ID with a
 * "generating" badge and the user can fetch the finished video later
 * (polling UI is out of scope per FEAT-MMX-MUSIC-UI).
 *
 * Same auth model as the rest of /api/mmx — unauthenticated single-user
 * desktop deployment.
 */

import { NextResponse } from 'next/server';
import {
  generateVideo,
  isAvailable,
  type MmxVideoOptions,
  MmxQuotaError,
  MmxSpawnError,
  MmxError,
} from '@/lib/mmx-client';

interface VideoRequestBody {
  prompt: string;
  options?: Omit<MmxVideoOptions, 'noWait'>;
}

function isVideoRequestBody(value: unknown): value is VideoRequestBody {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.prompt === 'string' && v.prompt.trim().length > 0;
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!isVideoRequestBody(body)) {
    return NextResponse.json(
      { error: 'Body must be { prompt: string, options?: MmxVideoOptions }' },
      { status: 400 },
    );
  }

  if (!(await isAvailable())) {
    return NextResponse.json(
      {
        error: 'MMX CLI is not available on this server',
        hint: 'Install mmx and ensure it is on PATH (or set MMX_BIN).',
      },
      { status: 503 },
    );
  }

  try {
    const { options = {} } = body;
    // Force noWait — this route is a dispatch endpoint, not a polling
    // proxy. The CLI returns the task id immediately so we can show a
    // "generating" badge in the UI without holding the request open
    // for the full render duration.
    const result = await generateVideo(
      body.prompt,
      { ...options, noWait: true },
      { signal: req.signal },
    );
    return NextResponse.json({
      taskId: result.taskId ?? null,
      path: result.path ?? null,
    });
  } catch (e) {
    if (e instanceof MmxQuotaError) {
      return NextResponse.json(
        { error: 'MMX quota / Token Plan does not include video generation', hint: e.hint },
        { status: 402 },
      );
    }
    if (e instanceof MmxSpawnError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    if (e instanceof MmxError) {
      return NextResponse.json({ error: e.message, code: String(e.code) }, { status: 502 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Video generation failed' },
      { status: 500 },
    );
  }
}
