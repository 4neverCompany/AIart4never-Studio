/**
 * M3.4-P4-B3: shared types for the image-generation pipeline.
 * Lifted out of `hooks/useImageGeneration.ts` so the hook only
 * has to manage React state + provider dispatch, not type
 * declarations.
 *
 * Every interface here is used by both the main `useImageGeneration`
 * hook AND at least one of the four provider-submit helpers
 * (`submitLeonardoAndPoll`, `submitViaAiImage`, the
 * `submitMinimaxImage` block, the `submitHiggsfieldImage` block).
 * Keeping them in a shared module means a hook split or a
 * server-side handler extraction can re-import just the types
 * they need.
 */
import type { UserSettings } from '@/types/mashup';

export interface GeneratedItem {
  prompt: string;
  aspectRatio?: string;
  tags?: string[];
  selectedNiches?: string[];
  selectedGenres?: string[];
  negativePrompt?: string;
  /**
   * V1.7.0-M2.1: per-item camera angle chosen by the idea model from
   * the 14-slug catalog. Validated against the catalog at parse time;
   * an invalid/absent value falls back to `settings.cameraAngle`.
   */
  cameraAngle?: string;
}

export interface LeonardoSubmitParams {
  prompt: string;
  negativePrompt?: string;
  /** V1.0.7-PROMPT-ENG-A4: anti-AI-look curated negative prompts from
   *  buildEnhancedPrompt. Joined with `negativePrompt` inside
   *  submitLeonardoAndPoll before sending to the API. Empty array
   *  means "no anti-AI-look" — equivalent to the prior behavior. */
  antiAiLookNegatives?: string[];
  modelId: string;
  width: number;
  height: number;
  styleIds?: string[];
  apiKey?: string;
  quality?: string;
  /**
   * IMG-INVEST-001 issue 1: Leonardo's `prompt_enhance` knob, threaded
   * from the model spec via lib/image-prompt-builder.ts. When omitted,
   * the API route defaults to `'ON'` for back-compat. Pipeline-style
   * model specs that set `prompt_enhance: 'OFF'` (to skip Leonardo's
   * own rewrite because the client already enhanced) finally land
   * through this field instead of being silently dropped.
   */
  promptEnhance?: 'ON' | 'OFF';
}

export interface LeonardoSuccess {
  url: string;
  imageId?: string;
  seed?: number;
}

export type LeonardoGenerationError = Error & {
  moderationClassification?: string[];
  failedPrompt?: string;
  moderation?: unknown;
};

export interface AiImageSubmitParams {
  idea: string;
  modelId: string;
  width: number;
  height: number;
  styleIds?: string[];
  quality?: 'LOW' | 'MEDIUM' | 'HIGH';
  negativePrompt?: string;
  /** V1.0.7-PROMPT-ENG-A4: same as LeonardoSubmitParams.antiAiLookNegatives
   *  — joined with `negativePrompt` in submitViaAiImage before the
   *  /api/ai/image request body. */
  antiAiLookNegatives?: string[];
  systemPrompt?: string;
  niches?: string[];
  genres?: string[];
  apiKey?: string;
  skipEnhance?: boolean;
  /**
   * IMG-INVEST-001 issue 1: forward the model spec's prompt_enhance
   * value all the way to Leonardo so pipeline-style specs can disable
   * Leonardo's own enhancement (we already MiniMax-enhanced server-side).
   */
  promptEnhance?: 'ON' | 'OFF';
}

export interface AiImageSubmitResult extends LeonardoSuccess {
  enhancedPrompt: string;
}

export interface MinimaxImageParams {
  prompt: string;
  width: number;
  height: number;
  aspectRatio?: string;
  quantity?: number;
  promptOptimizer?: boolean;
  seed?: number;
}

/**
 * HIGGSFIELD-INTEGRATION: submit a generation through the Higgsfield
 * MCP server (via the /api/higgsfield/image route). Same
 * `LeonardoSuccess` return shape as the other providers. The route
 * may return a `completed: false` + `requestId` when the job is
 * long-running; we poll the status route in that case (capped at
 * 5 minutes, matching the Leonardo polling shape).
 *
 * Errors propagate as plain `Error` with the route's `error` field
 * as the message. 401 means the user needs to OAuth their Higgsfield
 * account in Settings (we don't try to re-auth from the client).
 */
export interface HiggsfieldImageParams {
  prompt: string;
  modelId: string;            // e.g. 'higgsfield-nano-banana-pro'
  apiName: string;            // e.g. 'nano_banana_2'
  aspectRatio?: string;
  resolution?: '1k' | '2k' | '4k';
  quality?: 'low' | 'medium' | 'high';
  submodel?: 'pro' | 'flex' | 'max';
  referenceImageUrl?: string;
  seed?: number;
  /**
   * V1.4.0: optional CLI token from settings. When present, the
   * server route uses the CLI binary path (HiggsfieldCliAdapter)
   * instead of the OAuth MCP path. With `useImageGeneration` now
   * auto-picking Higgsfield, this is the common case for pipeline
   * runs.
   */
  higgsfieldCliToken?: string;
}

export interface HiggsfieldImageResult extends LeonardoSuccess {
  enhancedPrompt: string;
}

export interface ModerationRetryCallback {
  /** Fires once if the first submission hits a moderation block and we're about to rewrite-and-retry. */
  onRetry: (classifications: string[]) => void;
}

export interface SubmitResult {
  success: LeonardoSuccess;
  finalPrompt: string;
  /** true if the second attempt (rewrite) was used. false means first try succeeded. */
  retried: boolean;
}

export interface AiImageContext {
  systemPrompt?: string;
  niches?: string[];
  genres?: string[];
  apiKey?: string;
}

export interface LastGenerationError {
  message: string;
  classifications: string[];
  failedPrompt?: string;
  /** true when the retry also failed and the user needs to edit manually. */
  retried: boolean;
}

export interface UseImageGenerationDeps {
  settings: UserSettings;
  updateImageTags: (id: string, tags: string[]) => void;
}
