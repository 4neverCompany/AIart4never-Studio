'use server';

/**
 * Server Action for loading Higgsfield skill content.
 *
 * `lib/higgsfield/skills.ts` reads the skill markdown files from disk
 * with `node:fs` — server-only. The Studio's ManualGenerationPanel is
 * a client component, so importing the loader directly pulls `node:fs`
 * into the client bundle and Turbopack fails the build (same class of
 * bug as the v1.3.1 virality fix — see lib/actions/virality.ts).
 */

import { loadHiggsfieldSkillContent } from '@/lib/higgsfield/skills';
import { getImageModel } from '@/lib/image-models';

/**
 * Resolve the skill binding for a unified Higgsfield model id (e.g.
 * `higgsfield:nano_banana_2`) and return the full skill content, or
 * `''` when the model has no binding / the files are missing.
 */
export async function loadSkillContentForModel(unifiedModelId: string): Promise<string> {
  try {
    const model = getImageModel(unifiedModelId);
    if (!model?.skillBinding) return '';
    return loadHiggsfieldSkillContent(model.skillBinding);
  } catch {
    // Non-fatal — callers proceed with the raw prompt.
    return '';
  }
}
