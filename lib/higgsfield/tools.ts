/**
 * Higgsfield MCP tool catalog.
 *
 * The MCP server at https://mcp.higgsfield.ai/mcp exposes 7 curated
 * tools. The list is what `tools/list` returns; the schemas are
 * what we can derive from Higgsfield's public docs + their Node SDK
 * (`@higgsfield/client`) which uses the same underlying job_set_type
 * slugs (nano_banana_2, seedance_2_0, etc.).
 *
 * We treat the MCP tool surface as a thin orchestration layer over
 * the 30+ REST models. The catalog below lets the UI render picker
 * options that match what `tools/call` actually accepts.
 *
 * Two of the seven tools are dedicated cinematic helpers
 * (Cinema Studio, Soul Cast) and three are creative-asset helpers
 * (Marketing Studio, UGC Factory, Talking Avatar). The "Swiss Army
 * knife" `higgsfield_generate` tool is the one we use most often —
 * it takes a `model` field and dispatches to the right underlying
 * generator.
 */

export type HiggsfieldToolName =
  | 'higgsfield_generate'
  | 'higgsfield_video_analyzer'
  | 'higgsfield_marketing_video'
  | 'higgsfield_soul_train'
  | 'higgsfield_cinema_image_to_video'
  | 'higgsfield_viral_clip'
  | 'higgsfield_virality_predictor';

export interface HiggsfieldToolMeta {
  name: HiggsfieldToolName;
  /** Display name for the UI. */
  label: string;
  /** One-line description shown in tooltips. */
  description: string;
  /** 'image' if the tool produces images, 'video' for video, 'audio' for
   * audio/lipsync, 'analysis' for virality scoring, 'character' for Soul. */
  kind: 'image' | 'video' | 'audio' | 'analysis' | 'character';
  /** Whether this tool requires a reference image (start frame, character ref, etc.). */
  requiresImage?: 'start' | 'end' | 'character-refs' | 'video' | 'audio';
}

export const HIGGSFIELD_TOOLS: readonly HiggsfieldToolMeta[] = [
  {
    name: 'higgsfield_generate',
    label: 'Generate image or video',
    description: 'Direct generation with access to 30+ models (Nano Banana Pro, Seedance 2.0, Veo 3.1, Kling 3.0, etc.).',
    kind: 'image',
  },
  {
    name: 'higgsfield_video_analyzer',
    label: 'Analyze reference video',
    description: 'Analyses a reference video for style, motion, and pacing cues before generation.',
    kind: 'analysis',
    requiresImage: 'video',
  },
  {
    name: 'higgsfield_marketing_video',
    label: 'Marketing video (from product URL)',
    description: 'Generates a marketing video starting from a product page URL. Best for ads / DTC.',
    kind: 'video',
  },
  {
    name: 'higgsfield_soul_train',
    label: 'Train Soul character',
    description: 'Builds a consistent character (soul_id) from 8 reference photos. Reusable across all future generations.',
    kind: 'character',
    requiresImage: 'character-refs',
  },
  {
    name: 'higgsfield_cinema_image_to_video',
    label: 'Cinematic image-to-video',
    description: 'Animates a still image with a cinematic preset (e.g. "Bullet Time", "360° Orbit").',
    kind: 'video',
    requiresImage: 'start',
  },
  {
    name: 'higgsfield_viral_clip',
    label: 'Viral clip generator',
    description: 'Cuts a long video into short-form clips with subtitles, optimized for TikTok/Reels/Shorts.',
    kind: 'video',
    requiresImage: 'video',
  },
  {
    name: 'higgsfield_virality_predictor',
    label: 'Virality predictor',
    description: 'Scores a finished video for hook strength, attention, retention, and viral potential.',
    kind: 'analysis',
    requiresImage: 'video',
  },
] as const;

export function getToolMeta(name: string): HiggsfieldToolMeta | undefined {
  return HIGGSFIELD_TOOLS.find((t) => t.name === name);
}
