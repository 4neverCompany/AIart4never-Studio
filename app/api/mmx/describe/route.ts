/**
 * POST /api/mmx/describe
 *
 * Describe an image via MiniMax's vision model (`mmx vision describe`).
 * Designed to back the "generate alt text" affordance — caller passes
 * either an image URL or path the desktop sidecar can read, and we
 * return the model's textual description. Same auth model as
 * /api/mmx/music: unauthenticated single-user desktop deployment.
 */

import { NextResponse } from 'next/server';
import {
  describeImage,
  isAvailable,
  MmxQuotaError,
  MmxSpawnError,
  MmxError,
} from '@/lib/mmx-client';

interface DescribeRequestBody {
  image?: string;
  fileId?: string;
  prompt?: string;
}

function parseBody(value: unknown): DescribeRequestBody | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const image = typeof v.image === 'string' && v.image.trim() ? v.image.trim() : undefined;
  const fileId = typeof v.fileId === 'string' && v.fileId.trim() ? v.fileId.trim() : undefined;
  const prompt = typeof v.prompt === 'string' ? v.prompt : undefined;
  if (!image && !fileId) return null;
  if (image && fileId) return null;
  return { image, fileId, prompt };
}

export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const body = parseBody(raw);
  if (!body) {
    return NextResponse.json(
      { error: 'Body must be { image: string } XOR { fileId: string }, optional prompt' },
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
    const source = body.image
      ? { image: body.image }
      : { fileId: body.fileId as string };
    const result = await describeImage(
      source,
      body.prompt ? { prompt: body.prompt } : {},
      { signal: req.signal },
    );
    return NextResponse.json({ description: result.description });
  } catch (e) {
    if (e instanceof MmxQuotaError) {
      return NextResponse.json(
        { error: 'MMX quota / Token Plan does not include vision', hint: e.hint },
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
      { error: e instanceof Error ? e.message : 'Vision describe failed' },
      { status: 500 },
    );
  }
}
