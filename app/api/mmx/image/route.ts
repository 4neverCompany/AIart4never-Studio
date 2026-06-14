/**
 * POST /api/mmx/image
 *
 * Generate one or more images via the MMX CLI (`mmx image generate`).
 * The route owns the prompt-enhancement step: callers send a base prompt
 * + spec inputs (modelId, styleName, aspectRatio, count, qualityHint)
 * and we run them through `buildEnhancedPrompt` so MMX gets the same
 * structured intent the Leonardo route already gets via
 * `result.leonardo`. This is the second consumer of
 * `lib/image-prompt-builder.ts`; if we ever add a third provider,
 * keep using `buildEnhancedPrompt` so all three see identical hints.
 *
 * Auth: matches /api/mmx/music and /api/mmx/describe — single-user
 * desktop deployment, MMX credentials live in the user's env. Gate
 * with a Bearer secret in middleware before deploying to a shared host.
 */

import { NextResponse } from 'next/server';
import {
  generateImage,
  isAvailable,
  MmxQuotaError,
  MmxSpawnError,
  MmxError,
} from '@/lib/mmx-client';
import { buildEnhancedPrompt } from '@/lib/image-prompt-builder';

interface ImageRequestBody {
  prompt: string;
  modelId?: string;
  styleName?: string;
  aspectRatio?: string;
  dimensionTier?: string;
  count?: number;
  qualityHint?: string;
}

function isImageRequestBody(value: unknown): value is ImageRequestBody {
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
  if (!isImageRequestBody(body)) {
    return NextResponse.json(
      { error: 'Body must be { prompt: string, ...spec inputs }' },
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

  const enhanced = buildEnhancedPrompt(body.prompt, {
    modelId: body.modelId,
    styleName: body.styleName,
    aspectRatio: body.aspectRatio,
    dimensionTier: body.dimensionTier,
    count: body.count,
    qualityHint: body.qualityHint,
  });

  try {
    const result = await generateImage(
      enhanced.prompt,
      enhanced.mmx,
      { signal: req.signal },
    );
    return NextResponse.json({
      urls: result.urls,
      files: result.files,
      base64: result.base64,
      // Diagnostic: surface what was appended so the caller can confirm
      // the spec lookup matched (helpful when a styleName silently
      // misses because the spec doesn't list it).
      appliedHints: enhanced.appliedHints,
      finalPrompt: enhanced.prompt,
    });
  } catch (e) {
    if (e instanceof MmxQuotaError) {
      return NextResponse.json(
        { error: 'MMX quota / Token Plan does not include this image model', hint: e.hint },
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
      { error: e instanceof Error ? e.message : 'Image generation failed' },
      { status: 500 },
    );
  }
}
