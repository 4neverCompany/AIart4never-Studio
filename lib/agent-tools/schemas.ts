/**
 * v1.2 Tool Registry — Zod schemas for tool inputs/outputs.
 *
 * ADR-005: CLI/HTTP wrappers for v1.2+ agentic AI. The schemas here are
 * the boundary contract between the Vercel AI SDK tool() definitions in
 * `lib/agent-tools/*` and the route handlers / agent loops that consume
 * them. The AI SDK wires these schemas into the model prompt for tool-
 * call shape, AND validates the model's tool-call output before invoking
 * `execute()`.
 *
 * Why Zod (vs. plain TS types):
 *   1. The model emits a tool-call JSON blob — Zod validates it at
 *      runtime, so a hallucinated field becomes a typed ValidationError
 *      instead of a silent `undefined` downstream.
 *   2. The same schema gives us compile-time inference (`z.infer<...>`)
 *      for the consumer side, so the type and the runtime guard are
 *      the same source of truth.
 *
 * Naming convention: `z<PascalCase>` for schemas. The inferred types
 * are exported under the same name without the `z` prefix (e.g.
 * `zGeneratePromptInput` schema → `GeneratePromptInput` type) so
 * call sites read naturally.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared atoms
// ---------------------------------------------------------------------------

/**
 * `niche` is a free-form string carrying a Master4never CONTENT PILLAR or
 * canon reality (e.g. "Story-Beat", "Variant Reveal", "Cyberpunk PRIME").
 * The model is allowed to refine it; we only enforce non-empty + length cap
 * so a runaway model can't flood the tool-call payload. (The legacy "niche"
 * name is kept for settings/schema back-compat — the VALUES are canon, never
 * third-party franchises or crossovers.)
 */
export const zNicheString = z
  .string()
  .trim()
  .min(1, 'niche cannot be empty')
  .max(80, 'niche too long (max 80 chars)');
export type NicheString = z.infer<typeof zNicheString>;

/** Same shape as `zNicheString` — a style tag the user picked. */
export const zGenreString = z
  .string()
  .trim()
  .min(1, 'genre cannot be empty')
  .max(80, 'genre too long (max 80 chars)');
export type GenreString = z.infer<typeof zGenreString>;

/** A free-form on-canon beat/concept (e.g. "Kael steps into the W40K reality
 *  and meets Kaelus Vorne across a candle-lit nave"). */
export const zAngleString = z
  .string()
  .trim()
  .min(3, 'angle must be at least 3 chars')
  .max(400, 'angle too long (max 400 chars)');
export type AngleString = z.infer<typeof zAngleString>;

/** A free-form skill name surfaced in the user's settings. */
export const zSkillNameString = z
  .string()
  .trim()
  .min(1, 'skill name cannot be empty')
  .max(80, 'skill name too long (max 80 chars)');
export type SkillNameString = z.infer<typeof zSkillNameString>;

/**
 * AssetRef: the canonical pointer to a generated asset regardless of
 * which provider made it. Every provider returns one of these so
 * downstream tools (persist_asset, generate_video) can be provider-
 * agnostic.
 */
export const zAssetRef = z.object({
  provider: z.enum(['higgsfield', 'minimax', 'leonardo', 'openai', 'mock']),
  id: z.string().min(1, 'asset id is required'),
  url: z.string().url('asset url must be a valid URL'),
});
export type AssetRef = z.infer<typeof zAssetRef>;

// ---------------------------------------------------------------------------
// 1. reference-context row (M1 CANON-NATIVE)
// ---------------------------------------------------------------------------
//
// M1 CANON-NATIVE: the old `trending_search` tool + its camofox-macro
// crossover/fan-art trend-trawling is GONE. The Director is on-canon: its
// "context" is the canon system block + the locked character Element, not the
// web. The only survivor is this generic reference-context row, an OPTIONAL
// flavour input on `generate_prompt` for the rare case a research connector
// (lib/research) has supplied canon-relevant reference. It is NOT a default
// step and never carries crossover trends.

/**
 * One optional reference-context row the model may fold into a draft as
 * flavour (e.g. a canon-relevant concept-art reference from a configured
 * research connector). Free-form `source` label; no franchise / crossover
 * framing.
 */
export const zTrendResult = z.object({
  title: z.string().min(1),
  url: z.string().url(),
  snippet: z.string().default(''),
  /** Content pillar / reality this reference relates to. */
  niche: z.string().min(1),
  /** Free-form source label for the reference (e.g. a research connector id). */
  source: z.string().min(1),
});
export type TrendResult = z.infer<typeof zTrendResult>;

// ---------------------------------------------------------------------------
// 2. generate_prompt
// ---------------------------------------------------------------------------

/**
 * A "skill" is a named fragment of domain knowledge the user has
 * enabled in settings (e.g. "framing:camera-angles", "voice:noir").
 * generate_prompt surfaces which skills it consumed so the prompt
 * stage can be replayed/audited.
 */
export const zSkillRef = z.object({
  name: zSkillNameString,
  /** Optional version pin so the audit log can replay deterministically. */
  version: z.string().max(20).optional(),
});
export type SkillRef = z.infer<typeof zSkillRef>;

export const zGeneratePromptInput = z.object({
  niches: z
    .array(zNicheString)
    .min(1, 'generate_prompt requires at least one content pillar')
    .max(6)
    .describe('Canon content pillars / realities that anchor the beat (e.g. "Variant Reveal", "Cyberpunk PRIME").'),
  genres: z
    .array(zGenreString)
    .min(1, 'generate_prompt requires at least one style')
    .max(10)
    .describe('Canon style tags (e.g. "Cinematic", "Grimdark", "Neo-Noir").'),
  angle: zAngleString.describe(
    'The on-canon Master4never beat the prompt should realise (e.g. "Kael steps into the W40K reality and meets Kaelus Vorne").',
  ),
  /** Skills auto-injected at build-time (e.g. camera-angles, voice guides). */
  skillContext: z
    .array(zSkillRef)
    .max(20)
    .default([])
    .describe('Optional list of active skills to fold into the prompt template.'),
  /** Optional canon-relevant reference context (from a research connector, if any). */
  trendingContext: z
    .array(zTrendResult)
    .max(30)
    .optional()
    .describe('Optional canon-relevant reference rows (from a configured research connector). Used only as flavour; not a default step.'),
});
export type GeneratePromptInput = z.infer<typeof zGeneratePromptInput>;

export const zGeneratePromptOutput = z.object({
  draft: z
    .string()
    .min(40, 'prompt draft too short (<40 chars) — model likely truncated')
    .max(2000, 'prompt draft too long (>2000 chars) — model likely hallucinated')
    .describe('The generated image-prompt draft, ready for critique/refine.'),
  usedSkills: z
    .array(zSkillNameString)
    .describe('Subset of skillContext that materially influenced the draft (for audit log).'),
  /** Model id used (e.g. "MiniMax-M3") — recorded for cost/perf telemetry. */
  modelId: z.string().min(1),
});
export type GeneratePromptOutput = z.infer<typeof zGeneratePromptOutput>;

// ---------------------------------------------------------------------------
// 3. critique_prompt
// ---------------------------------------------------------------------------

/**
 * The critique step scores a draft prompt against explicit acceptance
 * requirements. The Director loop regenerates if `score < 0.7` (the
 * threshold lives in `lib/agent-eval/` — see v1.2.4).
 */
export const zCritiqueRequirements = z.object({
  niches: z
    .array(zNicheString)
    .min(1)
    .describe('Niches the prompt MUST visibly mention (niche-coverage check).'),
  genres: z
    .array(zGenreString)
    .default([])
    .describe('Optional genres the prompt should lean on.'),
  angle: zAngleString.describe('The angle/concept the prompt must realise.'),
  /**
   * If true, the prompt must contain at least one negative token
   * (e.g. "no CGI", "avoid over-saturated colours"). The flag tells
   * the self-critique to weight the anti-AI-look heuristic higher.
   */
  antiAiLook: z
    .boolean()
    .default(true)
    .describe('If true, requires explicit anti-AI-look tokens in the prompt.'),
});
export type CritiqueRequirements = z.infer<typeof zCritiqueRequirements>;

export const zCritiquePromptInput = z.object({
  prompt: z
    .string()
    .min(20, 'prompt to critique is too short (<20 chars)')
    .max(4000)
    .describe('The draft prompt the Director generated in the previous step.'),
  requirements: zCritiqueRequirements,
});
export type CritiquePromptInput = z.infer<typeof zCritiquePromptInput>;

export const zCritiquePromptOutput = z.object({
  /**
   * Score in [0, 1]. The Director loop regenerates when score < 0.7.
   * 1.0 = meets every requirement, 0.0 = fails every check.
   */
  score: z
    .number()
    .min(0)
    .max(1)
    .describe('Composite quality score in [0, 1]. Director regenerates below 0.7.'),
  /**
   * Free-form list of issues, ordered most-severe first. The Director
   * loop surfaces these to the next draft attempt as "what to fix".
   */
  issues: z
    .array(z.string().min(1).max(400))
    .default([])
    .describe('Specific problems detected (empty when score is 1.0).'),
});
export type CritiquePromptOutput = z.infer<typeof zCritiquePromptOutput>;

// ---------------------------------------------------------------------------
// 4. generate_image
// ---------------------------------------------------------------------------

/**
 * Image-generation settings. Provider-agnostic; the tool's execute()
 * routes to the underlying provider's API/CLI based on `model`.
 *
 * Only the fields the AI SDK's tool schema can pass are listed here;
 * per-provider niceties (Higgsfield soul-id, Leonardo alchemy) are
 * added under `providerOptions` and validated at execute() time, not
 * at the schema level (the model has no way to learn them).
 */
export const zImageSettings = z.object({
  /** Aspect ratio. Defaults to 1:1; provider-specific whitelisting enforced at execute(). */
  aspectRatio: z
    .enum(['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '9:16', '16:9', '21:9'])
    .default('1:1')
    .describe('Target aspect ratio. Provider may reject unsupported ratios at execute time.'),
  resolution: z
    .enum(['1k', '2k', '4k'])
    .default('1k')
    .describe('Output resolution. 4k costs more credits on most providers.'),
  /** RNG seed for reproducibility. 0 = random. */
  seed: z
    .number()
    .int()
    .min(0)
    .max(2_147_483_647)
    .default(0)
    .describe('Deterministic seed (0 = random). Same seed + prompt = same output.'),
});
export type ImageSettings = z.infer<typeof zImageSettings>;

/**
 * Default image settings — exposed so callers (tests, the route
 * layer) can spread `{ ...IMAGE_SETTINGS_DEFAULTS, aspectRatio: '4:5' }`
 * instead of repeating the literal.
 */
export const IMAGE_SETTINGS_DEFAULTS = {
  aspectRatio: '1:1' as const,
  resolution: '1k' as const,
  seed: 0,
};

export const zGenerateImageInput = z.object({
  model: z
    .string()
    .min(1)
    .max(120)
    .describe('Model slug (e.g. "nano_banana_2", "flux_2", "gpt_image_2").'),
  prompt: z
    .string()
    .min(20)
    .max(4000)
    .describe('The image prompt to render. Critique score must be >= 0.7 before this is called.'),
  /**
   * Settings block. We accept a partial — the tool applies the
   * IMAGE_SETTINGS_DEFAULTS internally and overrides per-field. This
   * matches the Vercel AI SDK convention of "the model can omit
   * optional fields without violating the schema".
   */
  settings: z
    .object({
      aspectRatio: zImageSettings.shape.aspectRatio.optional(),
      resolution: zImageSettings.shape.resolution.optional(),
      seed: zImageSettings.shape.seed.optional(),
    })
    .optional()
    .describe('Per-model settings. Omitted fields fall back to IMAGE_SETTINGS_DEFAULTS.'),
  /** Free-form provider options (soul-id, alchemy, etc.). Validated downstream. */
  providerOptions: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Provider-specific knobs. The tool validates them in execute() before forwarding.'),
});
export type GenerateImageInput = z.infer<typeof zGenerateImageInput>;

export const zGenerateImageOutput = z.object({
  assetRef: zAssetRef,
  /** Approximate credit cost the provider reported — surfaced in the budget HUD. */
  creditsCharged: z.number().int().min(0).optional(),
});
export type GenerateImageOutput = z.infer<typeof zGenerateImageOutput>;

// ---------------------------------------------------------------------------
// 5. generate_video
// ---------------------------------------------------------------------------

export const zVideoSettings = z.object({
  aspectRatio: z
    .enum(['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '9:16', '16:9', '21:9'])
    .default('16:9')
    .describe('Target aspect ratio. "auto" lets the provider pick from the prompt.'),
  durationSec: z
    .number()
    .int()
    .min(2)
    .max(15)
    .default(5)
    .describe('Output length in seconds. Provider-specific caps enforced at execute().'),
  seed: z.number().int().min(0).max(2_147_483_647).default(0),
});
export type VideoSettings = z.infer<typeof zVideoSettings>;

/** Default video settings — same pattern as IMAGE_SETTINGS_DEFAULTS. */
export const VIDEO_SETTINGS_DEFAULTS = {
  aspectRatio: '16:9' as const,
  durationSec: 5,
  seed: 0,
};

export const zGenerateVideoInput = z.object({
  model: z
    .string()
    .min(1)
    .max(120)
    .describe('Video model slug (e.g. "seedance_2_0", "veo3_1", "wan2_6").'),
  prompt: z
    .string()
    .min(20)
    .max(4000)
    .describe('The video prompt. Same critique-gating as image generation.'),
  settings: z
    .object({
      aspectRatio: zVideoSettings.shape.aspectRatio.optional(),
      durationSec: zVideoSettings.shape.durationSec.optional(),
      seed: zVideoSettings.shape.seed.optional(),
    })
    .optional()
    .describe('Per-model settings. Omitted fields fall back to VIDEO_SETTINGS_DEFAULTS.'),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
});
export type GenerateVideoInput = z.infer<typeof zGenerateVideoInput>;

export const zGenerateVideoOutput = z.object({
  assetRef: zAssetRef,
  creditsCharged: z.number().int().min(0).optional(),
});
export type GenerateVideoOutput = z.infer<typeof zGenerateVideoOutput>;

// ---------------------------------------------------------------------------
// 6. persist_asset
// ---------------------------------------------------------------------------

/**
 * Asset metadata recorded alongside the persisted asset. We deliberately
 * keep this small — the heavy metadata (full prompt, generation params)
 * lives on the provider side and is reconstructed by `assetRef.provider +
 * assetRef.id` on demand.
 */
export const zAssetMetadata = z.object({
  /** Display title (e.g. file name or "Kaelus Vorne — Ashen Halo #12"). */
  title: z.string().trim().min(1).max(200),
  /** Optional caption. */
  caption: z.string().max(2200).optional(),
  /** Tags the user/agent has associated with the asset. */
  tags: z.array(zNicheString.or(zGenreString)).max(40).default([]),
  /** Asset kind — drives the Studio gallery filter. */
  kind: z.enum(['image', 'video']).default('image'),
  /** Optional pointer back to the post this asset was generated for. */
  postId: z.string().max(120).optional(),
});
export type AssetMetadata = z.infer<typeof zAssetMetadata>;

export const zPersistAssetInput = z.object({
  assetRef: zAssetRef,
  metadata: zAssetMetadata,
});
export type PersistAssetInput = z.infer<typeof zPersistAssetInput>;

export const zPersistAssetOutput = z.object({
  /** The AIart4never Studio-internal asset id (idb/tauri-store key). */
  assetId: z
    .string()
    .min(1)
    .max(120)
    .describe('AIart4never Studio-internal id under which the asset was persisted.'),
  persistedAt: z
    .number()
    .int()
    .describe('Unix epoch ms when the asset was written to storage.'),
});
export type PersistAssetOutput = z.infer<typeof zPersistAssetOutput>;

// ---------------------------------------------------------------------------
// 7. m3_vision_describe (V1.2.6)
// ---------------------------------------------------------------------------

/**
 * V1.2.6: MiniMax-M3 vision describe — image INPUT, text OUTPUT.
 *
 * M3 is a text+vision model (per the MiniMax-M3 announcement,
 * 2026-06-01). AIart4never Studio's primary text-AI path
 * (`app/api/ai/prompt`) uses the OpenAI-compatible chat
 * completions endpoint which is text-only. This tool exposes
 * M3's vision capability through the `mmx` CLI's
 * `vision describe` subcommand, letting the Director loop
 * (which runs over the Vercel AI SDK `generateText` agent
 * loop) ask M3 to describe / score a generated image.
 *
 * Use case in the Director loop:
 *   1. `generate_image` returns an `AssetRef` with a URL/path.
 *   2. `m3_vision_describe` asks M3 "is this image consistent
 *      with the original concept? Score 0-1 and list issues."
 *   3. The critique result is fed back into `critique_prompt`
 *      and the loop iterates.
 *
 * The mmx CLI is the production path for M3 in AIart4never Studio
 * (per the v1.2.0 mmx-cli-integration brief). It calls
 * `mmx vision describe` which handles auth + the actual
 * multimodal request. This tool is a thin Zod-validated
 * wrapper around the existing `describeImage()` function in
 * `lib/mmx-client.ts`.
 */
export const zM3VisionDescribeInput = z
  .object({
    /**
     * Where to read the image from. Exactly one of the three
     * fields must be present. The `url` and `id` cases are
     * pre-resolved by the CLI binary to a local file before
     * the call.
     */
    imagePath: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe('Absolute local path to the image file.'),
    imageUrl: z
      .string()
      .url()
      .max(2000)
      .optional()
      .describe('HTTPS URL of the image. The mmx CLI downloads it.'),
    imageId: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('AIart4never Studio-internal asset id; mmx resolves it to a local path.'),
    /**
     * Question to ask about the image. Defaults to a generic
     * description when omitted. The model is multimodal but
     * the call is text-only output, so the prompt should be
     * phrased as a question or a checklist.
     */
    prompt: z
      .string()
      .min(1)
      .max(800)
      .default('Describe this image in detail. Note any obvious visual issues (clipping, NSFW, off-style).')
      .describe('What to ask about the image. Free-form question or checklist.'),
  })
  .refine(
    (v) => Boolean(v.imagePath) || Boolean(v.imageUrl) || Boolean(v.imageId),
    { message: 'at least one of imagePath / imageUrl / imageId is required' },
  );
export type M3VisionDescribeInput = z.infer<typeof zM3VisionDescribeInput>;

export const zM3VisionDescribeOutput = z.object({
  description: z
    .string()
    .min(1)
    .max(8000)
    .describe("M3's textual answer. May be a description, a critique, or a 0-1 score depending on the prompt."),
  /** Wall-clock duration the mmx CLI reported. */
  durationMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Generation duration in ms (for budget tracking).'),
});
export type M3VisionDescribeOutput = z.infer<typeof zM3VisionDescribeOutput>;
