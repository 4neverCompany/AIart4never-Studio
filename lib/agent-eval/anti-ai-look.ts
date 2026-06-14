/**
 * v1.2.3 — Eval heuristic: anti-AI-look negatives.
 *
 * Detects whether the prompt includes negative-prompt keywords
 * that filter out the telltale signs of AI image generation
 * (extra fingers, asymmetric eyes, mushy textures). The model's
 * `prompt_enhance` toggle in the Settings UI controls whether
 * the loop appends these; this heuristic verifies that
 * appending actually happened.
 *
 * Keyword set is conservative — the MashupForge MCSLA director
 * protocol has a documented list in `lib/ai/skills/anti-ai-look.md`
 * (not yet extracted to a constant here). v1.3 will import
 * from there; v1.2.3 hardcodes a small starter set.
 *
 * Pure function, no IO. Snapshot-tested in `aggregate.test.ts`.
 */

const NEGATIVE_KEYWORDS = [
  'extra fingers',
  'six fingers',
  'asymmetric eyes',
  'deformed',
  'malformed',
  'blurry',
  'low quality',
  'jpeg artifacts',
  'oversaturated',
  'watermark',
  'signature',
  'text',
  'logo',
  'mushy',
  'plastic skin',
  'uncanny valley',
  'smooth skin',
  'airbrushed',
  'render artifacts',
  'gaussian noise',
  'overexposed',
  'underexposed',
  'fused fingers',
  'bad anatomy',
  'bad hands',
  'mutation',
  'disfigured',
  'poorly drawn',
  'out of frame',
] as const;

export interface AntiAiLookResult {
  /** 0..1; higher = more negative keywords present. Cap at 1.0 when 4+ found. */
  score: number;
  /** True if the prompt contains at least one negative keyword. */
  hasNegatives: boolean;
  /** The matched negative keywords (for the Replay UI badge). */
  matches: string[];
}

export function evalAntiAiLook(prompt: string): AntiAiLookResult {
  const lowered = prompt.toLowerCase();
  const matches: string[] = [];
  for (const kw of NEGATIVE_KEYWORDS) {
    if (lowered.includes(kw)) {
      matches.push(kw);
    }
  }
  // Cap at 1.0 when 4+ matches. Most prompts have 1-2
  // common negatives ("blurry", "low quality"); 4+ signals
  // a fully-anti-ai-tuned prompt.
  const score = Math.min(1, matches.length / 4);
  return { score, hasNegatives: matches.length > 0, matches };
}
