/**
 * Structured model specs. One JSON file per model describing its full
 * API surface: allowed parameters, capabilities (what it can / cannot
 * do), style palette with UUIDs, aspect-ratio → dimension table, and
 * hard rules. pi.dev reads these to pick per-model parameters rather
 * than the legacy free-text API-doc blobs.
 */

import minimaxImage01 from './minimax-image-01.json';

/**
 * Backend provider that serves a model. Drives provider-aware
 * filtering in `suggestParameters` (P2) and UI dropdowns (P3) — see
 * `docs/bmad/briefs/PROV-AGNOSTIC-PARAMS.md`. `'minimax'` (image-01
 * endpoint) is the default image provider after the Leonardo engine
 * was removed.
 *
 * HIGGSFIELD-INTEGRATION: `'higgsfield'` is the second multi-tenant
 * image provider. Each user authenticates via OAuth against
 * `https://mcp.higgsfield.ai/mcp`; the `higgsfield_image` /
 * `higgsfield_video` API routes forward calls to the
 * `higgsfield_generate` MCP tool with model slugs from
 * `lib/higgsfield/models.ts`.
 */
export type ModelSpecProvider =
  | 'minimax'
  | 'openai'
  | 'anthropic'
  | 'openrouter'
  | 'higgsfield';

export interface ModelSpecCapabilities {
  styles?: boolean;
  negativePrompt?: boolean;
  imageSize?: boolean;
  alchemy?: boolean;
  presetStyles?: boolean;
  tiling?: boolean;
  audio?: boolean;
  promptEnhance?: boolean;
  startFrame?: boolean;
  endFrame?: boolean;
  imageReference?: boolean;
  videoReference?: boolean;
  seed?: boolean;
}

export interface ModelSpec {
  modelId: string;
  apiName: string;
  type: 'image' | 'video';
  /**
   * Backend provider that serves this model. Undefined in raw JSON
   * specs is treated as `'minimax'` by `getModelProvider()` (the
   * Leonardo engine has been removed), but every JSON shipped in the
   * repo today sets the field explicitly.
   */
  provider?: ModelSpecProvider;
  endpoint: string;
  parameters: Record<string, unknown>;
  aspectRatios?: Record<string, unknown>;
  capabilities: ModelSpecCapabilities;
  styles?: Record<string, string>;
  rules: string[];
}

const MODEL_SPECS: Record<string, ModelSpec> = {
  'minimax-image-01': minimaxImage01 as unknown as ModelSpec,
};

export function getModelSpec(modelId: string): ModelSpec | undefined {
  return MODEL_SPECS[modelId];
}

export function getAllModelSpecs(): Record<string, ModelSpec> {
  return MODEL_SPECS;
}

/**
 * Resolve the backend provider of a model. Returns `'minimax'` for
 * specs that have no explicit `provider` field — every JSON in the
 * repo today sets it, so the fallback only fires for external spec
 * sources or stale on-disk copies (the Leonardo engine has been
 * removed, so `'minimax'` is the sane default).
 */
export function getModelProvider(modelId: string): ModelSpecProvider {
  return MODEL_SPECS[modelId]?.provider ?? 'minimax';
}

/**
 * Filter specs by provider. Convenience for upcoming P2/P3 work
 * (suggestParameters provider filter, SettingsModal dropdown).
 */
export function getModelSpecsByProvider(
  provider: ModelSpecProvider,
): ModelSpec[] {
  return Object.values(MODEL_SPECS).filter((s) => (s.provider ?? 'minimax') === provider);
}
