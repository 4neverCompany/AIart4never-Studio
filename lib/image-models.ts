/**
 * Unified Image Model Registry
 * =============================
 *
 * V1.4.0: The previous v1.3.x `LEONARDO_MODELS` array only contained
 * Leonardo models. To make Higgsfield (and any future provider) a
 * first-class choice, we now expose one flat list that the
 * `useImageGeneration` hook iterates. Each entry has a `provider`
 * discriminator; the hook dispatches to the right `/api/*` endpoint
 * and adapter.
 *
 * V1.4.0-REWORK: Higgsfield is an ADD-ON to the existing Leonardo
 * workflow, not a replacement. The user's existing `defaultLeonardoModel`
 * stays the primary default; Higgsfield is opt-in via the
 * `higgsfieldEnabled` setting. When the user enables it, the hook
 * round-robins through `higgsfieldImageModels` so multiple Higgsfield
 * models are used across a pipeline run.
 *
 * Skill injection (V1.4.0): for each Higgsfield model, the right
 * skill from `docs/research/higgsfield-skills/` is appended to the
 * prompt enhancement call. This is what gives Higgsfield models
 * their characteristic quality — the model-specific prompt
 * structure (SLCT for Nano Banana, MCSLA for video, etc.) is
 * applied automatically.
 *
 * Adding a new provider is a one-line append: just add a new
 * `provider: 'foo'` entry and implement the dispatch branch in
 * `useImageGeneration`. No new model registry required.
 */

import { LEONARDO_MODELS, type LeonardoModelConfig } from '@/types/mashup'
import {
  HIGGSFIELD_DEFAULT_IMAGE_MODEL,
  HIGGSFIELD_IMAGE_MODELS,
  type HiggsfieldModelMeta,
} from '@/lib/higgsfield/models'

export type ImageProvider = 'leonardo' | 'minimax' | 'higgsfield'

/**
 * V1.4.0: each Higgsfield model maps to a skill from
 * `docs/research/higgsfield-skills/`. The skill content is appended
 * to the prompt enhancement call so the resulting prompts follow
 * the model's optimal structure.
 */
export interface HiggsfieldSkillBinding {
  /** Skill name, used in settings.activeSkills and in the system prompt. */
  skillName: string
  /** Short blurb shown next to the model in the picker. */
  blurb: string
  /** Whether the skill enables the SLCT framework. */
  slct?: boolean
  /** Whether the skill enables the MCSLA structure. */
  mcsla?: boolean
}

export interface UnifiedImageModel {
  /** Stable id used in settings + URL params + server routes. */
  id: string
  /** Human-readable name shown in pickers. */
  name: string
  /** Backend model identifier (passed to the provider's API). */
  apiModelId: string
  provider: ImageProvider
  /** Cost hint (credits or USD) for the model picker. */
  creditHint: number
  /** Aspect ratios the model supports. */
  aspectRatios: readonly string[]
  /** Resolutions the model supports (image only). */
  resolutions?: readonly string[]
  /** Optional blurb shown in tooltips. */
  blurb?: string
  /** Optional badge in the picker. */
  badge?: 'fast' | 'cheap' | 'flagship' | 'character' | 'pro'
  /** For Higgsfield: skill binding for the prompt enhancement. */
  skillBinding?: HiggsfieldSkillBinding
  /** For Leonardo: the legacy fields preserved for backwards compat. */
  leonardoConfig?: LeonardoModelConfig
  /** For Higgsfield: the catalog metadata preserved for backwards compat. */
  higgsfieldConfig?: HiggsfieldModelMeta
}

/**
 * Build the unified registry. Order matters: the first entry whose
 * `id` matches a user's saved default is what we use, so put
 * preferred models first.
 */
export const IMAGE_MODELS: readonly UnifiedImageModel[] = [
  ...HIGGSFIELD_IMAGE_MODELS.map((m): UnifiedImageModel => ({
    id: `higgsfield:${m.slug}`,
    name: `${m.displayName} (Higgsfield)`,
    apiModelId: m.slug,
    provider: 'higgsfield',
    creditHint: m.creditHint,
    aspectRatios: m.aspectRatios,
    resolutions: m.resolutions,
    blurb: m.blurb,
    badge: m.badge,
    higgsfieldConfig: m,
    skillBinding: deriveSkillBinding(m),
  })),
  ...LEONARDO_MODELS.map((m): UnifiedImageModel => ({
    id: m.id,
    name: `${m.name} (Leonardo)`,
    apiModelId: m.apiModelId,
    provider: (m.provider as ImageProvider | undefined) ?? 'leonardo',
    creditHint: 4, // Leonardo doesn't expose credits, use a flat hint
    aspectRatios: m.aspectRatios.map((a) => a.label),
    blurb: undefined,
    leonardoConfig: m,
  })),
]

/**
 * V1.4.0: derive the right skill for each Higgsfield model.
 *
 * Banana Pro/2 → banana-pro-director (SLCT framework, anti-AI-look)
 * Flux 2 → cinema-world-builder (named camera presets)
 * GPT Image 2 → cinema-world-builder (strong prompt adherence)
 * Seedream 4.5 → product-photoshoot via CLI
 * Soul V2 → character consistency (uses soul_id when set)
 * Image Auto → cinema-world-builder (let Higgsfield pick)
 */
function deriveSkillBinding(m: HiggsfieldModelMeta): HiggsfieldSkillBinding {
  if (m.family === 'nano-banana') {
    return {
      skillName: 'banana-pro-director',
      blurb: 'SLCT framework: skin · light · capture · texture',
      slct: true,
    }
  }
  if (m.family === 'seedream') {
    return {
      skillName: 'product-photoshoot',
      blurb: 'Brand-quality product photography via backend prompt enhancement',
    }
  }
  if (m.family === 'soul') {
    return {
      skillName: 'soul-character-consistency',
      blurb: 'Use a trained Soul ID for character consistency across generations',
    }
  }
  // flux, gpt-image, auto → general cinema-world-builder
  return {
    skillName: 'cinema-world-builder',
    blurb: 'MCSLA structure · named camera presets · negative constraints',
    mcsla: true,
  }
}

/** Look up a model by its stable id (`higgsfield:nano_banana_2` or `nano-banana-2`). */
export function getImageModel(id: string): UnifiedImageModel | undefined {
  return IMAGE_MODELS.find((m) => m.id === id)
}

/** The previous API the settings modal uses. Returns just the model list. */
export function listImageModels(): readonly UnifiedImageModel[] {
  return IMAGE_MODELS
}

/**
 * Pick the best image model given the user's settings.
 *
 * V1.4.0-REWORK: Leonardo is the primary default. Higgsfield is an
 * add-on that the user opts into. The auto-pick only chooses Higgsfield
 * if the user has explicitly enabled it via `higgsfieldEnabled` AND
 * picked at least one model in `higgsfieldImageModels`.
 *
 * Rules (in order):
 *   1. The user's `defaultImageModel` if set and available
 *   2. Their `defaultHiggsfieldImageModel` if Higgsfield is enabled
 *      AND that model is in their `higgsfieldImageModels` list
 *   3. Their `defaultLeonardoModel` (legacy) — this is the safe default
 *   4. First available model
 *
 * Note: when the pipeline runs with `higgsfieldEnabled`, the
 * `useImageGeneration` hook uses `pickHiggsfieldModelForCycle()`
 * to round-robin through the user's `higgsfieldImageModels`. The
 * `pickDefaultImageModel` is for the *fallback* path and for
 * `ManualGenerationPanel` when no override is given.
 */
export function pickDefaultImageModel(opts: {
  defaultImageModel?: string | null
  defaultHiggsfieldImageModel?: string | null
  defaultLeonardoModel?: string | null
  higgsfieldEnabled?: boolean
  higgsfieldImageModels?: string[]
}): UnifiedImageModel {
  // 1. Explicit override
  if (opts.defaultImageModel) {
    const hit = getImageModel(opts.defaultImageModel)
    if (hit) return hit
  }
  // 2. Higgsfield default — only if the user enabled Higgsfield
  //    AND listed this model in their enabled set.
  if (opts.higgsfieldEnabled) {
    if (opts.defaultHiggsfieldImageModel) {
      const hit = getImageModel(`higgsfield:${opts.defaultHiggsfieldImageModel}`)
      if (hit) return hit
    }
    // Otherwise the first model in their list
    if (opts.higgsfieldImageModels && opts.higgsfieldImageModels.length > 0) {
      const first = opts.higgsfieldImageModels[0]
      const hit = getImageModel(`higgsfield:${first}`)
      if (hit) return hit
    }
  }
  // 3. Legacy Leonardo default — this is the safe fallback that
  //    keeps the existing workflow intact.
  if (opts.defaultLeonardoModel) {
    const hit = getImageModel(opts.defaultLeonardoModel)
    if (hit) return hit
  }
  // 4. First available
  return IMAGE_MODELS[0]
}

/**
 * V1.4.0: round-robin through the user's enabled Higgsfield models.
 * Used by `useImageGeneration` so multiple Higgsfield models get
 * exercised across a single pipeline run.
 *
 * Returns the first model when the list is empty (the user's
 * setting is misconfigured — use the default as a graceful
 * fallback).
 */
export function pickHiggsfieldModelForCycle(
  cycleIndex: number,
  enabled: string[] | undefined,
): UnifiedImageModel {
  if (!enabled || enabled.length === 0) {
    const fallback = getImageModel(`higgsfield:${HIGGSFIELD_DEFAULT_IMAGE_MODEL}`)
    if (fallback) return fallback
  }
  const slug = enabled![cycleIndex % enabled!.length]
  const hit = getImageModel(`higgsfield:${slug}`)
  if (hit) return hit
  // slug not in the catalog — fall back to the default
  const fallback = getImageModel(`higgsfield:${HIGGSFIELD_DEFAULT_IMAGE_MODEL}`)
  if (fallback) return fallback
  throw new Error('No Higgsfield models in catalog')
}

