/**
 * V030-007: smart parameter pre-fill.
 * V082-PARAM-SCRIPT: AI variant retired. Both entry points now run the
 * deterministic rule engine. The pi.dev path was producing wrong values
 * for capability-aware models (e.g. proposing a style for gpt-image-1.5,
 * which has no style parameter) and was the source of bugs Maurice
 * surfaced in V082. The async entry point is preserved as a thin
 * Promise-wrapped delegate so the production injection point in
 * MainContent + the pushIdeaToStudio dependency shape keep compiling
 * without touching every call site.
 *
 * Two entry points:
 *
 *   `suggestParameters(input)` — pure, deterministic rule engine. Reads
 *   prompt for subject/style/theme cues, looks up each model's supported
 *   parameters, and emits per-model panels that respect each model's
 *   capabilities (e.g. style is only set when `spec.style_ids` is true).
 *   Defaults to including ALL eligible models so the suggestion never
 *   silently drops a model the user wanted active.
 *
 *   `suggestParametersAI(input)` — async wrapper around suggestParameters.
 *   Same shape, no network. Kept for back-compat with callers that await
 *   it.
 */

import type {
  GeneratedImage,
  LeonardoModelConfig,
  LeonardoModelSpec,
  LeonardoImageModelSpec,
} from '@/types/mashup';
import { LEONARDO_MODEL_PARAMS } from '@/types/mashup';
import type { ModelSpecProvider } from '@/lib/model-specs';
import { extractJsonObjectFromLLM } from '@/lib/aiClient';

/**
 * Historically `'ai'` and `'ai+rules'` were possible values when the
 * pi.dev variant was active. After V082 the rule engine is the only
 * source, but the union is preserved so the badge UI in
 * `ParamSuggestionCard` keeps narrowing without churn.
 */
export type SuggestionSource = 'ai' | 'rules' | 'ai+rules';

// ── Per-model suggestion shape ───────────────────────────────────────────────

export interface PerModelImageSuggestion {
  type: 'image';
  modelId: string;
  apiName: string;
  aspectRatio: string;
  width: number;
  height: number;
  imageSize: '1K' | '2K';
  /** Only set when the model exposes a quality knob (today gpt-image-1.5). */
  quality?: 'LOW' | 'MEDIUM' | 'HIGH';
  promptEnhance: 'ON' | 'OFF';
  /** Style name (resolved to UUID downstream). Only meaningful for nano-banana-*. */
  style?: string;
  negativePrompt?: string;
  /** 1-2 sentence rationale for THIS model's settings. */
  reason: string;
  source: SuggestionSource;
}

export interface PerModelVideoSuggestion {
  type: 'video';
  modelId: string;
  apiName: string;
  aspectRatio: string;
  width: number;
  height: number;
  duration: number;
  mode: 'RESOLUTION_720' | 'RESOLUTION_1080';
  motionHasAudio?: boolean;
  reason: string;
  source: SuggestionSource;
}

export type PerModelSuggestion = PerModelImageSuggestion | PerModelVideoSuggestion;

// ── Top-level (shared / shortlist) suggestion shape ──────────────────────────

export interface ParamSuggestionReasons {
  models: string;
  aspectRatio: string;
  style?: string;
  imageSize: string;
  negativePrompt?: string;
  quality?: string;
  promptEnhance?: string;
  /** Holistic AI-authored paragraph explaining the suggestion as a whole. */
  overall?: string;
}

export interface ParamSuggestion {
  modelIds: string[];
  /** Per-model parameter map keyed by in-app model id. */
  perModel: Record<string, PerModelSuggestion>;
  /**
   * "Best shared" view derived from the first (highest-ranked) model.
   * Kept for the existing apply path which writes to a single shared
   * `comparisonOptions`. Per-model overrides live in `perModel`.
   */
  aspectRatio: string;
  style?: string;
  imageSize: '1K' | '2K';
  negativePrompt?: string;
  quality?: 'LOW' | 'MEDIUM' | 'HIGH';
  promptEnhance?: 'ON' | 'OFF';
  reasons: ParamSuggestionReasons;
  priorMatchCount: number;
  /** Where the suggestion came from. `ai+rules` = AI partly responded. */
  source: SuggestionSource;
}

export interface SuggestParametersInput {
  prompt: string;
  availableModels: LeonardoModelConfig[];
  modelGuides: Record<string, string>;
  availableStyles: { name: string; uuid: string }[];
  savedImages: GeneratedImage[];
  /**
   * How many models to return. Default 99 — practically "all eligible
   * models" so the suggestion never silently drops a model the user had
   * active. Callers that want a tighter shortlist (e.g. a "compact mode"
   * surface) can still pass a smaller cap.
   */
  topN?: number;
  /** Models to exclude from ranking. Defaults to nano-banana (pipeline skips it). */
  excludedModelIds?: readonly string[];
  /**
   * Models the user has already selected. These are force-included in
   * the output regardless of ranking score, so a manually-selected
   * low-rank model (e.g. GPT Image-1.5) still gets a per-model panel.
   * Forced inclusions count against topN up to its budget, and any
   * overflow beyond topN is still included.
   */
  includedModelIds?: readonly string[];
  /** Per-model API parameter spec. Defaults to LEONARDO_MODEL_PARAMS. */
  modelParams?: Record<string, LeonardoModelSpec>;
  /**
   * P2 of PROV-AGNOSTIC-PARAMS — when set, narrow the candidate pool to
   * models whose `LeonardoModelConfig.provider` matches. Undefined leaves
   * the engine in its historical Leonardo-only behaviour (every model
   * shipped before MXIMG-001 has no provider field; treated as
   * `'leonardo'` by the filter). When set to `'minimax'`, only
   * `minimax-image-01` survives the filter today; future MiniMax image
   * models drop in without engine changes.
   */
  provider?: ModelSpecProvider;
  /**
   * Pipeline trending-context blurb (Reddit + SearXNG summary from
   * `fetchTrendingContext`). When present, included in the AI prompt so
   * style / aspect / negative picks can react to current trends rather
   * than only the idea concept text. Optional — the rule-engine baseline
   * never consumes this; only the AI refinement step does.
   */
  trendingContext?: string;
}

// ── Heuristic rules ──────────────────────────────────────────────────────────

interface AspectRule {
  keywords: string[];
  ratio: string;
  reason: string;
}

const ASPECT_RULES: AspectRule[] = [
  { keywords: ['vertical', 'reel', 'tiktok', 'story', 'mobile wallpaper'], ratio: '9:16', reason: 'vertical format for social / mobile' },
  { keywords: ['portrait', 'character', 'figure', 'face', 'headshot', 'head shot'], ratio: '2:3', reason: 'portrait orientation fits subject-focused shots' },
  { keywords: ['landscape', 'panorama', 'vista', 'horizon', 'cityscape', 'skyline', 'wide shot'], ratio: '16:9', reason: 'wide format suits landscape composition' },
  { keywords: ['square', 'icon', 'logo', 'album cover', 'avatar'], ratio: '1:1', reason: 'square format for icon / cover use' },
  { keywords: ['cinematic', 'film still', 'movie still'], ratio: '3:2', reason: 'cinematic 3:2 framing' },
];

// V085-MODEL-STYLE-DIVERSITY: each rule now lists styles in ranked order.
// When multiple models share a style pool (e.g. nano-banana-2 and
// nano-banana-pro both draw from LEONARDO_SHARED_STYLES), the first
// model gets the top pick and siblings walk the list to find an
// unused alternative. This prevents two siblings from being
// suggested the identical style, which made A/B comparisons
// pointless.
interface StyleRule {
  keywords: string[];
  styleNames: readonly string[];
  reason: string;
}

const STYLE_RULES: StyleRule[] = [
  { keywords: ['monochrome', 'black and white', 'b&w', 'noir'],
    styleNames: ['Pro B&W Photography', 'Pro Film Photography'],
    reason: 'monochrome cue' },
  { keywords: ['fashion', 'editorial', 'runway', 'vogue'],
    styleNames: ['Fashion', 'Portrait Fashion', 'Pro Color Photography'],
    reason: 'fashion / editorial cue' },
  { keywords: ['anime', 'cartoon', 'comic', 'manga', 'illustration'],
    styleNames: ['Illustration', 'Graphic Design 2D', 'Creative'],
    reason: 'illustrated / drawn style cue' },
  // RAY-TRACED-FIX (IMG-INVEST-001 issue 5, 2026-05-23): dedicated
  // explicit-raytrace rule above the generic 3D rule. When the user
  // spells out raytracing intent (or asks for photoreal CGI),
  // Ray Traced takes the top slot in this rule's candidate list so the
  // diversity walker can actually pick it. Prior to this rule, the
  // only path to Ray Traced was rule #5 below where it sat second and
  // was unreachable for any prompt that also mentioned "illustration"
  // or "photograph" first.
  { keywords: ['raytraced', 'ray-traced', 'ray traced', 'path traced', 'path-traced', 'photoreal 3d', 'realistic render', 'physically based rendering', 'pbr'],
    styleNames: ['Ray Traced', '3D Render', 'Graphic Design 3D'],
    reason: 'explicit ray-traced realism cue' },
  { keywords: ['3d render', '3d', 'cgi', 'octane', 'blender'],
    styleNames: ['3D Render', 'Ray Traced', 'Graphic Design 3D'],
    reason: '3D / rendered look cue' },
  { keywords: ['watercolor', 'watercolour', 'painted', 'gouache'],
    styleNames: ['Watercolor', 'Acrylic', 'Creative'],
    reason: 'painted-medium cue' },
  { keywords: ['game concept', 'concept art'],
    styleNames: ['Game Concept', 'Illustration', 'Dynamic'],
    reason: 'concept-art cue' },
  { keywords: ['portrait', 'headshot', 'head shot', 'close-up'],
    styleNames: ['Portrait Cinematic', 'Portrait', 'Portrait Fashion'],
    reason: 'portrait composition detected' },
  { keywords: ['cinematic', 'dramatic', 'moody'],
    styleNames: ['Portrait Cinematic', 'Pro Film Photography', 'Dynamic'],
    reason: 'cinematic / moody cue' },
  { keywords: ['photorealistic', 'realistic', 'photograph', 'photo '],
    styleNames: ['Pro Color Photography', 'Stock Photo', 'Pro Film Photography'],
    reason: 'photographic-realism cue' },
];

const DETAIL_KEYWORDS = [
  'ultra detailed', 'ultra-detailed', 'highly detailed', 'hyper detailed',
  'hyper-detailed', 'intricate', '8k', '4k', 'ultra realistic',
];

// Video-specific cues — duration + audio knobs.
const SHORT_VIDEO_KEYWORDS = ['short clip', 'gif', 'looping', 'loop', 'quick'];
const LONG_VIDEO_KEYWORDS = ['long take', 'extended', 'one shot', 'continuous shot'];
const SILENT_VIDEO_KEYWORDS = ['silent', 'no audio', 'mute', 'quiet'];

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );
}

function firstHit(prompt: string, keywords: string[]): string | undefined {
  const lower = prompt.toLowerCase();
  for (const k of keywords) {
    if (lower.includes(k)) return k;
  }
  return undefined;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  return intersect / (a.size + b.size - intersect);
}

// ── Rule engine: per-model derivation ────────────────────────────────────────

interface RuleHints {
  aspectKeywordRatio?: string;
  aspectKeywordReason?: string;
  /**
   * V085-MODEL-STYLE-DIVERSITY: ranked candidates rather than a single
   * pick. The rule engine walks this list per model and skips styles
   * already taken by sibling models with overlapping pools.
   */
  styleKeyword?: { candidates: readonly string[]; reason: string };
  detailHit?: string;
  shortVideoHit?: string;
  longVideoHit?: string;
  silentVideoHit?: string;
}

function deriveHints(prompt: string): RuleHints {
  const hints: RuleHints = {};
  for (const rule of ASPECT_RULES) {
    const hit = firstHit(prompt, rule.keywords);
    if (hit) {
      hints.aspectKeywordRatio = rule.ratio;
      hints.aspectKeywordReason = `"${hit}" → ${rule.reason}`;
      break;
    }
  }
  // RAY-TRACED-FIX (IMG-INVEST-001 issue 5, 2026-05-23): accumulate
  // matches across ALL STYLE_RULES instead of break-on-first. The old
  // first-match-break made rules later in the list (e.g. the explicit
  // raytrace rule and the 3D rule) unreachable for any prompt that
  // mentioned a more common cue first ("illustration", "photograph").
  // We now interleave each matching rule's candidate list: take the
  // top pick from each rule, then the second pick from each, etc.
  // This gives the diversity walker a richer candidate set so styles
  // like Ray Traced can actually surface for prompts that mention
  // both 3D intent AND illustration aesthetics.
  const styleMatches: { candidates: readonly string[]; hit: string; reason: string }[] = [];
  for (const rule of STYLE_RULES) {
    const hit = firstHit(prompt, rule.keywords);
    if (hit) styleMatches.push({ candidates: rule.styleNames, hit, reason: rule.reason });
  }
  if (styleMatches.length > 0) {
    const interleaved: string[] = [];
    const maxLen = Math.max(...styleMatches.map((m) => m.candidates.length));
    for (let i = 0; i < maxLen; i++) {
      for (const m of styleMatches) {
        const candidate = m.candidates[i];
        if (candidate && !interleaved.includes(candidate)) interleaved.push(candidate);
      }
    }
    hints.styleKeyword = {
      candidates: interleaved,
      reason: styleMatches.map((m) => `"${m.hit.trim()}" → ${m.reason}`).join('; '),
    };
  }
  hints.detailHit = firstHit(prompt, DETAIL_KEYWORDS);
  hints.shortVideoHit = firstHit(prompt, SHORT_VIDEO_KEYWORDS);
  hints.longVideoHit = firstHit(prompt, LONG_VIDEO_KEYWORDS);
  hints.silentVideoHit = firstHit(prompt, SILENT_VIDEO_KEYWORDS);
  return hints;
}

/** Pick the best supported aspect ratio for an image model given a hint. */
function pickImageAspect(
  spec: LeonardoImageModelSpec,
  hint: string | undefined,
): { aspectRatio: string; width: number; height: number; reason: string; clamped: boolean } {
  const supported = spec.supported_sizes;
  // Map "WxH" → "AR" for parsing. Falls back to the spec's own width/height.
  const sizeToAspect = (sz: string): string | undefined => {
    const m = sz.match(/^(\d+)x(\d+)$/);
    if (!m) return undefined;
    const w = parseInt(m[1], 10);
    const h = parseInt(m[2], 10);
    if (w === h) return '1:1';
    if (w === 1024 && h === 1536) return '2:3';
    if (w === 1536 && h === 1024) return '3:2';
    return undefined;
  };
  const supportedAspects = new Set<string>();
  for (const sz of supported) {
    const a = sizeToAspect(sz);
    if (a) supportedAspects.add(a);
  }
  const wantHint = hint && supportedAspects.has(hint);
  const chosenAspect = wantHint ? hint : '1:1';
  const reason = wantHint
    ? `${hint} supported by this model`
    : hint
      ? `${hint} unsupported by this model — fallback to 1:1`
      : 'default 1:1 (no orientation cue)';
  // Resolve dims from the matching supported_size string.
  let width = spec.width;
  let height = spec.height;
  for (const sz of supported) {
    if (sizeToAspect(sz) === chosenAspect) {
      const m = sz.match(/^(\d+)x(\d+)$/);
      if (m) {
        width = parseInt(m[1], 10);
        height = parseInt(m[2], 10);
        break;
      }
    }
  }
  return {
    aspectRatio: chosenAspect,
    width,
    height,
    reason,
    clamped: !wantHint && Boolean(hint) && hint !== '1:1',
  };
}

/**
 * Build a per-model rule-based suggestion for a single model.
 *
 * `excludedStyles` carries the styles already assigned to sibling
 * models with overlapping style pools (V085-MODEL-STYLE-DIVERSITY).
 * The rule engine walks `hints.styleKeyword.candidates` and picks the
 * first one that is (a) supported by the model and (b) not in the
 * excluded set, so sibling models never collide on the same pick.
 */
function ruleEngineForModel(
  modelId: string,
  spec: LeonardoModelSpec,
  apiName: string,
  hints: RuleHints,
  availableStyleNames: Set<string>,
  carriedNegativePrompt: string | undefined,
  excludedStyles?: ReadonlySet<string>,
): PerModelSuggestion {
  if (spec.type === 'image') {
    const aspect = pickImageAspect(spec, hints.aspectKeywordRatio);
    const imageSize: '1K' | '2K' = hints.detailHit ? '2K' : '1K';

    let quality: 'LOW' | 'MEDIUM' | 'HIGH' | undefined;
    let qualityReason: string | undefined;
    if (spec.quality && spec.quality.length > 0) {
      // gpt-image-1.5 spec pins quality to HIGH (see lib/model-specs/gpt-image-1.5.json:
      // "quality must always be HIGH"). Other quality-capable models keep the
      // detailHit-driven heuristic for cost/quality balance.
      if (modelId === 'gpt-image-1.5') {
        quality = 'HIGH';
        qualityReason = 'HIGH quality — per model spec';
      } else {
        quality = hints.detailHit ? 'HIGH' : 'MEDIUM';
        qualityReason = hints.detailHit
          ? `"${hints.detailHit}" → HIGH quality`
          : 'MEDIUM — balanced cost / quality';
      }
    }

    let style: string | undefined;
    let styleReason: string | undefined;
    if (spec.style_ids && hints.styleKeyword) {
      for (const candidate of hints.styleKeyword.candidates) {
        if (availableStyleNames.has(candidate) && !excludedStyles?.has(candidate)) {
          style = candidate;
          styleReason = hints.styleKeyword.reason;
          break;
        }
      }
    }

    const promptEnhance: 'ON' | 'OFF' = spec.prompt_enhance;
    const reasonParts = [
      `${aspect.reason}`,
      `${imageSize} render`,
      qualityReason,
      styleReason,
      `prompt_enhance ${promptEnhance}`,
    ].filter(Boolean);

    return {
      type: 'image',
      modelId,
      apiName,
      aspectRatio: aspect.aspectRatio,
      width: aspect.width,
      height: aspect.height,
      imageSize,
      quality,
      promptEnhance,
      style,
      negativePrompt: carriedNegativePrompt,
      reason: reasonParts.join('; '),
      source: 'rules',
    };
  }

  // Video model.
  // Aspect: respect hint when one of {1:1, 9:16, 16:9}; else default 16:9
  // (the model's native landscape).
  let aspectRatio = '16:9';
  let width = 1920;
  let height = 1080;
  if (hints.aspectKeywordRatio === '9:16') {
    aspectRatio = '9:16';
    width = 1080;
    height = 1920;
  } else if (hints.aspectKeywordRatio === '1:1') {
    aspectRatio = '1:1';
    width = 1440;
    height = 1440;
  }

  let duration = spec.duration;
  let durationReason = `${duration}s default for ${modelId}`;
  if (hints.shortVideoHit) {
    duration = Math.max(3, Math.min(duration, 4));
    durationReason = `"${hints.shortVideoHit}" → short ${duration}s clip`;
  } else if (hints.longVideoHit && modelId !== 'kling-o3') {
    duration = Math.min(15, Math.max(duration, 8));
    durationReason = `"${hints.longVideoHit}" → ${duration}s extended take`;
  }

  const mode: 'RESOLUTION_720' | 'RESOLUTION_1080' =
    spec.mode === 'RESOLUTION_720' ? 'RESOLUTION_720' : 'RESOLUTION_1080';

  let motionHasAudio: boolean | undefined;
  if (typeof spec.motion_has_audio === 'boolean') {
    motionHasAudio = hints.silentVideoHit ? false : spec.motion_has_audio;
  }

  const reasonParts = [
    `${aspectRatio} ${width}×${height}`,
    durationReason,
    mode,
    motionHasAudio === undefined
      ? undefined
      : motionHasAudio
        ? 'audio on'
        : `audio off${hints.silentVideoHit ? ` ("${hints.silentVideoHit}")` : ''}`,
  ].filter(Boolean);

  return {
    type: 'video',
    modelId,
    apiName,
    aspectRatio,
    width,
    height,
    duration,
    mode,
    motionHasAudio,
    reason: reasonParts.join('; '),
    source: 'rules',
  };
}

// ── Public rule engine ───────────────────────────────────────────────────────

export function suggestParameters(input: SuggestParametersInput): ParamSuggestion {
  const {
    prompt,
    availableModels,
    modelGuides,
    availableStyles,
    savedImages,
    topN = 99,
    excludedModelIds = ['nano-banana'],
    includedModelIds,
    modelParams = LEONARDO_MODEL_PARAMS,
    provider,
  } = input;

  const promptTokens = tokenize(prompt);
  const excluded = new Set(excludedModelIds);
  // P2 of PROV-AGNOSTIC-PARAMS: when the caller passes a provider, drop
  // models whose `LeonardoModelConfig.provider` doesn't match. Undefined
  // provider on the model is treated as `'leonardo'` for back-compat —
  // every spec shipped before MXIMG-001 omits the field and is implicitly
  // Leonardo. When `provider` is undefined on the input, the filter is a
  // no-op and the engine keeps its prior all-providers behaviour.
  const eligible = availableModels.filter(m => {
    if (excluded.has(m.id)) return false;
    if (provider !== undefined && (m.provider ?? 'leonardo') !== provider) return false;
    return true;
  });
  const hints = deriveHints(prompt);
  const availableStyleNames = new Set(availableStyles.map(s => s.name));

  // ── Prior-success mining (Jaccard over prompts) ──────────────────────────
  const winners = savedImages.filter(
    img => (img.winner || img.approved || img.isPostReady) && img.modelInfo?.modelId,
  );
  const scoredWinners = winners
    .map(img => ({ img, score: jaccard(promptTokens, tokenize(img.prompt)) }))
    .filter(s => s.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // ── Model ranking (keyword-guide overlap + prior-success boost) ──────────
  const modelScore = new Map<string, number>();
  for (const m of eligible) {
    const guide = modelGuides[m.id];
    if (!guide) {
      modelScore.set(m.id, 0);
      continue;
    }
    const guideTokens = tokenize(guide);
    let overlap = 0;
    for (const t of promptTokens) if (guideTokens.has(t)) overlap++;
    modelScore.set(m.id, overlap);
  }
  for (const s of scoredWinners) {
    const id = s.img.modelInfo?.modelId;
    if (id && modelScore.has(id)) {
      modelScore.set(id, (modelScore.get(id) ?? 0) + s.score * 10);
    }
  }
  const ranked = eligible
    .map(m => ({ id: m.id, score: modelScore.get(m.id) ?? 0 }))
    .sort((a, b) => b.score - a.score);

  // Force-include any model the caller already selected, even if it
  // ranked outside topN. `excludedModelIds` (e.g. the pipeline-skipped
  // nano-banana) still wins — forcing a model the engine explicitly
  // excludes would contradict the exclusion contract.
  const forced = new Set(
    (includedModelIds ?? []).filter(id => !excluded.has(id) && modelScore.has(id)),
  );
  const wantedCount = Math.max(1, Math.min(topN, ranked.length));
  const topSlots = Math.max(0, wantedCount - forced.size);
  const topRanked = ranked
    .filter(m => !forced.has(m.id))
    .slice(0, topSlots)
    .map(m => m.id);
  // Preserve rank order for forced models so UI panels stay ordered.
  const forcedOrdered = ranked.filter(m => forced.has(m.id)).map(m => m.id);
  const modelIds = Array.from(new Set([...forcedOrdered, ...topRanked]));

  const forcedCount = forcedOrdered.length;
  const rankedCount = modelIds.length - forcedCount;
  const forcedReason = forcedCount > 0 ? ` + ${forcedCount} user-selected` : '';
  const modelsReason = scoredWinners.length > 0
    ? `top ${rankedCount} by prompt-guide fit + ${scoredWinners.length} prior winner${scoredWinners.length === 1 ? '' : 's'}${forcedReason}`
    : `top ${rankedCount} by prompt-guide keyword fit${forcedReason}`;

  // ── Negative prompt (from closest prior winner that had one) ─────────────
  let carriedNegativePrompt: string | undefined;
  let carriedNegativeReason: string | undefined;
  const priorWithNeg = scoredWinners.find(s => s.img.negativePrompt?.trim());
  if (priorWithNeg?.img.negativePrompt) {
    carriedNegativePrompt = priorWithNeg.img.negativePrompt;
    const snippet = priorWithNeg.img.prompt.slice(0, 40);
    carriedNegativeReason = `carried over from prior winner "${snippet}${priorWithNeg.img.prompt.length > 40 ? '…' : ''}"`;
  }

  // ── Per-model derivation ─────────────────────────────────────────────────
  // V085-MODEL-STYLE-DIVERSITY: walk models in rank order; each picked
  // style joins `usedStyles`, which subsequent style-supporting models
  // exclude from their own picks. Today every style-supporting model
  // shares LEONARDO_SHARED_STYLES, so a single global set is sufficient.
  // If/when distinct style pools land, swap this for a Map keyed by pool.
  const perModel: Record<string, PerModelSuggestion> = {};
  const usedStyles = new Set<string>();
  for (const id of modelIds) {
    const spec = modelParams[id];
    const cfg = availableModels.find(m => m.id === id);
    const apiName = spec?.api_name ?? cfg?.apiModelId ?? id;
    if (!spec) continue;
    const entry = ruleEngineForModel(
      id,
      spec,
      apiName,
      hints,
      availableStyleNames,
      carriedNegativePrompt,
      usedStyles,
    );
    perModel[id] = entry;
    if (entry.type === 'image' && entry.style) {
      usedStyles.add(entry.style);
    }
  }

  // ── "Best shared" view ───────────────────────────────────────────────────
  // The legacy apply path writes a single shared GenerateOptions; we
  // derive that from the highest-ranked per-model entry so the UI keeps
  // working without a per-model state migration. The per-model values
  // remain in `perModel` for the new card to render.
  const firstId = modelIds[0];
  const first = firstId ? perModel[firstId] : undefined;

  let aspectRatio = '1:1';
  let aspectReason = 'default 1:1';
  let imageSize: '1K' | '2K' = '1K';
  let imageSizeReason = 'standard 1K render';
  let quality: 'LOW' | 'MEDIUM' | 'HIGH' | undefined;
  let qualityReason: string | undefined;
  let promptEnhance: 'ON' | 'OFF' | undefined;
  let promptEnhanceReason: string | undefined;
  let style: string | undefined;
  let styleReason: string | undefined;

  if (first) {
    aspectRatio = first.aspectRatio;
    aspectReason = `${first.modelId}: ${first.reason.split(';')[0]?.trim() || first.aspectRatio}`;
    if (first.type === 'image') {
      imageSize = first.imageSize;
      imageSizeReason = first.imageSize === '2K' ? `"${hints.detailHit}" → 2K` : 'standard 1K render';
      quality = first.quality;
      qualityReason = first.quality
        ? hints.detailHit
          ? `"${hints.detailHit}" → ${first.quality}`
          : `${first.quality} — balanced cost / quality`
        : undefined;
      promptEnhance = first.promptEnhance;
      promptEnhanceReason = `prompt_enhance ${first.promptEnhance}`;
      style = first.style;
      styleReason = first.style ? hints.styleKeyword?.reason : undefined;
    }
  }

  return {
    modelIds,
    perModel,
    aspectRatio,
    style,
    imageSize,
    negativePrompt: carriedNegativePrompt,
    quality,
    promptEnhance,
    reasons: {
      models: modelsReason,
      aspectRatio: aspectReason,
      style: styleReason,
      imageSize: imageSizeReason,
      negativePrompt: carriedNegativeReason,
      quality: qualityReason,
      promptEnhance: promptEnhanceReason,
    },
    priorMatchCount: scoredWinners.length,
    source: 'rules',
  };
}

/**
 * Synthesise a minimal rules-only PerModelSuggestion for a model not in
 * the AI shortlist. Used by the param-suggestion card when the user
 * toggles a model ON after the initial suggestion has been generated,
 * so the card can show a default panel instead of "(no suggestion)".
 * Returns null if the model has no spec registered.
 */
export function buildRuleFallbackForModel(
  modelId: string,
  opts: {
    availableModels?: LeonardoModelConfig[];
    modelParams?: Record<string, LeonardoModelSpec>;
  } = {},
): PerModelSuggestion | null {
  const modelParams = opts.modelParams ?? LEONARDO_MODEL_PARAMS;
  const spec = modelParams[modelId];
  const cfg = opts.availableModels?.find(m => m.id === modelId);
  const apiName = spec?.api_name ?? cfg?.apiModelId ?? modelId;
  if (!spec) return null;

  if (spec.type === 'video') {
    return {
      type: 'video',
      modelId,
      apiName,
      aspectRatio: '16:9',
      width: spec.width,
      height: spec.height,
      duration: spec.duration,
      mode: /1080/.test(spec.mode) ? 'RESOLUTION_1080' : 'RESOLUTION_720',
      motionHasAudio: spec.motion_has_audio,
      reason: 'Default parameters — edit to customise.',
      source: 'rules',
    };
  }

  return {
    type: 'image',
    modelId,
    apiName,
    aspectRatio: '1:1',
    width: spec.width,
    height: spec.height,
    imageSize: '1K',
    promptEnhance: spec.prompt_enhance,
    reason: 'Default parameters — edit to customise.',
    source: 'rules',
  };
}

// ── AI-PARAM-SUGGEST (2026-05-20): AI variant re-introduced with guards ─────
//
// V082 retired the pi.dev variant because it hallucinated wrong values
// for capability-aware models (proposing styles for gpt-image-1.5,
// mis-mapping aspect ratios, etc.). The rule engine became the only
// source of truth.
//
// This iteration brings the AI variant back, but with three guards that
// V082 lacked:
//
//   1. The rule engine runs FIRST and becomes the baseline. The AI's
//      job is to refine that baseline, not to author from scratch. If
//      the AI fails (parse error, network, validation), we silently
//      return the baseline.
//   2. The AI prompt embeds an explicit capability table — every model
//      gets a one-liner saying which fields are allowed. If the model
//      still hallucinates outside the contract, step 3 catches it.
//   3. `applyCapabilityFilter` walks every AI-authored field and drops
//      anything that violates the spec, regardless of what the AI said.
//      Style for gpt-image-1.5 → undefined. Negative prompt for
//      gpt-image-1.5 → undefined. Aspect ratio outside the supported
//      set → fallback to rule-engine choice. Unknown styles → undefined.
//
// The brief explicitly requested this re-introduction with the same
// capability discipline that V082's failure was about. The filter is
// the contract.
//
// `aiCall` is the only thing wired to the network — passed in by the
// caller (MainContent / useIdeaProcessor) so this module stays
// provider-agnostic and testable.

export interface SuggestParametersAIOptions {
  /** Optional abort plumbing for the AI call. */
  signal?: AbortSignal;
  /**
   * Inject an AI text-completion. Receives the fully-assembled prompt
   * and an AbortSignal; returns the raw AI response text. Wire to
   * `streamAIToString` at call sites.
   *
   * When omitted (or when the call throws), we fall back to the pure
   * rule engine — never block the user on an AI hiccup.
   */
  aiCall?: (message: string, signal?: AbortSignal) => Promise<string>;
  /** Override the rule engine baseline. Defaults to suggestParameters. */
  fallback?: (input: SuggestParametersInput) => ParamSuggestion;
}

const ALLOWED_ASPECTS_IMAGE = ['1:1', '2:3', '3:2', '9:16', '16:9', '3:4', '4:3', '4:5', '5:4'];
const ALLOWED_ASPECTS_VIDEO = ['1:1', '9:16', '16:9'];

/** Capability slice used by the AI prompt + the post-filter. */
interface CapabilityRow {
  modelId: string;
  type: 'image' | 'video';
  styles: boolean;
  negativePrompt: boolean;
  imageSize: boolean;
  promptEnhance: boolean;
  quality: boolean;
  audio: boolean;
}

function buildCapabilityRows(
  modelIds: readonly string[],
  modelParams: Record<string, LeonardoModelSpec>,
): CapabilityRow[] {
  const rows: CapabilityRow[] = [];
  for (const id of modelIds) {
    const spec = modelParams[id];
    if (!spec) continue;
    rows.push({
      modelId: id,
      type: spec.type,
      styles: spec.type === 'image' ? Boolean(spec.style_ids) : false,
      // Mirrors the gpt-image-1.5 strip in lib/modelOptimizer.ts.
      // (Spec capabilities.negativePrompt is wrong for nano-banana so
      // we don't use it here.)
      negativePrompt: id !== 'gpt-image-1.5',
      imageSize: spec.type === 'image',
      promptEnhance: spec.type === 'image',
      quality:
        spec.type === 'image' && Array.isArray(spec.quality) && spec.quality.length > 0,
      audio: spec.type === 'video' && typeof spec.motion_has_audio === 'boolean',
    });
  }
  return rows;
}

function renderCapabilityTable(rows: CapabilityRow[]): string {
  return rows
    .map((r) => {
      const flags = [
        r.styles ? 'style' : null,
        r.negativePrompt ? 'negative' : null,
        r.imageSize ? 'size' : null,
        r.promptEnhance ? 'enhance' : null,
        r.quality ? 'quality' : null,
        r.audio ? 'audio' : null,
      ].filter(Boolean);
      return `- ${r.modelId} (${r.type}): ${flags.length ? flags.join(', ') : 'no extras'}`;
    })
    .join('\n');
}

function buildAIPrompt(
  input: SuggestParametersInput,
  baseline: ParamSuggestion,
  modelParams: Record<string, LeonardoModelSpec>,
): string {
  const rows = buildCapabilityRows(baseline.modelIds, modelParams);
  const styleList = input.availableStyles.map((s) => s.name).join(', ');
  const baselineJson = JSON.stringify(
    Object.fromEntries(
      Object.entries(baseline.perModel).map(([id, e]) => [
        id,
        e.type === 'image'
          ? {
              aspectRatio: e.aspectRatio,
              imageSize: e.imageSize,
              quality: e.quality ?? null,
              promptEnhance: e.promptEnhance,
              style: e.style ?? null,
              negativePrompt: e.negativePrompt ?? null,
            }
          : {
              aspectRatio: e.aspectRatio,
              duration: e.duration,
              mode: e.mode,
              motionHasAudio: e.motionHasAudio ?? null,
            },
      ]),
    ),
    null,
    2,
  );
  return `You are tuning image/video generation parameters for a set of AI models. Return ONLY a JSON object — no preamble, no commentary, no markdown fences.

User prompt:
"""
${input.prompt}
"""

Trending context (use this to guide your parameter picks if relevant):
${input.trendingContext || '(none available)'}

Model capabilities (only set fields the model lists; ignore everything else):
${renderCapabilityTable(rows)}

Available style names (use one of these or null):
${styleList || '(none available)'}

Allowed aspect ratios for image models: ${ALLOWED_ASPECTS_IMAGE.join(', ')}
Allowed aspect ratios for video models: ${ALLOWED_ASPECTS_VIDEO.join(', ')}
Allowed imageSize: "1K" or "2K"
Allowed quality (image models that list it): "LOW", "MEDIUM", "HIGH"
Allowed promptEnhance: "ON" or "OFF"

Rule-engine baseline (use this as a starting point — refine where you have a stronger signal):
${baselineJson}

Output schema — return EXACTLY this shape:
{
  "perModel": {
    "<modelId>": {
      "aspectRatio": "1:1" | "2:3" | ... ,
      "imageSize": "1K" | "2K",        // image only
      "quality": "HIGH" | null,         // image only, only if model lists quality
      "promptEnhance": "ON" | "OFF",    // image only
      "style": "<style name>" | null,   // image only, only if model lists style
      "negativePrompt": "..." | null,   // image only, only if model lists negative
      "duration": 5,                    // video only
      "mode": "RESOLUTION_720" | "RESOLUTION_1080",  // video only
      "motionHasAudio": true | false | null,         // video only, only if model lists audio
      "reason": "1-2 sentence rationale"
    }
  },
  "overall": "1-2 sentence summary of the strategy across models"
}

Use null (not omit) for fields the model doesn't list. Do not invent new fields. Do not change the modelId keys.`;
}

function isAllowedAspect(value: unknown, type: 'image' | 'video'): value is string {
  const allowed = type === 'image' ? ALLOWED_ASPECTS_IMAGE : ALLOWED_ASPECTS_VIDEO;
  return typeof value === 'string' && allowed.includes(value);
}

/**
 * Merge an AI-authored per-model entry into the baseline. Every field
 * is capability-checked against `row`; anything that violates the spec
 * is dropped silently and the baseline's value is kept instead.
 *
 * Returns the merged entry plus whether ANY field was actually
 * overridden by the AI — used to decide between 'ai' / 'ai+rules' /
 * 'rules' source labels downstream.
 */
function mergeOneEntry(
  baseline: PerModelSuggestion,
  aiRaw: Record<string, unknown>,
  row: CapabilityRow,
  availableStyleNames: Set<string>,
): { entry: PerModelSuggestion; aiTouched: boolean } {
  let aiTouched = false;
  const aiReason = typeof aiRaw.reason === 'string' ? aiRaw.reason.trim() : '';

  if (baseline.type === 'image' && row.type === 'image') {
    const next: PerModelImageSuggestion = { ...baseline };

    if (isAllowedAspect(aiRaw.aspectRatio, 'image')) {
      // Resolve width/height by reusing the rule engine's mapping. The
      // baseline already has a (width, height) for its chosen aspect;
      // if the AI picks a different one we just inherit baseline w/h
      // unless we have a better source. Keeping it simple: trust the
      // model spec on dimensions — they're 1024×1024 across the
      // current image set, so aspectRatio is purely a labelling change
      // that downstream consumers re-resolve when calling the API.
      if (next.aspectRatio !== aiRaw.aspectRatio) aiTouched = true;
      next.aspectRatio = aiRaw.aspectRatio as string;
    }
    if (aiRaw.imageSize === '1K' || aiRaw.imageSize === '2K') {
      if (next.imageSize !== aiRaw.imageSize) aiTouched = true;
      next.imageSize = aiRaw.imageSize;
    }
    if (row.quality && (aiRaw.quality === 'LOW' || aiRaw.quality === 'MEDIUM' || aiRaw.quality === 'HIGH')) {
      if (next.quality !== aiRaw.quality) aiTouched = true;
      next.quality = aiRaw.quality;
    } else if (!row.quality) {
      next.quality = undefined;
    }
    if (aiRaw.promptEnhance === 'ON' || aiRaw.promptEnhance === 'OFF') {
      if (next.promptEnhance !== aiRaw.promptEnhance) aiTouched = true;
      next.promptEnhance = aiRaw.promptEnhance;
    }
    if (row.styles) {
      if (typeof aiRaw.style === 'string' && availableStyleNames.has(aiRaw.style)) {
        if (next.style !== aiRaw.style) aiTouched = true;
        next.style = aiRaw.style;
      } else if (aiRaw.style === null) {
        if (next.style !== undefined) aiTouched = true;
        next.style = undefined;
      }
    } else {
      // Capability filter: model has no style param. Always undefined.
      next.style = undefined;
    }
    if (row.negativePrompt) {
      if (typeof aiRaw.negativePrompt === 'string' && aiRaw.negativePrompt.trim()) {
        if (next.negativePrompt !== aiRaw.negativePrompt) aiTouched = true;
        next.negativePrompt = aiRaw.negativePrompt.trim();
      } else if (aiRaw.negativePrompt === null) {
        if (next.negativePrompt !== undefined) aiTouched = true;
        next.negativePrompt = undefined;
      }
    } else {
      next.negativePrompt = undefined;
    }

    if (aiReason) next.reason = aiReason;
    next.source = aiTouched ? 'ai' : 'rules';
    return { entry: next, aiTouched };
  }

  if (baseline.type === 'video' && row.type === 'video') {
    const next: PerModelVideoSuggestion = { ...baseline };

    if (isAllowedAspect(aiRaw.aspectRatio, 'video')) {
      if (next.aspectRatio !== aiRaw.aspectRatio) aiTouched = true;
      next.aspectRatio = aiRaw.aspectRatio as string;
    }
    if (typeof aiRaw.duration === 'number' && aiRaw.duration > 0 && aiRaw.duration <= 30) {
      if (next.duration !== aiRaw.duration) aiTouched = true;
      next.duration = aiRaw.duration;
    }
    if (aiRaw.mode === 'RESOLUTION_720' || aiRaw.mode === 'RESOLUTION_1080') {
      if (next.mode !== aiRaw.mode) aiTouched = true;
      next.mode = aiRaw.mode;
    }
    if (row.audio) {
      if (typeof aiRaw.motionHasAudio === 'boolean') {
        if (next.motionHasAudio !== aiRaw.motionHasAudio) aiTouched = true;
        next.motionHasAudio = aiRaw.motionHasAudio;
      } else if (aiRaw.motionHasAudio === null) {
        next.motionHasAudio = undefined;
      }
    } else {
      next.motionHasAudio = undefined;
    }

    if (aiReason) next.reason = aiReason;
    next.source = aiTouched ? 'ai' : 'rules';
    return { entry: next, aiTouched };
  }

  return { entry: baseline, aiTouched: false };
}

/**
 * Capability-aware merge of an AI JSON response into the rule-engine
 * baseline. Every per-model field is validated; anything that violates
 * the spec is dropped and the baseline value is kept.
 *
 * Returns the merged ParamSuggestion. Source label resolves to:
 *   - 'ai'        — every selected model got at least one AI override
 *   - 'ai+rules'  — some models were AI-touched, others fell back
 *   - 'rules'     — no model was AI-touched (response was useless)
 *
 * Exported for unit testing without going through `suggestParametersAI`.
 */
export function applyCapabilityFilter(
  parsed: Record<string, unknown>,
  baseline: ParamSuggestion,
  input: SuggestParametersInput,
  modelParams: Record<string, LeonardoModelSpec> = LEONARDO_MODEL_PARAMS,
): ParamSuggestion {
  const aiPerModel =
    parsed.perModel && typeof parsed.perModel === 'object'
      ? (parsed.perModel as Record<string, Record<string, unknown>>)
      : {};
  const overall = typeof parsed.overall === 'string' ? parsed.overall : undefined;

  const rows = buildCapabilityRows(baseline.modelIds, modelParams);
  const rowById = new Map(rows.map((r) => [r.modelId, r]));
  const availableStyleNames = new Set(input.availableStyles.map((s) => s.name));

  const mergedPerModel: Record<string, PerModelSuggestion> = {};
  let touchedAny = false;
  let touchedAll = true;
  for (const id of baseline.modelIds) {
    const base = baseline.perModel[id];
    const row = rowById.get(id);
    const aiEntry = aiPerModel[id];
    if (!base) continue;
    if (!row || !aiEntry || typeof aiEntry !== 'object') {
      mergedPerModel[id] = base;
      touchedAll = false;
      continue;
    }
    const { entry, aiTouched } = mergeOneEntry(base, aiEntry, row, availableStyleNames);
    mergedPerModel[id] = entry;
    if (aiTouched) touchedAny = true;
    else touchedAll = false;
  }

  const source: SuggestionSource = touchedAll && touchedAny
    ? 'ai'
    : touchedAny
      ? 'ai+rules'
      : 'rules';

  const firstId = baseline.modelIds[0];
  const first = firstId ? mergedPerModel[firstId] : undefined;

  return {
    ...baseline,
    perModel: mergedPerModel,
    aspectRatio: first?.aspectRatio ?? baseline.aspectRatio,
    style: first?.type === 'image' ? first.style : baseline.style,
    imageSize: first?.type === 'image' ? first.imageSize : baseline.imageSize,
    quality: first?.type === 'image' ? first.quality : baseline.quality,
    promptEnhance: first?.type === 'image' ? first.promptEnhance : baseline.promptEnhance,
    negativePrompt:
      first?.type === 'image' ? first.negativePrompt : baseline.negativePrompt,
    reasons: {
      ...baseline.reasons,
      overall: overall ?? baseline.reasons.overall,
    },
    source,
  };
}

/**
 * AI-tuned parameter suggestion with rule-engine fallback.
 *
 * When `options.aiCall` is wired (real callers) AND the call returns a
 * parseable JSON response, the AI's overrides are merged into the rule-
 * engine baseline through `applyCapabilityFilter` — so the user gets
 * AI judgment for fields the AI got right, AND rule-engine values for
 * everything the AI hallucinated, never the other way around.
 *
 * When `aiCall` is omitted, the response can't be parsed, or anything
 * throws, the function returns the pure rule-engine baseline. Failure
 * is silent and never blocks the user.
 */
export async function suggestParametersAI(
  input: SuggestParametersInput,
  options: SuggestParametersAIOptions = {},
): Promise<ParamSuggestion> {
  const fallbackFn = options.fallback ?? suggestParameters;
  const baseline = fallbackFn(input);

  if (!options.aiCall) return baseline;
  if (baseline.modelIds.length === 0) return baseline;

  try {
    const modelParams = input.modelParams ?? LEONARDO_MODEL_PARAMS;
    const prompt = buildAIPrompt(input, baseline, modelParams);
    const raw = await options.aiCall(prompt, options.signal);
    if (!raw || typeof raw !== 'string') return baseline;
    const parsed = extractJsonObjectFromLLM(raw);
    if (!parsed || Object.keys(parsed).length === 0) return baseline;
    return applyCapabilityFilter(parsed, baseline, input, modelParams);
  } catch {
    return baseline;
  }
}
