/**
 * Structured model specs. One JSON file per model describing its full
 * API surface: allowed parameters, capabilities (what it can / cannot
 * do), style palette with UUIDs, aspect-ratio → dimension table, and
 * hard rules. pi.dev reads these to pick per-model parameters rather
 * than the legacy free-text API-doc blobs.
 */

import gptImage15 from './gpt-image-1.5.json';
import gptImage2 from './gpt-image-2.json';
import nanoBanana2 from './nano-banana-2.json';
import nanoBananaPro from './nano-banana-pro.json';
import minimaxImage01 from './minimax-image-01.json';
import kling30 from './kling-3.0.json';
import klingO3 from './kling-o3.json';
import veo31 from './veo-3.1.json';
import seedance20 from './seedance-2.0.json';
// HIGGSFIELD-INTEGRATION: provider='higgsfield' specs route through
// /api/higgsfield/image (MCP tool: higgsfield_generate). Each spec
// declares only the parameters the underlying model accepts — see
// the per-spec `rules` arrays for what to NOT pass.
import higgsfieldNanoBananaPro from './higgsfield-nano-banana-pro.json';
import higgsfieldSeedance20 from './higgsfield-seedance-2-0.json';
import higgsfieldFlux2 from './higgsfield-flux-2.json';
import higgsfieldGptImage2 from './higgsfield-gpt-image-2.json';

/**
 * Backend provider that serves a model. Drives provider-aware
 * filtering in `suggestParameters` (P2) and UI dropdowns (P3) — see
 * `docs/bmad/briefs/PROV-AGNOSTIC-PARAMS.md`. `'leonardo'` is the
 * historical default for every image/video spec shipped before
 * MXIMG-001; `'minimax'` is the first non-Leonardo image provider
 * (image-01 endpoint).
 *
 * HIGGSFIELD-INTEGRATION: `'higgsfield'` is the second multi-tenant
 * image provider. Each user authenticates via OAuth against
 * `https://mcp.higgsfield.ai/mcp`; the `higgsfield_image` /
 * `higgsfield_video` API routes forward calls to the
 * `higgsfield_generate` MCP tool with model slugs from
 * `lib/higgsfield/models.ts`.
 */
export type ModelSpecProvider =
  | 'leonardo'
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
   * specs created before MXIMG-001 is treated as `'leonardo'` by
   * `getModelProvider()` for back-compat, but every JSON shipped in
   * the repo today sets the field explicitly.
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
  'gpt-image-1.5': gptImage15 as unknown as ModelSpec,
  'gpt-image-2': gptImage2 as unknown as ModelSpec,
  'nano-banana-2': nanoBanana2 as unknown as ModelSpec,
  'nano-banana-pro': nanoBananaPro as unknown as ModelSpec,
  'minimax-image-01': minimaxImage01 as unknown as ModelSpec,
  'kling-3.0': kling30 as unknown as ModelSpec,
  'kling-o3': klingO3 as unknown as ModelSpec,
  'veo-3.1': veo31 as unknown as ModelSpec,
  'seedance-2.0': seedance20 as unknown as ModelSpec,
  // HIGGSFIELD-INTEGRATION: 4 surface-level Higgsfield models. The
  // full 35-model catalog lives in lib/higgsfield/models.ts; this
  // subset is what the Studio picker exposes. Power users can call
  // the other 31 models via the @higgsfield/cli or by passing a raw
  // `apiName` slug in the /api/higgsfield/image call directly.
  'higgsfield-nano-banana-pro': higgsfieldNanoBananaPro as unknown as ModelSpec,
  'higgsfield-seedance-2-0': higgsfieldSeedance20 as unknown as ModelSpec,
  'higgsfield-flux-2': higgsfieldFlux2 as unknown as ModelSpec,
  'higgsfield-gpt-image-2': higgsfieldGptImage2 as unknown as ModelSpec,
};

export function getModelSpec(modelId: string): ModelSpec | undefined {
  return MODEL_SPECS[modelId];
}

export function getAllModelSpecs(): Record<string, ModelSpec> {
  return MODEL_SPECS;
}

/**
 * Resolve the backend provider of a model. Returns `'leonardo'` for
 * specs that predate MXIMG-001 and have no explicit `provider` field
 * — every JSON in the repo today sets it, so the fallback only fires
 * for external spec sources or stale on-disk copies.
 */
export function getModelProvider(modelId: string): ModelSpecProvider {
  return MODEL_SPECS[modelId]?.provider ?? 'leonardo';
}

/**
 * Filter specs by provider. Convenience for upcoming P2/P3 work
 * (suggestParameters provider filter, SettingsModal dropdown).
 */
export function getModelSpecsByProvider(
  provider: ModelSpecProvider,
): ModelSpec[] {
  return Object.values(MODEL_SPECS).filter((s) => (s.provider ?? 'leonardo') === provider);
}
