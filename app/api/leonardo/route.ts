import { NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/errors';

/**
 * Pull a human-readable message out of a parsed Leonardo error body.
 * v2 returns several shapes depending on the failure mode:
 *   { error: "string" }                           (legacy / simple)
 *   { error: { message, code } }                  (validation errors)
 *   { errors: [{ message, ... }] }                (GraphQL wrap)
 *   { message: "string" }                         (top-level fallback)
 * Plain `${parsedErr.error}` stringification would render the object
 * form as "[object Object]" and hide the real reason from the user.
 */
function extractLeonardoError(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.error === 'string' && p.error.trim()) return p.error;
  if (p.error && typeof p.error === 'object') {
    const e = p.error as Record<string, unknown>;
    if (typeof e.message === 'string' && e.message.trim()) return e.message;
    if (typeof e.code === 'string' && e.code.trim()) return e.code;
  }
  if (Array.isArray(p.errors) && p.errors.length > 0) {
    const first = p.errors[0] as Record<string, unknown> | undefined;
    if (first && typeof first.message === 'string' && first.message.trim()) {
      return first.message;
    }
  }
  if (typeof p.message === 'string' && p.message.trim()) return p.message;
  return null;
}

/**
 * Leonardo AI Image Generation API Route
 *
 * Supports 5 API-documented image models:
 * - Nano Banana (nano-banana): 20 styles, 10 aspect ratios, max 8 images
 * - Nano Banana 2 (nano-banana-2): 20 styles, 10 aspect ratios, max 8 images
 * - Nano Banana Pro (gemini-image-2): 20 styles, 10 aspect ratios, max 8 images
 * - GPT Image-1.5 (gpt-image-1.5): no styles, quality param, 3 aspect ratios, max 4 images
 * - GPT Image 2 (gpt-image-2): no styles, quality param, 5 aspect ratios, max 8 images
 *
 * All use v2 endpoint: https://cloud.leonardo.ai/api/rest/v2/generations.
 * Video models (kling-o3, seedance-2.0, veo-3.1, kling-3.0) live in
 * app/api/leonardo-video/route.ts — not this route.
 *
 * Deprecation (2026-05-04): the legacy `mode` parameter (FAST|QUALITY|ULTRA)
 * is removed for GPT image models. Use `quality` (LOW|MEDIUM|HIGH) instead.
 * This route already only sends `quality`; it never sent `mode`.
 *
 * Client sends internal model id (e.g. 'nano-banana-pro').
 * Route maps to apiModelId (e.g. 'gemini-image-2') for Leonardo API.
 *
 * Upstream: `hooks/useImageGeneration.ts` builds the body via
 * `lib/image-prompt-builder.ts`'s `result.leonardo` slice so this route
 * receives spec-validated style UUIDs / dimensions / quality defaults.
 * Wiring history: STORY-MMX-PROMPT-WIRE.md.
 */

// Map internal id → Leonardo API model id (exact strings required by
// https://cloud.leonardo.ai/api/rest/v2/generations).
const MODEL_ID_MAP: Record<string, string> = {
  'nano-banana': 'gemini-2.5-flash-image',
  'nano-banana-2': 'nano-banana-2',
  'nano-banana-pro': 'gemini-image-2',
  'gpt-image-1.5': 'gpt-image-1.5',
  'gpt-image-2': 'gpt-image-2',
};

export async function POST(req: Request) {
  try {
    const {
      prompt,
      modelId,
      width,
      height,
      apiKey: customApiKey,
      styleIds,       // UUID array for Nano Banana models
      quality,        // LOW | MEDIUM | HIGH for GPT Image-1.5
      quantity,
      promptEnhance,  // IMG-INVEST-001 issue 1: 'ON' | 'OFF' from caller (model spec)
    } = await req.json();
    // Note: negative_prompt is intentionally not destructured. None of the v2
    // models supported by this route (nano-banana-2, gemini-image-2, gpt-image-1.5,
    // gpt-image-2) accept negative_prompt — sending it triggers a v2
    // VALIDATION_ERROR (400).

    const apiKey = customApiKey || process.env.LEONARDO_API_KEY;

    if (!apiKey || apiKey === 'MY_LEONARDO_API_KEY') {
      return NextResponse.json({
        error: 'Leonardo API key is missing. Open Settings (gear icon, top-right) → paste your key from https://app.leonardo.ai/api-access → Save.',
      }, { status: 400 });
    }

    // Map internal model id to Leonardo API model id
    const apiModelId = MODEL_ID_MAP[modelId] || modelId;

    // ── Build v2 request body ────────────────────────────────────────────
    // IMG-INVEST-001 issue 1: prompt_enhance is now driven by the model
    // spec via lib/image-prompt-builder.ts → hooks/useImageGeneration.ts.
    // Defaults to 'ON' so legacy callers (and any spec that doesn't set
    // prompt_enhance) preserve the historical behaviour; pipeline-style
    // specs that set it to 'OFF' finally land here instead of being
    // silently overridden.
    const resolvedPromptEnhance: 'ON' | 'OFF' =
      promptEnhance === 'OFF' ? 'OFF' : 'ON';
    const parameters: Record<string, unknown> = {
      prompt: String(prompt),
      width: Number(width) || 1024,
      height: Number(height) || 1024,
      quantity: Math.min(Number(quantity) || 1, 8),
      prompt_enhance: resolvedPromptEnhance,
    };

    // Quality: sent for ALL models — tested against v2 API, accepted without error.
    // HIGH by default. GPT-Image-1.5 docs explicitly document this parameter;
    // Nano Banana models accept it silently.
    parameters.quality = quality || 'HIGH';

    // Model-specific parameters
    if (modelId === 'gpt-image-1.5') {
      // GPT Image-1.5: max 4 images per request
      parameters.quantity = Math.min(parameters.quantity as number, 4);
    }

    // Nano Banana 2 / Pro: uses style_ids (UUID array)
    if (Array.isArray(styleIds) && styleIds.length > 0) {
      parameters.style_ids = styleIds;
    }

    const requestPayload = {
      model: apiModelId,
      parameters,
      public: false,
    };
    const body = JSON.stringify(requestPayload);

    // ── Call Leonardo v2 API ─────────────────────────────────────────────
    const createRes = await fetch('https://cloud.leonardo.ai/api/rest/v2/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(30000),
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      try {
        const parsedErr = JSON.parse(err);
        const leoMsg = extractLeonardoError(parsedErr);
        if (leoMsg) {
          return NextResponse.json({
            error: `Leonardo API Error: ${leoMsg}`
          }, { status: createRes.status });
        }
      } catch (_) {}
      return NextResponse.json({ 
        error: `Leonardo API Error (${createRes.status}): ${err.slice(0, 200)}` 
      }, { status: createRes.status });
    }

    const createData = await createRes.json() as Record<string, unknown>;

    // Check for GraphQL-style errors (Leonardo returns an array on validation failure)
    if (Array.isArray(createData)) {
      const errs = createData as Array<Record<string, unknown>>;
      if (errs.length > 0 && errs[0].extensions) {
        return NextResponse.json({
          error: `Leonardo API Error: ${String(errs[0].message ?? 'Validation failed')}`
        }, { status: 400 });
      }
    }

    const job = createData.sdGenerationJob as Record<string, unknown> | undefined;
    const gen = createData.generation as Record<string, unknown> | undefined;
    const generate = createData.generate as Record<string, unknown> | undefined;
    const generationId = job?.generationId
      || createData.generationId
      || createData.id
      || gen?.id
      || generate?.generationId;

    if (!generationId) {
      console.error('Leonardo unexpected response:', createData);
      return NextResponse.json({ 
        error: `No generation ID returned. Response: ${JSON.stringify(createData).slice(0, 300)}` 
      }, { status: 500 });
    }

    return NextResponse.json({ generationId });

  } catch (e: unknown) {
    console.error('Leonardo API error:', e);
    return NextResponse.json({
      error: getErrorMessage(e) || 'Internal Server Error'
    }, { status: 500 });
  }
}
