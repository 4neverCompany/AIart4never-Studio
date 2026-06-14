/**
 * POST /api/mmx/music
 *
 * Generate a track via the MMX CLI (`mmx music generate`) and stream the
 * resulting audio file back to the caller. Designed to back a "generate
 * background music" affordance in the studio UI: the request describes
 * the prompt + structured controls, the server spawns mmx, mmx writes
 * the audio to a temp file, the route streams it back as an mpeg, and
 * then the temp file is unlinked.
 *
 * Auth: matches the existing /api/leonardo and /api/pi/prompt model —
 * unauthenticated, intended for a single-user desktop deployment where
 * the user owns the MiniMax credentials. If you deploy this to a shared
 * environment, gate it with a Bearer secret in middleware.
 */

import { NextResponse } from 'next/server';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateMusic,
  isAvailable,
  type MmxMusicOptions,
  MmxQuotaError,
  MmxSpawnError,
  MmxError,
} from '@/lib/mmx-client';

interface MusicRequestBody {
  prompt: string;
  options?: MmxMusicOptions;
}

function isMusicRequestBody(value: unknown): value is MusicRequestBody {
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
  if (!isMusicRequestBody(body)) {
    return NextResponse.json(
      { error: 'Body must be { prompt: string, options?: MmxMusicOptions }' },
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

  // mmx writes the audio file to disk; we hand it a temp path, then read
  // the bytes back and clean up. Caller-provided opts.out is ignored — the
  // route owns the filesystem path so stray writes from a malicious prompt
  // can't escape the temp dir.
  const tempDir = mkdtempSync(join(tmpdir(), 'mashupforge-mmx-music-'));
  const outPath = join(tempDir, 'track.mp3');
  try {
    const { options = {} } = body;
    await generateMusic(
      body.prompt,
      { ...options, out: outPath },
      { signal: req.signal },
    );
    const audio = readFileSync(outPath);
    return new NextResponse(audio, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof MmxQuotaError) {
      return NextResponse.json(
        { error: 'MMX quota / Token Plan does not include this music model', hint: e.hint },
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
      { error: e instanceof Error ? e.message : 'Music generation failed' },
      { status: 500 },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
