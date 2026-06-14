/**
 * Higgsfield model catalog.
 *
 * Sourced from the official CLI's MODELS.md (higgsfield-ai/cli) and
 * cross-referenced with the public landing page. Slugs are the
 * `job_set_type` identifiers the MCP `higgsfield_generate` tool
 * accepts in its `model` field.
 *
 * MashupForge surfaces 4 image models + 3 video models in the UI
 * (the "kitchen-sink" picker would overwhelm the Studio panel).
 * Users who want every model can call them via the CLI:
 *
 *     npx @higgsfield/cli model list
 *
 * or via the MCP server in any agent context.
 */

export type HiggsfieldImageModelSlug =
  | 'nano_banana_2'      // Nano Banana Pro — flagship 4K-capable
  | 'nano_banana_flash'  // Nano Banana 2 — fast variant
  | 'flux_2'             // FLUX.2 (pro/flex/max)
  | 'gpt_image_2'        // GPT Image 2
  | 'seedream_v4_5'      // Seedream 4.5
  | 'text2image_soul_v2' // Higgsfield Soul V2 — best for character consistency
  | 'image_auto';        // Image Auto — let Higgsfield pick the best model

export type HiggsfieldVideoModelSlug =
  | 'seedance_2_0'       // Seedance 2.0 — "Hollywood film" default
  | 'seedance1_5'        // Seedance 1.5 Pro
  | 'kling3_0'           // Kling v3.0
  | 'veo3_1'             // Google Veo 3.1
  | 'veo3_1_lite'        // Google Veo 3.1 Lite — faster/cheaper
  | 'wan2_6'             // Wan 2.6 Video
  | 'minimax_hailuo';    // MiniMax Hailuo 02

export interface HiggsfieldModelMeta {
  slug: string;
  displayName: string;
  family: 'nano-banana' | 'flux' | 'gpt-image' | 'seedream' | 'soul' | 'auto' | 'seedance' | 'kling' | 'veo' | 'wan' | 'minimax';
  /** Tag shown in the UI badge. */
  badge?: 'fast' | 'cheap' | 'flagship' | 'character' | 'pro';
  /** Short blurb shown in the model picker tooltip. */
  blurb: string;
  /** Aspect ratios this model supports. Empty = model rejects aspect ratios. */
  aspectRatios: readonly string[];
  /** Resolutions supported (for image models that take `--resolution`). */
  resolutions?: readonly string[];
  /** Approximate credit cost per generation (rough; user-facing hint only). */
  creditHint: number;
}

// Curated subset of the 35-model catalog — just what the Studio
// needs. Adding a model here surfaces it in /api/ai/models and the
// Higgsfield model picker.
export const HIGGSFIELD_IMAGE_MODELS: readonly HiggsfieldModelMeta[] = [
  {
    slug: 'nano_banana_2',
    displayName: 'Nano Banana Pro',
    family: 'nano-banana',
    badge: 'flagship',
    blurb: 'Higgsfield\'s flagship image model. 4K capable, very fast, good all-rounder. Our recommended default for Instagram-first content.',
    aspectRatios: ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '9:16', '16:9', '21:9'],
    resolutions: ['1k', '2k', '4k'],
    creditHint: 4,
  },
  {
    slug: 'nano_banana_flash',
    displayName: 'Nano Banana 2',
    family: 'nano-banana',
    badge: 'fast',
    blurb: 'Fast Nano Banana variant. Slightly lower quality than Pro but cheaper and quicker.',
    aspectRatios: ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '9:16', '16:9', '21:9'],
    resolutions: ['1k', '2k', '4k'],
    creditHint: 2,
  },
  {
    slug: 'image_auto',
    displayName: 'Auto (Higgsfield picks)',
    family: 'auto',
    blurb: 'Let Higgsfield pick the best model for your prompt. Good default when you don\'t have a preference.',
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
    creditHint: 3,
  },
  {
    slug: 'flux_2',
    displayName: 'FLUX.2',
    family: 'flux',
    badge: 'pro',
    blurb: 'FLUX.2 in pro mode. Best for stylized branded visuals. Sub-models: pro, flex, max.',
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
    resolutions: ['1k', '2k'],
    creditHint: 5,
  },
  {
    slug: 'gpt_image_2',
    displayName: 'GPT Image 2',
    family: 'gpt-image',
    blurb: 'OpenAI\'s latest image model. Strong prompt adherence. Up to 4K.',
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'],
    resolutions: ['1k', '2k', '4k'],
    creditHint: 6,
  },
  {
    slug: 'seedream_v4_5',
    displayName: 'Seedream 4.5',
    family: 'seedream',
    blurb: 'ByteDance Seedream 4.5. Strong for product photography and product-on-model shots.',
    aspectRatios: ['1:1', '4:3', '16:9', '3:2', '21:9', '3:4', '9:16', '2:3'],
    creditHint: 4,
  },
  {
    slug: 'text2image_soul_v2',
    displayName: 'Higgsfield Soul V2',
    family: 'soul',
    badge: 'character',
    blurb: 'Best for character consistency. Train a Soul ID once, reuse forever. Optional --soul-id parameter.',
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
    creditHint: 3,
  },
] as const;

export const HIGGSFIELD_VIDEO_MODELS: readonly HiggsfieldModelMeta[] = [
  {
    slug: 'seedance_2_0',
    displayName: 'Seedance 2.0',
    family: 'seedance',
    badge: 'flagship',
    blurb: 'ByteDance Seedance 2.0. Current "Hollywood film" model. Modes: std/fast. Genres: auto/action/horror/comedy/noir/drama/epic. Our recommended default.',
    aspectRatios: ['auto', '16:9', '9:16', '4:3', '3:4', '1:1', '21:9'],
    creditHint: 20,
  },
  {
    slug: 'seedance1_5',
    displayName: 'Seedance 1.5 Pro',
    family: 'seedance',
    blurb: 'Seedance 1.5 Pro. 4/8/12 second durations. Reliable, well-tested.',
    aspectRatios: ['auto', '16:9', '9:16', '4:3', '3:4', '1:1', '21:9'],
    creditHint: 18,
  },
  {
    slug: 'kling3_0',
    displayName: 'Kling v3.0',
    family: 'kling',
    blurb: 'Kuaishou Kling v3.0. Pro and std modes. Strong UGC and motion control.',
    aspectRatios: ['16:9', '9:16', '1:1'],
    creditHint: 25,
  },
  {
    slug: 'veo3_1',
    displayName: 'Google Veo 3.1',
    family: 'veo',
    badge: 'pro',
    blurb: 'Google\'s best. 4/6/8s durations. Quality: basic/high/ultra. Slow but worth it.',
    aspectRatios: ['16:9', '9:16'],
    creditHint: 50,
  },
  {
    slug: 'veo3_1_lite',
    displayName: 'Google Veo 3.1 Lite',
    family: 'veo',
    badge: 'cheap',
    blurb: 'Faster, cheaper Veo. Supports start/end-image, video, audio references.',
    aspectRatios: ['16:9', '9:16', 'auto'],
    creditHint: 18,
  },
  {
    slug: 'wan2_6',
    displayName: 'Wan 2.6 Video',
    family: 'wan',
    blurb: 'Alibaba Wan 2.6. 5/10/15 second durations. 720p or 1080p.',
    aspectRatios: ['16:9', '9:16', '1:1'],
    creditHint: 22,
  },
  {
    slug: 'minimax_hailuo',
    displayName: 'MiniMax Hailuo 02',
    family: 'minimax',
    badge: 'cheap',
    blurb: 'MiniMax Hailuo 02. Sub-models: hailuo, hailuo-fast, hailuo-2.3, hailuo-2.3-fast. Cheap option for volume.',
    aspectRatios: [],
    creditHint: 10,
  },
] as const;

export function getHiggsfieldImageModel(slug: string): HiggsfieldModelMeta | undefined {
  return HIGGSFIELD_IMAGE_MODELS.find((m) => m.slug === slug);
}

export function getHiggsfieldVideoModel(slug: string): HiggsfieldModelMeta | undefined {
  return HIGGSFIELD_VIDEO_MODELS.find((m) => m.slug === slug);
}

export const HIGGSFIELD_DEFAULT_IMAGE_MODEL: HiggsfieldImageModelSlug = 'nano_banana_2';
export const HIGGSFIELD_DEFAULT_VIDEO_MODEL: HiggsfieldVideoModelSlug = 'seedance_2_0';
