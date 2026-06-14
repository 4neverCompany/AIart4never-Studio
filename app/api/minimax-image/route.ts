import { NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/errors';

/**
 * MiniMax native Image Generation API route.
 *
 * Unlike `/api/leonardo`, MiniMax's `image_generation` endpoint is
 * synchronous: a single POST returns either ready image URLs or a
 * structured error. No polling, no separate status endpoint.
 *
 * Endpoint: POST {MINIMAX_API_BASE_URL}/image_generation  (defaults to
 * https://api.minimaxi.chat/v1, the same base URL the chat path uses).
 * Auth: `Authorization: Bearer ${MINIMAX_API_KEY}` — the same key the
 * vercel-ai chat provider uses.
 *
 * Returned image URLs expire 24h after generation; downstream callers
 * (gallery + watermark pipeline) already proxy / re-host on save so the
 * expiry isn't a problem for the persistent UX.
 *
 * Quantity:  n ∈ [1, 9]. Width/height: 512-2048, multiples of 8 — if
 * the caller passes an aspectRatio name the API resolves dimensions on
 * its side; if width+height are passed, they take precedence.
 */
export const runtime = 'nodejs';

interface MinimaxRequestBody {
  prompt?: unknown;
  aspectRatio?: unknown;
  width?: unknown;
  height?: unknown;
  n?: unknown;
  promptOptimizer?: unknown;
  seed?: unknown;
}

interface MinimaxApiResponse {
  data?: { image_urls?: unknown };
  metadata?: { success_count?: unknown; failed_count?: unknown };
  id?: unknown;
  base_resp?: { status_code?: unknown; status_msg?: unknown };
}

interface ImageOut {
  url: string;
  width: number;
  height: number;
}

const SUPPORTED_ASPECT_RATIOS = new Set([
  '1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9',
]);

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

// MiniMax requires width/height to be 8-multiples. Round DOWN to the
// nearest 8 to stay within the 512-2048 range; rounding up could push a
// 2048 ceiling to 2056 which the API rejects.
function roundTo8(n: number): number {
  return Math.max(512, Math.min(2048, n - (n % 8)));
}

/**
 * Translate MiniMax's base_resp.status_code into a human-readable
 * sentence. The codes are stable across endpoints; 0 = success, the
 * others are surfaced to the user so they can act (different prompt,
 * different key, retry later, etc.).
 */
function explainStatusCode(code: number, msg: string): string {
  switch (code) {
    case 0:
      return msg || 'Success';
    case 1000:
    case 1001:
      return 'MiniMax authentication failed — check MINIMAX_API_KEY.';
    case 1002:
    case 1004:
      return 'MiniMax rate limit hit. Wait a moment and retry.';
    case 1008:
      return 'MiniMax account out of quota / credits.';
    case 1026:
      return 'Prompt blocked by MiniMax content filter. Edit the prompt and retry.';
    case 1027:
      return 'Prompt or output contains policy-violating content (NSFW / restricted).';
    case 2013:
      return 'MiniMax service temporarily unavailable. Retry shortly.';
    default:
      return msg
        ? `MiniMax error ${code}: ${msg}`
        : `MiniMax error ${code}.`;
  }
}

export async function POST(req: Request): Promise<Response> {
  let body: MinimaxRequestBody;
  try {
    body = (await req.json()) as MinimaxRequestBody;
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return NextResponse.json(
      { error: 'prompt is required' },
      { status: 400 },
    );
  }
  // image-01 caps prompt at 1500 chars. Truncate rather than reject so a
  // caller that overshoots gets a result instead of a 400.
  const truncatedPrompt = prompt.length > 1500 ? prompt.slice(0, 1500) : prompt;

  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          'MINIMAX_API_KEY is not configured on the server. Set it in .env.local (or Vercel) before generating MiniMax images.',
      },
      { status: 503 },
    );
  }

  const baseURL =
    process.env.MINIMAX_API_BASE_URL?.trim() || 'https://api.minimaxi.chat/v1';
  const url = `${baseURL.replace(/\/$/, '')}/image_generation`;

  // Build the request shape that MiniMax expects. Pass aspect_ratio when
  // the caller supplied one of the supported names; otherwise we pass
  // explicit width/height. Both modes are documented; sending both is
  // not, so we pick one based on what arrived.
  const minimaxBody: Record<string, unknown> = {
    model: 'image-01',
    prompt: truncatedPrompt,
    n: clampInt(body.n, 1, 9, 1),
    response_format: 'url',
  };

  const aspectRatio = typeof body.aspectRatio === 'string' ? body.aspectRatio : '';
  const hasDims =
    typeof body.width === 'number' && typeof body.height === 'number';
  // Fallback dimensions returned to the caller. Match what we actually
  // asked the API to produce so downstream code sees consistent values
  // even when the API echoes nothing about size in its response.
  let outWidth = 1024;
  let outHeight = 1024;

  if (hasDims) {
    outWidth = roundTo8(clampInt(body.width, 512, 2048, 1024));
    outHeight = roundTo8(clampInt(body.height, 512, 2048, 1024));
    minimaxBody.width = outWidth;
    minimaxBody.height = outHeight;
  } else if (SUPPORTED_ASPECT_RATIOS.has(aspectRatio)) {
    minimaxBody.aspect_ratio = aspectRatio;
    // Mirror the LEONARDO_MODELS minimax-image-01 entry so the response
    // dimensions match what the model returns by default for each ratio.
    // Keeps gallery thumbnails laid out correctly without a second probe.
    const map: Record<string, [number, number]> = {
      '1:1': [1024, 1024],
      '16:9': [1280, 720],
      '4:3': [1152, 864],
      '3:2': [1248, 832],
      '2:3': [832, 1248],
      '3:4': [864, 1152],
      '9:16': [720, 1280],
      '21:9': [1344, 576],
    };
    [outWidth, outHeight] = map[aspectRatio] ?? [1024, 1024];
  } else {
    // No ratio name and no explicit dims — default to square at the
    // model's native resolution.
    minimaxBody.aspect_ratio = '1:1';
  }

  if (typeof body.seed === 'number' && Number.isFinite(body.seed)) {
    minimaxBody.seed = Math.trunc(body.seed);
  }
  if (body.promptOptimizer === true) {
    minimaxBody.prompt_optimizer = true;
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
      signal: AbortSignal.timeout(60_000),
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

  let parsed: MinimaxApiResponse;
  try {
    parsed = (await apiRes.json()) as MinimaxApiResponse;
  } catch {
    return NextResponse.json(
      { error: 'MiniMax returned non-JSON response' },
      { status: 502 },
    );
  }

  // Even a 200-OK MiniMax response can carry a non-zero base_resp.status_code
  // (rate limits, content filter, etc). Surface those as proper errors instead
  // of letting the caller see an empty image_urls list.
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

  const rawUrls = Array.isArray(parsed.data?.image_urls) ? parsed.data!.image_urls : [];
  const urls = rawUrls.filter((u): u is string => typeof u === 'string' && u.length > 0);
  if (urls.length === 0) {
    return NextResponse.json(
      { error: 'MiniMax returned no images (empty image_urls).' },
      { status: 502 },
    );
  }

  // Wrap each Aliyun OSS URL through /api/proxy-image so the browser
  // can render it on an https page. MiniMax signs URLs with the http
  // scheme baked into the signature — fetching the same URL over https
  // returns 403, and the browser's mixed-content policy refuses to
  // load http resources from an https origin (silent fail in the UI,
  // which is the original MXIMG-001 symptom). The proxy fetches over
  // http server-side and re-serves the bytes over the page's https
  // origin; it also adds 1h fresh / 7d stale caching so the gallery
  // keeps working past the 24h Aliyun signed-URL expiry.
  const images: ImageOut[] = urls.map((u) => ({
    url: `/api/proxy-image?url=${encodeURIComponent(u)}`,
    width: outWidth,
    height: outHeight,
  }));

  const generationId = typeof parsed.id === 'string' && parsed.id ? parsed.id : `minimax-${Date.now()}`;

  return NextResponse.json({
    images,
    generationId,
    provider: 'minimax',
  });
}
