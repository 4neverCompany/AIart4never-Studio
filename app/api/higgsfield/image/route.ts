/**
 * POST /api/higgsfield/image
 *
 * Server-side MCP wrapper for Higgsfield image generation. Pulls the
 * user's OAuth access token (from IDB), refreshes it if expiring
 * soon, calls the `higgsfield_generate` MCP tool with the requested
 * model + prompt, and returns either a direct imageUrl (sync) or a
 * requestId to poll (async).
 *
 * Request shape:
 *   {
 *     prompt: string,                   // required, 1-2000 chars
 *     model?: string,                   // default: nano_banana_2
 *     aspectRatio?: string,             // e.g. '9:16', '1:1'
 *     resolution?: '1k' | '2k' | '4k',  // image models that take resolution
 *     quality?: 'low' | 'medium' | 'high',  // gpt_image_2 etc.
 *     soulId?: string,                  // for soul_v2 model
 *     seed?: number,                    // for reproducibility
 *     referenceImageUrl?: string,       // for img2img / character ref
 *   }
 *
 * Response (success, sync):
 *   { completed: true, imageUrl: string, requestId?: string, model: string }
 *
 * Response (async, needs polling):
 *   { completed: false, requestId: string, model: string }
 *
 * Errors return { error: string } with a 4xx/5xx status. Specific
 * status codes:
 *   401 → not connected (caller should redirect to /api/higgsfield/oauth/authorize)
 *   402 → user out of credits (forwarded from MCP server)
 *   429 → rate limited
 *   502 → MCP server error / network
 */

import { NextResponse } from 'next/server';
import { readDesktopConfigValue } from '@/lib/desktop-env';
import { getErrorMessage } from '@/lib/errors';
import { callHiggsfieldTool, getValidAccessToken } from '@/lib/higgsfield/mcp-client';
import {
  HIGGSFIELD_DEFAULT_IMAGE_MODEL,
  getHiggsfieldImageModel,
  type HiggsfieldImageModelSlug,
} from '@/lib/higgsfield/models';

export const runtime = 'nodejs';

interface RequestBody {
  prompt?: unknown;
  model?: unknown;
  aspectRatio?: unknown;
  resolution?: unknown;
  quality?: unknown;
  soulId?: unknown;
  seed?: unknown;
  referenceImageUrl?: unknown;
  /**
   * V1.3.6-CLI-TOKEN: Higgsfield CLI token (set in Settings →
   * HiggsfieldConnection). When provided, the server uses the CLI
   * binary path via `HiggsfieldCliAdapter` instead of the OAuth
   * MCP path. This is the path that works for users who couldn't
   * get the OAuth flow working — they paste a CLI token and the
   * server uses it directly.
   *
   * Pattern lifted from /api/ai/prompt/route.ts (V1.2.5) — the
   * client passes the token in the body on every request, the
   * server threads it into the provider registry.
   */
  higgsfieldCliToken?: unknown;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function asInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return parseInt(v, 10);
  return undefined;
}

export async function POST(req: Request): Promise<Response> {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const prompt = asString(body.prompt);
  if (!prompt) {
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
  }
  if (prompt.length > 2000) {
    return NextResponse.json(
      { error: 'prompt exceeds 2000 characters' },
      { status: 400 },
    );
  }

  const modelSlug = (asString(body.model) || HIGGSFIELD_DEFAULT_IMAGE_MODEL) as HiggsfieldImageModelSlug;
  const modelMeta = getHiggsfieldImageModel(modelSlug);
  if (!modelMeta) {
    return NextResponse.json(
      { error: `Unknown Higgsfield image model: ${modelSlug}. Known: ${HIGGSFIELD_DEFAULT_IMAGE_MODEL} and others in lib/higgsfield/models.ts.` },
      { status: 400 },
    );
  }

  // Validate aspect ratio against the model's allow-list. The MCP
  // server will reject invalid ratios with a 400, but failing fast
  // here gives the user a clearer error.
  const aspectRatio = asString(body.aspectRatio);
  if (aspectRatio && modelMeta.aspectRatios.length > 0 && !modelMeta.aspectRatios.includes(aspectRatio)) {
    return NextResponse.json(
      {
        error: `Model ${modelSlug} doesn't support aspect ratio ${aspectRatio}. Supported: ${modelMeta.aspectRatios.join(', ')}`,
      },
      { status: 400 },
    );
  }
  const resolution = asString(body.resolution);
  if (resolution && modelMeta.resolutions && !modelMeta.resolutions.includes(resolution)) {
    return NextResponse.json(
      {
        error: `Model ${modelSlug} doesn't support resolution ${resolution}. Supported: ${modelMeta.resolutions.join(', ')}`,
      },
      { status: 400 },
    );
  }
  const referenceImageUrl = asString(body.referenceImageUrl);
  const seed = asInt(body.seed);

  // Auth strategy (V1.6 — M1.2): the CLI path is the one that works
  // for most users, so we prefer it. We use the CLI when EITHER the
  // user pasted a CLI token (explicit override, wins over OAuth) OR
  // OAuth isn't connected but the CLI binary is available — i.e. the
  // user ran `higgsfield auth login` once, or the bundled CLI is
  // present (v1.5.2+). Only when OAuth IS connected and no token was
  // pasted do we use the OAuth/MCP path. This removes the
  // "Connect Higgsfield in Settings" dead-end the route used to hit
  // even when a perfectly good cached-creds CLI was sitting right
  // there. The token, when present, is written to a temp
  // credentials.json by HiggsfieldCliAdapter; an absent token makes
  // the adapter use the CLI's own cached credentials.
  const cliToken = asString(body.higgsfieldCliToken);
  const clientId = readDesktopConfigValue('HIGGSFIELD_OAUTH_CLIENT_ID');
  const oauthAuth = clientId ? await getValidAccessToken({ clientId }) : null;

  const { setProviderRuntimeConfig, getProvider } = await import('@/lib/providers/registry');
  // Rebuild the higgsfield singleton with (or without) the pasted
  // token so the adapter picks up the right credentials source.
  setProviderRuntimeConfig(cliToken ? { higgsfieldCliToken: cliToken } : {});
  const higgsfield = getProvider('higgsfield');
  const useCli = cliToken ? true : (!oauthAuth && (await higgsfield.isAvailable()));

  if (useCli) {
    try {
      const ref = await higgsfield.generateImage({
        prompt,
        model: modelSlug,
        aspectRatio: aspectRatio,
        ...(resolution ? { extra: { resolution } } : {}),
        ...(referenceImageUrl ? { referenceImage: { url: referenceImageUrl } } : {}),
        ...(seed !== undefined ? { seed } : {}),
      });
      if (ref.kind === 'image' && ref.url) {
        return NextResponse.json({
          completed: true,
          imageUrl: ref.url,
          requestId: ref.jobId,
          model: modelSlug,
          enhancedPrompt: prompt,
        });
      }
      if (ref.kind === 'job' && ref.jobId) {
        return NextResponse.json({
          completed: false,
          requestId: ref.jobId,
          model: modelSlug,
        });
      }
      return NextResponse.json(
        { error: 'Higgsfield CLI returned no asset URL or job id' },
        { status: 502 },
      );
    } catch (e) {
      const msg = getErrorMessage(e);
      // A CLI that's present but not logged in surfaces an auth
      // error here. Map it to a 401 with an explicit remedy instead
      // of leaking raw CLI stderr as an opaque 502.
      const authish = /auth|unauthor|401|credential|token|login/i.test(msg);
      return NextResponse.json(
        {
          error: authish
            ? `Higgsfield CLI is installed but not authenticated. Run \`higgsfield auth login\` once, or paste a CLI token in Settings → AI Engine. (${msg})`
            : `Higgsfield CLI call failed: ${msg}`,
        },
        { status: authish ? 401 : 502 },
      );
    }
  }

  // OAuth/MCP path — reached only when OAuth is connected and no CLI
  // token was pasted.
  if (!clientId) {
    return NextResponse.json(
      { error: 'Higgsfield not connected. Run `higgsfield auth login` once, paste a CLI token, or connect your account in Settings → AI Engine.' },
      { status: 401 },
    );
  }
  const auth = oauthAuth;
  if (!auth) {
    return NextResponse.json(
      { error: 'Higgsfield account not connected. Run `higgsfield auth login`, paste a CLI token, or click "Connect Higgsfield" in Settings → AI Engine.' },
      { status: 401 },
    );
  }

  // Compose the MCP `higgsfield_generate` arguments. The tool takes a
  // `model` field plus the model's specific parameters; we forward
  // aspect_ratio, resolution, quality, soul_id, seed, and a single
  // reference image. The MCP tool's exact field names match the
  // underlying REST API (modeled on the official SDK).
  const toolArgs: Record<string, unknown> = {
    model: modelSlug,
    prompt,
  };
  if (aspectRatio) toolArgs.aspect_ratio = aspectRatio;
  if (resolution) toolArgs.resolution = resolution;
  const quality = asString(body.quality);
  if (quality && (quality === 'low' || quality === 'medium' || quality === 'high')) {
    toolArgs.quality = quality;
  }
  const soulId = asString(body.soulId);
  if (soulId) toolArgs.soul_id = soulId;

  try {
    const result = await callHiggsfieldTool({
      clientId,
      accessToken: auth.accessToken,
      tool: 'higgsfield_generate',
      arguments: toolArgs,
    });

    if (result.blocked) {
      return NextResponse.json(
        { error: result.error || 'Higgsfield blocked the prompt (content moderation).' },
        { status: 422 },
      );
    }
    if (result.completed && result.imageUrl) {
      return NextResponse.json({
        completed: true,
        imageUrl: result.imageUrl,
        requestId: result.requestId,
        model: modelSlug,
        enhancedPrompt: prompt,
      });
    }
    if (result.requestId) {
      return NextResponse.json({
        completed: false,
        requestId: result.requestId,
        model: modelSlug,
      });
    }
    return NextResponse.json(
      { error: result.error || 'Higgsfield returned no result. Try again or pick a different model.' },
      { status: 502 },
    );
  } catch (e) {
    return NextResponse.json(
      { error: `Higgsfield image call failed: ${getErrorMessage(e)}` },
      { status: 502 },
    );
  }
}
