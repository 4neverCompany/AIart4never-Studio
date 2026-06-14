/**
 * v1.3 Tool Registry — `reframe_image` tool.
 *
 * Regenerates an existing image at a new aspect ratio, using the
 * original image as a character/style reference. This is the
 * primary use case for Instagram cross-posting: a 1:1 feed image
 * becomes 9:16 for Stories or 4:5 for Reels, with the same
 * subject/composition.
 *
 * Implementation: calls the Higgsfield CLI's `generate create`
 * with the original image URL as a reference and the new
 * `--aspect-ratio` value. No new model needed — every supported
 * image model accepts `--image` references.
 *
 * Credit cost: same as a fresh generation of the chosen model.
 * Use `cost_estimate` to preview before reframe.
 */

import { tool } from 'ai';
import { z } from 'zod';
import {
  ToolNotAvailableError,
  ToolExecutionError,
  safeExecute,
  type ToolResult,
} from './errors';
import { getProvider } from '@/lib/providers/registry';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/** Aspect ratios the tool accepts (Instagram + general). */
export const SUPPORTED_ASPECT_RATIOS = [
  '1:1',  // Instagram feed
  '4:5',  // Instagram portrait
  '3:4',  // print-ish portrait
  '9:16', // Instagram Stories / TikTok
  '16:9', // YouTube / landscape
  '3:2',  // classic 35mm
  '2:3',  // classic 35mm portrait
  '21:9', // ultrawide
] as const;

export const zReframeImageInput = z.object({
  /** The image to reframe. URL or local path; CLI auto-uploads URLs. */
  sourceImage: z.union([
    z.string().url('sourceImage must be a valid URL when a string'),
    z.string().min(1, 'sourceImage path cannot be empty'),
  ]),
  /** The original prompt — used to maintain composition on regen. */
  sourcePrompt: z
    .string()
    .trim()
    .min(1, 'sourcePrompt cannot be empty')
    .max(4000, 'sourcePrompt too long (max 4000 chars)'),
  /** Target aspect ratio (e.g. "9:16" for Stories). */
  targetAspectRatio: z.enum(SUPPORTED_ASPECT_RATIOS),
  /** Model to use. Defaults to nano_banana_2 (flagship + 4K capable). */
  model: z
    .string()
    .trim()
    .min(1)
    .default('nano_banana_2')
    .describe('Higgsfield model slug. Defaults to nano_banana_2.'),
  /** Optional: target resolution. Most models support 1k/2k/4k. */
  resolution: z
    .enum(['1k', '2k', '4k'])
    .optional()
    .describe('Target resolution. Omit for model default.'),
});
export type ReframeImageInput = z.infer<typeof zReframeImageInput>;

export const zReframeImageOutput = z.object({
  /** Public URL to the new reframed image. */
  url: z.string().url().optional(),
  /** Local file path if the adapter wrote the asset to disk. */
  path: z.string().optional(),
  /** Provider-internal request id (for async jobs). */
  requestId: z.string().optional(),
  /** Provider that produced the asset. */
  provider: z.literal('higgsfield'),
  /** The new aspect ratio of the output (echoed back for UI confirmation). */
  aspectRatio: z.string(),
  /** Echoed model slug. */
  model: z.string(),
  /** Raw CLI response (for debugging). */
  raw: z.unknown().optional(),
});
export type ReframeImageOutput = z.infer<typeof zReframeImageOutput>;

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Reframe an existing image by regenerating it at a new aspect ratio.
 * The source image is passed to the CLI as a reference so the new
 * image preserves the subject, palette, and composition.
 */
export async function executeReframeImage(
  rawInput: unknown,
  opts: { signal?: AbortSignal } = {},
): Promise<ToolResult<ReframeImageOutput>> {
  return safeExecute(async () => {
    const parsed = zReframeImageInput.safeParse(rawInput);
    if (!parsed.success) throw parsed.error;
    const input = parsed.data;

    // Routing: the reframe flow always goes through the CLI adapter
    // (the text adapter is text-only). If the registry doesn't have
    // the CLI adapter wired, surface a clear error.
    let adapter;
    try {
      adapter = getProvider('higgsfield');
    } catch {
      throw new ToolNotAvailableError(
        'reframe_image',
        'provider "higgsfield" is not registered — check lib/providers/registry.ts',
      );
    }

    const available = await adapter.isAvailable();
    if (!available) {
      throw new ToolNotAvailableError(
        'reframe_image',
        'Higgsfield CLI is not available on PATH (higgsfield or higgs binary missing)',
      );
    }

    // Call the CLI adapter's generateImage with the source as
    // reference + the new aspect ratio. The adapter handles URL
    // auto-upload via the `--image` flag.
    const adapterAny = adapter as unknown as {
      generateImage(opts: {
        prompt: string;
        aspectRatio?: string;
        referenceImage?: { url?: string; path?: string; id?: string };
        model?: string;
        signal?: AbortSignal;
      }): Promise<{
        kind: 'image' | 'video' | 'job';
        provider: string;
        url?: string;
        path?: string;
        jobId?: string;
        raw?: unknown;
      }>;
    };

    if (typeof adapterAny.generateImage !== 'function') {
      throw new ToolExecutionError(
        'reframe_image',
        'higgsfield adapter does not implement generateImage',
        { retryable: false },
      );
    }

    // Determine whether the source is a URL or a local path
    const isUrl = /^https?:\/\//.test(input.sourceImage);
    const referenceImage = isUrl
      ? { url: input.sourceImage }
      : { path: input.sourceImage };

    let asset;
    try {
      asset = await adapterAny.generateImage({
        prompt: input.sourcePrompt,
        aspectRatio: input.targetAspectRatio,
        referenceImage,
        model: input.model,
        signal: opts.signal,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ToolExecutionError('reframe_image', msg, { retryable: true, cause: e });
    }

    return zReframeImageOutput.parse({
      url: asset.url,
      path: asset.path,
      requestId: asset.jobId,
      provider: 'higgsfield' as const,
      aspectRatio: input.targetAspectRatio,
      model: input.model,
      raw: asset.raw,
    });
  });
}

// ---------------------------------------------------------------------------
// Vercel AI SDK `tool()` definition
// ---------------------------------------------------------------------------

export const reframeImageTool = tool({
  description:
    'Reframe an existing image at a new aspect ratio (e.g. 1:1 → 9:16 for Instagram Stories). Regenerates the image with the source as a character/style reference so the subject and composition are preserved. Returns a new AssetRef for the reframed image. Cost: same as a fresh generation of the chosen model — use cost_estimate to preview.',
  inputSchema: zReframeImageInput,
  outputSchema: zReframeImageOutput,
  execute: async (input, options) => {
    const result = await executeReframeImage(input, {
      signal: options?.abortSignal,
    });
    if (!result.ok) throw result.error;
    return result.value;
  },
});
