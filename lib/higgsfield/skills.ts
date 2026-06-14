/**
 * Higgsfield Skills Loader
 * ========================
 *
 * V1.4.0: Each Higgsfield model maps to a skill from
 * `docs/research/higgsfield-skills/`. The skill content is appended
 * to the prompt enhancement call so the resulting prompts follow
 * the model's optimal structure (SLCT for Nano Banana, MCSLA for
 * video, etc.).
 *
 * Two skills get loaded as full text and appended to the system
 * prompt:
 *
 *   - `cinema-world-builder/SKILL.md` — main Higgsfield skill with
 *     hard rules (HARD RULES pre-delivery checklist), vocabulary,
 *     model selection guidance, named camera presets, MCSLA
 *     structure for video, negative-constraints library. Loaded for
 *     EVERY Higgsfield image generation, regardless of which
 *     specific model is being used.
 *
 *   - `banana-pro-director/SKILL.md` — SLCT framework (Skin · Light
 *     · Capture · Texture) with anti-AI-look directives. Loaded
 *     specifically when the chosen model is `nano_banana_2` or
 *     `nano_banana_flash`.
 *
 * Skills are cached on first read (they're on disk, no need to
 * re-read every cycle).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type HiggsfieldSkillBinding } from '@/lib/image-models'

const SKILLS_DIR = join(process.cwd(), 'docs/research/higgsfield-skills')

const cache = new Map<string, string>()

function loadSkillFile(slug: string, fileName: string): string {
  const key = `${slug}:${fileName}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  try {
    const path = join(SKILLS_DIR, fileName)
    const content = readFileSync(path, 'utf-8')
    cache.set(key, content)
    return content
  } catch {
    // Missing file in a deployed bundle — return empty rather than
    // throwing. The pipeline still works; the skill content just
    // isn't injected.
    cache.set(key, '')
    return ''
  }
}

/**
 * Load the full skill content for a given binding. Always includes
 * `cinema-world-builder` (the main skill). Adds the model-specific
 * skill (e.g. `banana-pro-director` for Nano Banana).
 */
export function loadHiggsfieldSkillContent(binding: HiggsfieldSkillBinding): string {
  const parts: string[] = []
  // Main skill — always
  const main = loadSkillFile('cinema-world-builder', 'cinema-world-builder-SKILL.md')
  if (main) {
    parts.push('# Higgsfield AI — Platform Skill\n' + main)
  }
  // Model-specific
  if (binding.skillName === 'banana-pro-director') {
    const banana = loadSkillFile('banana-pro-director', 'banana-pro-director-SKILL.md')
    if (banana) {
      parts.push('\n# Banana Pro Director — SLCT Framework\n' + banana)
    }
  }
  return parts.join('\n\n')
}

/**
 * The list of skill names that get added to `settings.activeSkills`
 * when the user has `higgsfieldEnabled` set. This makes the skills
 * visible in the Settings → Skills panel and turns them on for
 * every image-generation call.
 */
export function activeSkillNamesForBinding(
  binding: HiggsfieldSkillBinding | undefined,
): string[] {
  if (!binding) return []
  // cinema-world-builder is always on for any Higgsfield model
  return ['cinema-world-builder', binding.skillName]
}
