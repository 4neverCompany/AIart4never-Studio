/**
 * Back-compat shim for the pre-v082 model spec module.
 *
 * The real implementation moved to `lib/text-model-catalog.ts` so the
 * catalog is the single source of truth for model metadata (family,
 * generation, context window, default temperature, recommended use)
 * and the picker UI consumes it directly. The original
 * `TEXT_MODEL_SPECS` map + `getTextModelSpec` + `getTextModelSpecsByProvider`
 * are preserved here as a thin re-export layer for code that hasn't
 * been updated yet.
 *
 * V082 — keep these names working so the existing
 * `tests/lib/text-model-specs.test.ts` doesn't need a rewrite.
 * New code should import from `lib/text-model-catalog.ts` directly.
 */

import type { ModelSpecProvider } from './model-specs';
import {
  TEXT_MODEL_CATALOG,
  getTextModelCatalogEntry as catalogEntry,
  getAllTextCatalogEntries,
  getTextCatalogByProvider as catalogByProvider,
  getTextModelParams as catalogParams,
  resolveTextModel,
  type TextAiMode,
  type TextGenParams,
  type TextModelCatalogEntry,
} from './text-model-catalog';

/** @deprecated Use `TextAiMode` from `./text-model-catalog` directly. */
export type { TextAiMode, TextGenParams };

/** @deprecated Use `TextModelCatalogEntry` from `./text-model-catalog` directly. */
export interface TextModelSpec extends TextModelCatalogEntry {}

/** @deprecated Use `TEXT_MODEL_CATALOG` from `./text-model-catalog` directly. */
export const TEXT_MODEL_SPECS: Record<string, TextModelCatalogEntry> =
  Object.fromEntries(
    TEXT_MODEL_CATALOG.map((m) => [m.modelId, m]),
  );

/** @deprecated Use `getTextModelCatalogEntry` from `./text-model-catalog` directly. */
export function getTextModelSpec(
  modelId: string,
): TextModelCatalogEntry | undefined {
  return catalogEntry(modelId);
}

/** @deprecated Use `getTextModelParams` from `./text-model-catalog` directly. */
export function getTextModelParams(
  modelId: string,
  mode?: TextAiMode | string,
): TextGenParams {
  return catalogParams(modelId, mode);
}

/** @deprecated Use `getAllTextCatalogEntries` from `./text-model-catalog` directly. */
export function getAllTextModelSpecs(): TextModelCatalogEntry[] {
  return [...getAllTextCatalogEntries()];
}

/** @deprecated Use `getTextCatalogByProvider` from `./text-model-catalog` directly. */
export function getTextModelSpecsByProvider(
  provider: ModelSpecProvider,
): TextModelCatalogEntry[] {
  return [...catalogByProvider(provider)];
}

/**
 * @deprecated Use `resolveTextModel` from `./text-model-catalog` directly.
 * Kept for any direct `text-model-specs.resolveTextModel` callers; not
 * part of the original public API but added defensively in case any
 * out-of-tree code reaches for it.
 */
export { resolveTextModel };
