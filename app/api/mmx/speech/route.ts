/**
 * POST /api/mmx/speech
 *
 * Synthesize speech via the MMX CLI (`mmx speech synthesize`) and
 * stream the resulting audio file back to the caller. Backs the
 * "read aloud" affordance in the sidebar.
 *
 * Mirrors /api/mmx/music: route owns the temp filesystem path so a
 * malicious caller-supplied opts.out can't escape the temp dir, then
 * the file is unlinked after the bytes are read back.
 *
 * Auth: unauthenticated single-user desktop deployment, same as
 * /api/mmx/music and /api/mmx/describe.
 */

import { NextResponse } from 'next/server';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  synthesizeSpeech,
  isAvailable,
  type MmxSpeechOptions,
  MmxQuotaError,
  MmxSpawnError,
  MmxError,
} from '@/lib/mmx-client';

interface SpeechRequestBody {
  text: string;
  options?: MmxSpeechOptions;
}

function isSpeechRequestBody(value: unknown): value is SpeechRequestBody {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.text === 'string' && v.text.trim().length > 0;
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!isSpeechRequestBody(body)) {
    return NextResponse.json(
      { error: 'Body must be { text: string, options?: MmxSpeechOptions }' },
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

  const tempDir = mkdtempSync(join(tmpdir(), 'mashupforge-mmx-speech-'));
  const outPath = join(tempDir, 'speech.mp3');
  try {
    const { options = {} } = body;
    await synthesizeSpeech(
      body.text,
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
        { error: 'MMX quota / Token Plan does not include this voice', hint: e.hint },
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
      { error: e instanceof Error ? e.message : 'Speech synthesis failed' },
      { status: 500 },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
