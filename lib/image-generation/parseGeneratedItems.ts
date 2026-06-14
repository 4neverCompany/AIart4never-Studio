import { extractJsonArrayFromLLM } from '@/lib/aiClient';
import { getImageModel } from '@/lib/image-models';
import { isCameraAngleId } from '@/lib/camera-angles';

/**
 * M3.4-P4-B3: pure parsing helpers lifted out of
 * `hooks/useImageGeneration.ts` so the hook only has to manage React
 * state + provider dispatch. None of these depend on `useState`,
 * `useEffect`, or any React primitive — they're plain string
 * transformation that survives being moved into `lib/`.
 *
 * The functions are re-exported through
 * `hooks/useImageGeneration.ts` so every existing importer
 * (Vitest unit tests for `parseGeneratedItems`, the M2.1 camera-
 * angle catalog) keeps working unchanged.
 */

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

export function getModelName(id: string): string {
  return getImageModel(id)?.name || id;
}

export function pickStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strs = value.filter((v): v is string => typeof v === 'string');
  return strs.length > 0 ? strs : undefined;
}

// V1.7.0-M2.1: exported for unit tests (per-item cameraAngle validation).
export function parseGeneratedItems(raw: string): GeneratedItem[] {
  return extractJsonArrayFromLLM(raw)
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      prompt: typeof item.prompt === 'string' ? item.prompt : '',
      aspectRatio: typeof item.aspectRatio === 'string' ? item.aspectRatio : undefined,
      tags: pickStringArray(item.tags),
      selectedNiches: pickStringArray(item.selectedNiches),
      selectedGenres: pickStringArray(item.selectedGenres),
      negativePrompt: typeof item.negativePrompt === 'string' ? item.negativePrompt : undefined,
      // V1.7.0-M2.1: only accept a catalog slug; anything else (model
      // hallucinated a label, free text, etc.) is dropped so the composer
      // never sees an unresolvable angle.
      cameraAngle: isCameraAngleId(item.cameraAngle) ? item.cameraAngle : undefined,
    }))
    .filter((item) => item.prompt.length > 0);
}
