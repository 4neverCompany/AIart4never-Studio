/**
 * Provider-agnostic image-prompt builder.
 *
 * Both MMX and Leonardo benefit from the same enhancement step: read the
 * model spec at lib/model-specs/*.json for the user-selected style/preset,
 * append style + quality + mode keywords as natural-language hints to the
 * prompt, and emit provider-specific structured options (mmx flags or
 * Leonardo style UUIDs + dimensions) alongside.
 *
 * One function, one set of inputs, three output shapes (mmx, leonardo,
 * higgsfield) — guarantees that MMX, Leonardo, and Higgsfield all see
 * the same intent and produce comparable output for the same user setting.
 *
 * Pure module: no I/O, no spawn — string assembly + structured-flag
 * extraction.
 */

import { getModelSpec, type ModelSpec } from './model-specs';
import type { MmxImageOptions } from './mmx-client';
import { getCameraAngleById } from './camera-angles';

export interface PromptInjectionInputs {
  /** Model spec key (e.g. "nano-banana-2"). When set, params/styles are
   * pulled from the JSON spec. Unknown keys are ignored gracefully. */
  modelId?: string;
  /** Pick one style by name from spec.styles. Case-insensitive. The UUID
   * value goes into Leonardo's style_ids; the canonical NAME is appended
   * to the prompt as a keyword for both providers. */
  styleName?: string;
  /** Override the aspect ratio. If unset and the spec has aspectRatios,
   * the first ratio is used as the default — matching how the Leonardo
   * flow already treats the spec's first entry as canonical. */
  aspectRatio?: string;
  /** Tier of the dimension table to pick (e.g. "1K", "2K", "4K"). When
   * unset, the first sub-entry of the chosen aspect ratio is used. */
  dimensionTier?: string;
  /** Image count, propagated to mmxOptions.n and leonardoOptions.quantity. */
  count?: number;
  /** Optional free-text quality hint appended to the prompt last
   * (e.g. "ultra-detailed, cinematic lighting"). */
  qualityHint?: string;
  /** HIGGSFIELD-INTEGRATION: pre-resolved Higgsfield options to merge
   * into the output. Typically populated by the Studio / Pipeline
   * after the user has picked a model from the Higgsfield picker.
   * Only the fields relevant to the selected model are forwarded to
   * the route — the API layer re-validates against the model's
   * allow-list. */
  higgsfieldOptions?: Partial<HiggsfieldBuilderOptions>;
  /** V1.0.7-PROMPT-ENG-A1: SLCT (Surface / Lumina / Capture / Texture)
   * four-layer director protocol from the Banana Pro Director skill.
   * Each layer is optional; missing layers are dropped from the
   * prompt fragment. Applied as a structured tail to the base prompt
   * — see `buildSlctFragment` for the exact shape. */
  slct?: SlctInputs;
  /** V1.0.7-PROMPT-ENG-A4: when true, append the curated anti-AI-look
   * negative prompt list to `EnhancedPrompt.negativePrompts`. The
   * caller (route layer) forwards the list to providers that support
   * negative-prompt fields (Leonardo via `negative_prompt`, Higgsfield
   * via MCP `negative_prompt`); providers without negative-prompt
   * support silently drop the list. */
  antiAiLook?: boolean;
  /** V1.0.7-PROMPT-ENG-A2: MCSLA — Model · Camera · Subject · Look
   * · Action. Five-layer director protocol from
   * `docs/research/higgsfield-skills/cinema-world-builder-SKILL.md`.
   * Each layer is a free-text hint; missing layers are dropped.
   * Applied as a structured tail to the positive prompt, sibling
   * to the SLCT block. Empty/undefined layers are silently
   * dropped. The `camera.angle` field accepts either a free-form
   * description OR a slug from `lib/camera-angles.ts` (the A.3
   * picker writes a slug; this composer resolves it). */
  mcsla?: McslaInputs;
}

/** V1.0.7-PROMPT-ENG-A2: MCSLA — Model · Camera · Subject · Look · Action.
 *  Each layer is an optional free-text (or structured sub-object) hint.
 *  The composer drops empty/undefined layers. */
export interface McslaInputs {
  /** M - MODEL: model choice (often redundant with `modelId`, but
   *  kept here so the user can override per-idea). */
  model?: string;
  /** C - CAMERA: framing + movement + lens. The angle sub-field
   *  accepts a `lib/camera-angles.ts` slug (e.g. "low-angle-30"). */
  camera?: {
    angle?: string;
    movement?: string;
    lens?: string;
  };
  /** S - SUBJECT: who/what is in the frame. */
  subject?: string;
  /** L - LOOK: lighting + color + texture. */
  look?: {
    lighting?: string;
    color?: string;
    texture?: string;
  };
  /** A - ACTION: what's happening. */
  action?: string;
}

/** V1.0.7-PROMPT-ENG-A1: SLCT four-layer director protocol. Each
 * field is a free-text hint the user (or the Studio's preset picker)
 * filled in. Empty / missing fields are silently dropped so the caller
 * can populate only what they know. Reference:
 * `docs/research/higgsfield-skills/banana-pro-director-SKILL.md`. */
export interface SlctInputs {
  /** S - SURFACE & SOUL: subject as a tactile surface. */
  surface?: {
    skinCondition?: string;
    emotionalRegister?: string;
    microDetails?: string;
  };
  /** L - LUMINA: light physics. */
  lumina?: {
    direction?: string;
    quality?: string;
    interaction?: string;
    reflections?: string;
  };
  /** C - CAPTURE: camera and proximity. */
  capture?: {
    proximity?: string;
    optics?: string;
    angle?: string;
  };
  /** T - TEXTURE & TRUTH: material authenticity. */
  texture?: {
    authenticity?: string;
  };
}

export interface LeonardoBuilderOptions {
  /** Style UUIDs resolved from spec.styles[styleName]. Empty if no
   * style was requested or the style name is not in the spec. */
  styleIds?: string[];
  /** Maps to Leonardo's `quantity` parameter. */
  quantity?: number;
  /** Width/height paired from spec.aspectRatios[ratio][tier]. */
  width?: number;
  height?: number;
  /** Default quality from spec.parameters.quality. Forwarded as-is so the
   * route can use the spec's documented enum value (e.g. "HIGH").
   *
   * Note: this replaces the legacy `mode` parameter (FAST|QUALITY|ULTRA),
   * which was deprecated by Leonardo on 2026-05-04 for GPT image models.
   */
  quality?: string;
  /** Maps to Leonardo's `prompt_enhance` enum: 'ON' | 'OFF'. */
  promptEnhance?: 'ON' | 'OFF';
}

/**
 * HIGGSFIELD-INTEGRATION: structured options for the
 * /api/higgsfield/image + /api/higgsfield/video routes. The shape
 * matches the MCP `higgsfield_generate` tool's argument schema. Only
 * the fields supported by the selected model (per its JSON spec) are
 * populated — the API route validates against the model allow-list
 * before forwarding to the MCP server.
 */
export interface HiggsfieldBuilderOptions {
  /** The Higgsfield `job_set_type` slug, e.g. `nano_banana_2`. */
  model: string;
  /** Aspect ratio string, e.g. `9:16`. Validated server-side against
   * the model's allow-list. */
  aspectRatio?: string;
  /** Image resolution tier, e.g. `2k`. Only set for image models. */
  resolution?: '1k' | '2k' | '4k';
  /** Quality enum for models that support it (gpt_image_2, etc.). */
  quality?: 'low' | 'medium' | 'high';
  /** FLUX.2 sub-model: pro/flex/max. Only for higgsfield-flux-2. */
  submodel?: 'pro' | 'flex' | 'max';
  /** Video duration in seconds. Only for video models. */
  duration?: number;
  /** Video generation mode: std/fast/pro. */
  mode?: 'std' | 'fast' | 'pro';
  /** Cinematic genre. */
  genre?: 'auto' | 'action' | 'horror' | 'comedy' | 'noir' | 'drama' | 'epic';
  /** Video resolution. */
  videoResolution?: '480p' | '720p' | '1080p';
  /** Audio toggle (Kling v3 et al). */
  sound?: 'on' | 'off';
  /** Soul character id, for higgsfield-soul-v2 model. */
  soulId?: string;
  /** Reproducibility seed (only on models that accept it). */
  seed?: number;
  /** Publicly-accessible image URL for img2img / i2v. */
  referenceImageUrl?: string;
  /** Publicly-accessible image URL for i2v last frame. */
  endImageUrl?: string;
  /** Image count for batched generation. */
  quantity?: number;
}

export interface EnhancedPrompt {
  /** Prompt with spec/style/quality hints appended. Use as-is for either
   * provider — keywords are natural language and not provider-specific. */
  prompt: string;
  /** Diagnostic: hints actually appended, in the order they appear. */
  appliedHints: string[];
  /** Structured options for the MMX CLI (`mmx image generate` flags). */
  mmx: MmxImageOptions;
  /** Structured options for the Leonardo /api/leonardo route body. */
  leonardo: LeonardoBuilderOptions;
  /** Structured options for the Higgsfield /api/higgsfield/{image,video}
   * route body. Populated only when the caller passes a
   * `higgsfieldOptions` input; otherwise empty. */
  higgsfield: HiggsfieldBuilderOptions;
  /** V1.0.7-PROMPT-ENG-A4: negative prompts to forward to providers
   * that support them. Empty unless `inputs.antiAiLook` is set.
   * Currently only the curated anti-AI-look list — future work could
   * let the caller append custom negatives via a separate input. */
  negativePrompts: string[];
}

// ---------------------------------------------------------------------------
// V1.0.7-PROMPT-ENG-A1: SLCT four-layer director protocol
// ---------------------------------------------------------------------------

/**
 * Compose the four-layer SLCT block from optional inputs. Each layer
 * is a `key: value` segment joined by `|`; missing fields are dropped.
 * Returns the empty string when no layer has any content, so the
 * caller can safely concat without a separator guard.
 *
 * The output shape is stable for callers / diagnostics:
 *   "SLCT[S: <skin>; <emotion>; <micro>] | [L: <dir>; <quality>; <interaction>; <reflections>] | [C: <proximity>; <optics>; <angle>] | [T: <authenticity>]"
 *
 * Empty fields within a layer are also dropped (so the layer segment
 * won't have dangling `;` characters).
 */
function buildSlctFragment(slct: SlctInputs | undefined): string {
  if (!slct) return '';
  const parts: string[] = [];
  const surfaceBits = [slct.surface?.skinCondition, slct.surface?.emotionalRegister, slct.surface?.microDetails]
    .map((s) => s?.trim()).filter(Boolean);
  if (surfaceBits.length > 0) parts.push(`S: ${surfaceBits.join('; ')}`);
  const luminaBits = [slct.lumina?.direction, slct.lumina?.quality, slct.lumina?.interaction, slct.lumina?.reflections]
    .map((s) => s?.trim()).filter(Boolean);
  if (luminaBits.length > 0) parts.push(`L: ${luminaBits.join('; ')}`);
  const captureBits = [slct.capture?.proximity, slct.capture?.optics, slct.capture?.angle]
    .map((s) => s?.trim()).filter(Boolean);
  if (captureBits.length > 0) parts.push(`C: ${captureBits.join('; ')}`);
  const textureBits = [slct.texture?.authenticity].map((s) => s?.trim()).filter(Boolean);
  if (textureBits.length > 0) parts.push(`T: ${textureBits.join('; ')}`);
  if (parts.length === 0) return '';
  return `SLCT[${parts.join(' | ')}]`;
}

// ---------------------------------------------------------------------------
// V1.0.7-PROMPT-ENG-A2: MCSLA five-layer director protocol
// ---------------------------------------------------------------------------

/**
 * Compose the five-layer MCSLA block from optional inputs. Each layer
 * is a `key: value` segment joined by `|`; missing fields are dropped.
 * Returns the empty string when no layer has any content, so the
 * caller can safely concat without a separator guard.
 *
 * The output shape is stable for callers / diagnostics:
 *   "MCSLA[M: <model>] | [C: <angle-fragment>; <movement>; <lens>] | [S: <subject>] | [L: <lighting>; <color>; <texture>] | [A: <action>]"
 *
 * Empty fields within a layer are also dropped (so the layer segment
 * won't have dangling `;` characters). For the `C` (Camera) layer
 * specifically, the `angle` field is resolved through the
 * `lib/camera-angles.ts` catalog when it's a known slug — this lets
 * the A.3 picker write a stable id (e.g. "low-angle-30") and the
 * composer expand it to the full "Low angle, 30° below eye level"
 * fragment.
 */
function buildMcslaFragment(mcsla: McslaInputs | undefined): string {
  if (!mcsla) return '';
  const parts: string[] = [];

  // M — MODEL
  const m = mcsla.model?.trim();
  if (m) parts.push(`M: ${m}`);

  // C — CAMERA
  if (mcsla.camera) {
    const camBits: string[] = [];
    // Resolve the angle slug if present, otherwise use the raw string.
    const rawAngle = mcsla.camera.angle?.trim();
    if (rawAngle) {
      const catalog = getCameraAngleById(rawAngle);
      camBits.push(catalog ? catalog.promptFragment : rawAngle);
    }
    const movement = mcsla.camera.movement?.trim();
    if (movement) camBits.push(movement);
    const lens = mcsla.camera.lens?.trim();
    if (lens) camBits.push(lens);
    if (camBits.length > 0) parts.push(`C: ${camBits.join('; ')}`);
  }

  // S — SUBJECT
  const s = mcsla.subject?.trim();
  if (s) parts.push(`S: ${s}`);

  // L — LOOK
  if (mcsla.look) {
    const lookBits = [mcsla.look.lighting, mcsla.look.color, mcsla.look.texture]
      .map((x) => x?.trim()).filter(Boolean);
    if (lookBits.length > 0) parts.push(`L: ${lookBits.join('; ')}`);
  }

  // A — ACTION
  const a = mcsla.action?.trim();
  if (a) parts.push(`A: ${a}`);

  if (parts.length === 0) return '';
  return `MCSLA[${parts.join(' | ')}]`;
}

// ---------------------------------------------------------------------------
// V1.0.7-PROMPT-ENG-A4: anti-AI-look negative prompts (curated)
// ---------------------------------------------------------------------------

/**
 * Curated list of negative prompts to suppress the "AI-look" — soft
 * diffuse lighting, smooth airbrushed skin, flat even light, etc.
 * Source: `banana-pro-director-SKILL.md` §"Directivas de Limpieza de IA".
 *
 * The list is intentionally a const (not generated from style hints) so
 * it's reviewable in code review and easy to trim when a particular
 * negative starts causing the model to over-correct.
 */
const ANTI_AI_LOOK_NEGATIVES: readonly string[] = [
  'soft diffused lighting',
  'no shadows',
  'flat even light',
  'blue or cool tones',
  'smooth airbrushed skin',
  'no pores',
  'dark eyebrow',
  'both eyes visible',
  'full face',
  'clean shaven',
  'studio lighting',
  'painted',
  'illustration',
  'CGI',
  'plastic skin',
  'wet skin',
  'sweat droplets',
  'bright white background',
];

// ---------------------------------------------------------------------------
// Spec readers (small, defensive)
// ---------------------------------------------------------------------------

function paramValue(spec: ModelSpec, key: string): string | undefined {
  const params = spec.parameters as Record<string, unknown> | undefined;
  const entry = params?.[key];
  if (!entry || typeof entry !== 'object') return undefined;
  const e = entry as { value?: unknown; default?: unknown };
  if (typeof e.value === 'string' || typeof e.value === 'number') return String(e.value);
  if (typeof e.default === 'string' || typeof e.default === 'number') return String(e.default);
  return undefined;
}

function firstAspectRatio(spec: ModelSpec): string | undefined {
  const ratios = spec.aspectRatios;
  if (!ratios || typeof ratios !== 'object') return undefined;
  const keys = Object.keys(ratios as Record<string, unknown>);
  return keys[0];
}

function findStyleEntry(spec: ModelSpec, requested: string):
  | { name: string; id?: string }
  | undefined {
  const styles = spec.styles;
  if (!styles || typeof styles !== 'object') return undefined;
  const lookup = requested.trim().toLowerCase();
  for (const [name, id] of Object.entries(styles)) {
    if (name.toLowerCase() === lookup) {
      return { name, id: typeof id === 'string' ? id : undefined };
    }
  }
  return undefined;
}

/**
 * Resolve [width, height] from spec.aspectRatios[ratio][tier]. The
 * dimension tables in the model specs look like:
 *   "1:1": { "1K": [1024,1024], "2K": [2048,2048], "4K": [4096,4096] }
 * Return undefined when the spec has no dimension table or the requested
 * ratio/tier doesn't exist; callers fall through silently.
 */
function dimsFromSpec(
  spec: ModelSpec,
  ratio: string | undefined,
  tier: string | undefined,
): { width: number; height: number } | undefined {
  if (!ratio) return undefined;
  const ratios = spec.aspectRatios as Record<string, unknown> | undefined;
  const ratioEntry = ratios?.[ratio];
  if (!ratioEntry || typeof ratioEntry !== 'object') return undefined;
  const entries = ratioEntry as Record<string, unknown>;
  const tierKey = tier && tier in entries ? tier : Object.keys(entries)[0];
  if (!tierKey) return undefined;
  const dims = entries[tierKey];
  if (!Array.isArray(dims) || dims.length < 2) return undefined;
  const [w, h] = dims;
  if (typeof w !== 'number' || typeof h !== 'number') return undefined;
  return { width: w, height: h };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compose an enhanced prompt + per-provider structured options from a base
 * prompt and a model-spec selector. Pure function — safe to call from
 * tests, route handlers, or cron without side effects.
 *
 * Both `result.mmx` and `result.leonardo` are always populated. Callers
 * pluck the slice they need based on the user-selected provider; the
 * shared `result.prompt` ensures both providers see the same intent.
 *
 * Production callers: `hooks/useImageGeneration.ts` (Leonardo path)
 * and `app/api/mmx/image/route.ts` (MMX path) both feed user inputs
 * through this composer so the two providers see the same intent.
 * Wiring history: STORY-MMX-PROMPT-WIRE.md.
 */
export function buildEnhancedPrompt(
  basePrompt: string,
  inputs: PromptInjectionInputs = {},
): EnhancedPrompt {
  const spec = inputs.modelId ? getModelSpec(inputs.modelId) : undefined;
  const hintParts: string[] = [];
  const mmx: MmxImageOptions = {};
  const leonardo: LeonardoBuilderOptions = {};
  // V1.0.7-PROMPT-ENG-A4: anti-AI-look negatives are populated only when
  // the caller asks for them. Default empty list (the `[]` in the
  // type signature is the contract — callers can rely on `negativePrompts`
  // always being an array, never undefined).
  const negativePrompts: string[] = [];
  // HIGGSFIELD-INTEGRATION: start from the spec's `apiName` so the
  // caller doesn't need to know the underlying job_set_type. If no
  // spec is found (ad-hoc Higgsfield call), the caller is expected
  // to pass `higgsfieldOptions.model` explicitly.
  const higgsfield: HiggsfieldBuilderOptions = {
    model:
      (spec?.apiName as string | undefined) ||
      inputs.higgsfieldOptions?.model ||
      '',
  };

  // Style: spec-validated → keyword in prompt + UUID for Leonardo.
  // Bare strings (no spec) still go in as keywords for both providers.
  if (inputs.styleName) {
    if (spec) {
      const found = findStyleEntry(spec, inputs.styleName);
      if (found) {
        hintParts.push(`style: ${found.name}`);
        if (found.id) leonardo.styleIds = [found.id];
      }
    } else {
      hintParts.push(`style: ${inputs.styleName.trim()}`);
    }
  }

  // Aspect ratio — explicit override > first spec entry > nothing.
  const aspect = inputs.aspectRatio ?? (spec ? firstAspectRatio(spec) : undefined);
  if (aspect) {
    mmx.aspectRatio = aspect;
    hintParts.push(`aspect ratio: ${aspect}`);
    if (spec) {
      const dims = dimsFromSpec(spec, aspect, inputs.dimensionTier);
      if (dims) {
        leonardo.width = dims.width;
        leonardo.height = dims.height;
      }
    }
  }

  // Quality pulled from the spec when present. Forwarded as a prompt
  // keyword for both providers; Leonardo also gets it as a structured
  // param it can pass to its REST API. (The legacy `mode` parameter was
  // deprecated by Leonardo on 2026-05-04 — image specs no longer carry it.)
  if (spec) {
    const quality = paramValue(spec, 'quality');
    if (quality) {
      hintParts.push(`quality: ${quality}`);
      leonardo.quality = quality;
    }
    const promptEnhance = paramValue(spec, 'prompt_enhance');
    if (promptEnhance) {
      const upper = promptEnhance.toUpperCase();
      if (upper === 'ON') {
        mmx.promptOptimizer = true;
        leonardo.promptEnhance = 'ON';
      } else if (upper === 'OFF') {
        leonardo.promptEnhance = 'OFF';
      }
    }
  }

  // V1.0.7-PROMPT-ENG-A1: SLCT four-layer director protocol. Appended
  // as a single self-delimiting block AFTER spec-style/aspect/quality
  // hints but BEFORE the user qualityHint, so the SLCT block sits at
  // the structural boundary between model-derived and user-derived
  // text. The block is dropped entirely if all four layers are empty.
  const slctFragment = buildSlctFragment(inputs.slct);
  if (slctFragment) {
    hintParts.push(slctFragment);
  }

  // V1.0.7-PROMPT-ENG-A2: MCSLA five-layer director protocol. Sits
  // AFTER SLCT (SLCT is image-focused surface/lumina/capture/texture;
  // MCSLA is the broader video-aware Model/Camera/Subject/Look/Action
  // protocol). Empty layers are dropped — the block only appears when
  // the user has set at least one of {model, camera, subject, look, action}.
  const mcslaFragment = buildMcslaFragment(inputs.mcsla);
  if (mcslaFragment) {
    hintParts.push(mcslaFragment);
  }

  // Free-text quality hint from caller (last, after spec + SLCT).
  if (inputs.qualityHint && inputs.qualityHint.trim()) {
    hintParts.push(inputs.qualityHint.trim());
  }

  // V1.0.7-PROMPT-ENG-A4: anti-AI-look negative prompts. Populated as a
  // separate field on the output (NOT appended to the positive prompt)
  // because some providers have dedicated negative-prompt channels
  // (Leonardo `negative_prompt`, Higgsfield MCP `negative_prompt`).
  if (inputs.antiAiLook) {
    negativePrompts.push(...ANTI_AI_LOOK_NEGATIVES);
  }

  // Image count — all three providers.
  if (inputs.count && inputs.count > 0) {
    mmx.n = inputs.count;
    leonardo.quantity = inputs.count;
    higgsfield.quantity = inputs.count;
  }

  // HIGGSFIELD-INTEGRATION: forward caller-supplied Higgsfield
  // options verbatim. The API layer validates each field against
  // the model allow-list before sending to the MCP server, so this
  // step is pure pass-through.
  if (inputs.higgsfieldOptions) {
    const o = inputs.higgsfieldOptions;
    if (o.aspectRatio) higgsfield.aspectRatio = o.aspectRatio;
    if (o.resolution) higgsfield.resolution = o.resolution;
    if (o.quality) higgsfield.quality = o.quality;
    if (o.submodel) higgsfield.submodel = o.submodel;
    if (typeof o.duration === 'number') higgsfield.duration = o.duration;
    if (o.mode) higgsfield.mode = o.mode;
    if (o.genre) higgsfield.genre = o.genre;
    if (o.videoResolution) higgsfield.videoResolution = o.videoResolution;
    if (o.sound) higgsfield.sound = o.sound;
    if (o.soulId) higgsfield.soulId = o.soulId;
    if (typeof o.seed === 'number') higgsfield.seed = o.seed;
    if (o.referenceImageUrl) higgsfield.referenceImageUrl = o.referenceImageUrl;
    if (o.endImageUrl) higgsfield.endImageUrl = o.endImageUrl;
  }
  // Fill in the aspect ratio from the prompt inputs when the caller
  // didn't pass a higgsfieldOptions aspectRatio — keeps the three
  // providers in sync (mmx + leonardo are also filled above).
  if (!higgsfield.aspectRatio && aspect) {
    higgsfield.aspectRatio = aspect;
  }

  const prompt = hintParts.length > 0
    ? `${basePrompt.trim()}. ${hintParts.join(', ')}`
    : basePrompt.trim();

  return { prompt, appliedHints: hintParts, mmx, leonardo, higgsfield, negativePrompts };
}
