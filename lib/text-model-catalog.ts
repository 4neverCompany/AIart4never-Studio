/**
 * Text-generation model catalog for the vercel-ai prompt route.
 *
 * Single source of truth for every text model MashupForge knows how
 * to call via the Vercel AI SDK (currently: MiniMax via the
 * OpenAI-compatible Chat Completions endpoint + OpenAI's native
 * Chat Completions endpoint).
 *
 * Why a catalog rather than the old hardcoded `TEXT_MODEL_SPECS` map:
 *   - Users can see every model the app knows about, with metadata
 *     (family, generation, default temperature, context window,
 *     recommended use case), and pick one from a list — instead of
 *     a hidden `VERCEL_AI_MODEL` env var or hand-edited settings.
 *   - The Settings → AI Engine tab gets a model picker populated
 *     from this catalog (parallel to the nca model picker). A model
 *     is "available" if its provider's API key env var is set on
 *     the server; the UI hides / greys out models whose key is
 *     missing.
 *   - Adding a new model = one entry here. The picker, status route,
 *     and per-mode parameter derivation all consume this catalog.
 *
 * Note on model names: the actual upstream model strings for MiniMax
 * are published as `MiniMax-M2`, `MiniMax-M2.5`, `MiniMax-M2.7`,
 * `MiniMax-M2.7-highspeed`, and the new `MiniMax-M3` family. We
 * prefix with `MiniMax-` (matching MiniMax's own API ID style) so the
 * provider's SDK call stays a verbatim string match. Historical code
 * sometimes wrote `M2.7-highspeed` (without the `MiniMax-` prefix);
 * those entries are kept here as aliases for back-compat with persisted
 * user selections — see resolveTextModel() for the normalisation.
 *
 * To add a new model:
 *   1. Add a `TextModelCatalogEntry` below.
 *   2. (Optional) Add per-mode overrides via `modeOverrides` if the
 *      SHARED_MODE_OVERRIDES baseline doesn't fit (rare; M2.7 is the
 *      one model that has had bespoke defaults historically).
 *   3. The /api/ai/models route auto-surfaces the new entry.
 *
 * Provider availability: a model is "available" if its provider's
 * API key env var is set. The catalog itself doesn't know about env
 * vars — `getAvailableTextModels()` takes an `envKeys` snapshot and
 * filters. This keeps the catalog pure and testable.
 */

import type { ModelSpecProvider } from './model-specs';

export type TextAiMode =
  | 'chat'
  | 'generate'
  | 'idea'
  | 'enhance'
  | 'caption'
  | 'tag'
  | 'negative-prompt'
  | 'collection-info';

export interface TextGenParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

export interface TextModelCatalogEntry {
  /**
   * The model ID as it appears in API requests. For MiniMax this is
   * the published upstream ID (e.g. `MiniMax-M2.7`); for OpenAI this
   * is the OpenAI-published ID (e.g. `gpt-4o-mini`). The model picker
   * writes this verbatim to the `model` field in `/api/ai/prompt` /
   * `VERCEL_AI_MODEL`.
   */
  modelId: string;
  /**
   * Aliases accepted by `resolveTextModel()`. Historical settings
   * may have persisted an older ID form (e.g. `M2.7-highspeed`
   * without the `MiniMax-` prefix); we resolve them to the
   * canonical `modelId` so the user doesn't have to re-pick.
   */
  aliases?: readonly string[];
  provider: ModelSpecProvider;
  /** Short family label shown in the picker, e.g. "MiniMax M2". */
  family: string;
  /** Generation tag — minor variant within the family. */
  generation: string;
  /** Marketing one-liner, displayed in the picker tooltip. */
  description: string;
  /** Recommended use case — drives the picker grouping. */
  recommendedFor: readonly TextAiMode[];
  /** Default context window (tokens). Used in the picker tooltip. */
  contextWindow: number;
  /** Default output token budget for the model's first call. */
  defaultMaxTokens: number;
  /** Default sampling temperature. */
  defaultTemperature: number;
  /** Provider-native parameter shape (no translation needed). */
  defaults: TextGenParams;
  /** Per-mode override map. Falls back to SHARED_MODE_OVERRIDES. */
  modeOverrides?: Partial<Record<TextAiMode, Partial<TextGenParams>>>;
  /**
   * If true, this is a fast / distilled variant of the family —
   * the picker renders a "⚡" badge so users know it's a speed
   * pick. Doesn't affect behaviour, just visual cue.
   */
  isHighspeed?: boolean;
  /**
   * If true, this model is the historical default for new installs.
   * Exactly one entry per provider should be marked default=true.
   * The picker uses this to render a "Default" badge.
   */
  isDefault?: boolean;
}

/**
 * Per-mode temperature profile shared across most models. Tuned for:
 *   - `idea`: variety > precision (0.95)
 *   - `chat`: balanced (0.8)
 *   - `generate`: prompt-engineering output, mid-precision (0.6)
 *   - `caption`: copywriting, balanced (0.7)
 *   - `enhance`: prompt rewriting, structured (0.5)
 *   - `tag` / `negative-prompt`: short structured output, low temp (0.3)
 *   - `collection-info`: JSON metadata, low-mid (0.5)
 */
const SHARED_MODE_OVERRIDES: Partial<Record<TextAiMode, Partial<TextGenParams>>> = {
  idea: { temperature: 0.95 },
  chat: { temperature: 0.8 },
  generate: { temperature: 0.6 },
  caption: { temperature: 0.7 },
  enhance: { temperature: 0.5 },
  tag: { temperature: 0.3 },
  'negative-prompt': { temperature: 0.3 },
  'collection-info': { temperature: 0.5 },
};

/**
 * Canonical catalog. Order = display order in the picker.
 * Newer models go first within each provider so the most up-to-date
 * options are at the top.
 */
export const TEXT_MODEL_CATALOG: readonly TextModelCatalogEntry[] = [
  // ── MiniMax ──────────────────────────────────────────────────────
  {
    modelId: 'MiniMax-M3',
    provider: 'minimax',
    family: 'MiniMax M3',
    generation: 'M3 (latest)',
    description:
      'Latest generation. Stronger reasoning, larger context, better instruction following for structured output (JSON, captions, ideas).',
    recommendedFor: ['idea', 'enhance', 'caption', 'chat', 'generate', 'collection-info'],
    contextWindow: 128_000,
    defaultMaxTokens: 16_384,
    defaultTemperature: 0.7,
    defaults: { temperature: 0.7, maxTokens: 16_384 },
    modeOverrides: SHARED_MODE_OVERRIDES,
    isDefault: true,
  },
  {
    modelId: 'MiniMax-M2.7',
    provider: 'minimax',
    family: 'MiniMax M2.7',
    generation: 'M2.7',
    description:
      'M2 generation flagship. Solid reasoning + structured output. Good general-purpose default for ideas, captions, and prompts.',
    recommendedFor: ['idea', 'enhance', 'caption', 'chat', 'generate', 'collection-info'],
    contextWindow: 128_000,
    defaultMaxTokens: 8_192,
    defaultTemperature: 0.7,
    defaults: { temperature: 0.7, maxTokens: 8_192 },
    modeOverrides: SHARED_MODE_OVERRIDES,
  },
  {
    modelId: 'MiniMax-M2.7-highspeed',
    aliases: ['M2.7-highspeed'], // back-compat with pre-v1.0 settings
    provider: 'minimax',
    family: 'MiniMax M2.7',
    generation: 'M2.7 (highspeed)',
    description:
      'Distilled M2.7 — same outputs at lower latency. Good for short loops (tag, negative prompt, caption polish) where every 100ms counts.',
    recommendedFor: ['tag', 'negative-prompt', 'caption', 'chat'],
    contextWindow: 64_000,
    defaultMaxTokens: 4_096,
    defaultTemperature: 0.8,
    defaults: { temperature: 0.8, maxTokens: 4_096 },
    modeOverrides: SHARED_MODE_OVERRIDES,
    isHighspeed: true,
  },
  {
    modelId: 'MiniMax-M2.5',
    provider: 'minimax',
    family: 'MiniMax M2.5',
    generation: 'M2.5',
    description:
      'Historical default before M2.7. Warmer sampling; useful for idea generation where variety > precision.',
    recommendedFor: ['idea', 'chat'],
    contextWindow: 32_000,
    defaultMaxTokens: 4_096,
    defaultTemperature: 0.8,
    defaults: { temperature: 0.8, maxTokens: 4_096 },
    modeOverrides: SHARED_MODE_OVERRIDES,
  },
  {
    modelId: 'MiniMax-M2',
    provider: 'minimax',
    family: 'MiniMax M2',
    generation: 'M2',
    description:
      'Original M2 release. Cheapest per token. Adequate for short structured output but loses coherence on long ideas/captions.',
    recommendedFor: ['tag', 'negative-prompt'],
    contextWindow: 16_000,
    defaultMaxTokens: 4_096,
    defaultTemperature: 0.8,
    defaults: { temperature: 0.8, maxTokens: 4_096 },
  },
  // ── OpenAI ───────────────────────────────────────────────────────
  {
    modelId: 'gpt-4o-mini',
    provider: 'openai',
    family: 'GPT-4o mini',
    generation: '4o-mini',
    description:
      'OpenAI\'s small-but-capable model. Strong JSON instruction following; used as the fallback when MiniMax is unavailable.',
    recommendedFor: ['caption', 'tag', 'enhance', 'collection-info', 'chat'],
    contextWindow: 128_000,
    defaultMaxTokens: 4_096,
    defaultTemperature: 0.7,
    defaults: { temperature: 0.7, maxTokens: 4_096 },
    modeOverrides: SHARED_MODE_OVERRIDES,
    isDefault: true,
  },
] as const;

/**
 * Lookup a catalog entry by raw modelId. Returns undefined for
 * unknown models so callers can detect typos and surface a "model
 * not found" error rather than silently using defaults.
 */
export function getTextModelCatalogEntry(
  modelId: string,
): TextModelCatalogEntry | undefined {
  return TEXT_MODEL_CATALOG.find((m) => m.modelId === modelId);
}

/**
 * Resolve a model identifier (with alias support) to a canonical
 * catalog entry. Historical settings may have stored a model under
 * an older alias form (e.g. `M2.7-highspeed` instead of the
 * canonical `MiniMax-M2.7-highspeed`). This helper normalises so
 * persisted selections keep working across catalog changes.
 */
export function resolveTextModel(
  modelId: string,
): TextModelCatalogEntry | undefined {
  const direct = getTextModelCatalogEntry(modelId);
  if (direct) return direct;
  return TEXT_MODEL_CATALOG.find((m) => m.aliases?.includes(modelId));
}

/**
 * Effective text-gen params for a (model, mode) pair. Layered:
 *   - `defaults` (from the catalog entry)
 *   - per-mode override (from the entry's `modeOverrides`, falling
 *     back to SHARED_MODE_OVERRIDES)
 *
 * Returns the catalog entry's defaults for unknown modelIds so the
 * caller gets sane values rather than `{}` (which would let the
 * upstream provider apply its own defaults silently).
 */
export function getTextModelParams(
  modelId: string,
  mode?: TextAiMode | string,
): TextGenParams {
  const entry = resolveTextModel(modelId);
  if (!entry) return {};
  const override = mode ? entry.modeOverrides?.[mode as TextAiMode] : undefined;
  return { ...entry.defaults, ...(override ?? {}) };
}

/** All catalog entries — convenience for /api/ai/models. */
export function getAllTextCatalogEntries(): readonly TextModelCatalogEntry[] {
  return TEXT_MODEL_CATALOG;
}

/** Catalog entries for a single provider — convenience for picker. */
export function getTextCatalogByProvider(
  provider: ModelSpecProvider,
): readonly TextModelCatalogEntry[] {
  return TEXT_MODEL_CATALOG.filter((m) => m.provider === provider);
}

/**
 * Default model ID for a given provider. The first entry in the
 * catalog with `isDefault: true` wins. Used as the env-var fallback
 * when no explicit selection is set.
 */
export function getDefaultTextModelForProvider(
  provider: ModelSpecProvider,
): string | undefined {
  return TEXT_MODEL_CATALOG.find((m) => m.provider === provider && m.isDefault)
    ?.modelId;
}

/**
 * Snapshot of which env-var API keys are set on the server. Routes
 * pass this in so the catalog stays pure (no direct env reads in
 * lib code, which would break isomorphic / SSR rendering).
 */
export interface TextModelEnvKeys {
  minimax: boolean;
  openai: boolean;
}

/**
 * Filter the catalog by available providers. Models whose provider's
 * env key is unset are still returned but marked `available: false`
 * so the UI can render them greyed out — users see what's possible
 * with a single API key toggle, and existing-but-unset providers
 * are visible (helpful for setup).
 */
export interface TextModelAvailability {
  entry: TextModelCatalogEntry;
  available: boolean;
}

export function getAvailableTextModels(
  envKeys: TextModelEnvKeys,
): readonly TextModelAvailability[] {
  return TEXT_MODEL_CATALOG.map((entry) => ({
    entry,
    available:
      entry.provider === 'minimax' ? envKeys.minimax :
      entry.provider === 'openai' ? envKeys.openai :
      false,
  }));
}
