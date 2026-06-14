import { extractTrademarkNames } from '@/lib/extract-trademark-names';
import { setOutcome } from '@/lib/trademark-outcomes';

/**
 * M3.4-P4-B3: pure moderation helpers lifted out of
 * `hooks/useImageGeneration.ts`. Both functions run on the
 * moderation-error path: `buildModerationRewriteInstruction`
 * constructs the LLM prompt for the rewrite+retry, and
 * `markPromptNamesAllowed` records the names that survived a
 * first-try success so the future substitution engine leaves
 * them alone.
 *
 * Neither function touches React state — they only depend on
 * the trademark-outcome store and the LLM template. Safe to
 * pull into `lib/`.
 *
 * TRADEMARK-SURGICAL-REWRITE (2026-05-21): see the block
 * comment below. The previous instruction over-generalized
 * non-trademarked-but-adjacent names; the new wording keeps the
 * rewrite tight to the actual IP trigger.
 */
export function buildModerationRewriteInstruction(
  failedPrompt: string,
  classifications: string[] = [],
): string {
  const upper = classifications.map((c) => c.toUpperCase());
  const isTrademark = upper.some((c) => c === 'TRADEMARK' || c === 'COPYRIGHT');
  const isContentBlock = upper.some((c) => c === 'NSFW' || c === 'EXTREME_VIOLENCE' || c === 'CHILD');

  if (isTrademark) {
    // TRADEMARK-SURGICAL-REWRITE (2026-05-21): Maurice reported the
    // previous instruction (4bc046b) was destroying prompts. The
    // "drop the named-character anchor" framing + the franchise-example
    // list (e.g. "Black Panther" → "a panther-themed warrior") trained
    // the LLM to over-generalize — it stripped scene/mood/style/
    // composition along with the name, and even non-trademarked-but-
    // adjacent-sounding names (e.g. "Viktor von Doom") got rewritten
    // because the examples taught the model to recognise IP-shaped
    // patterns broadly.
    //
    // New rule: SURGICAL substitution only. Replace ONLY the specific
    // trademark trigger with a brief visual descriptor that preserves
    // the character's distinctive look (colors, silhouette, key props).
    // Every other word — scene, lighting, action, composition, style,
    // mood, location — must survive verbatim. One positive example
    // showing the minimal-edit shape; no franchise list to avoid
    // teaching the model to recognise more names than it should.
    return `This prompt was blocked by content moderation for TRADEMARK / COPYRIGHT — one specific named-IP character triggered it.

CRITICAL RULES (read carefully):
1. Identify which character NAME(S) in the prompt are the likely trademark trigger.
2. Replace ONLY those name(s) with a brief visual descriptor that preserves the character's distinctive look (colors, silhouette, signature props).
3. Every OTHER word in the prompt — scene, mood, composition, lighting, action, location, style, era, time-of-day, camera angle, art style, weather, expressions — MUST be preserved EXACTLY as written. Do not paraphrase, condense, or "improve" them.
4. Do NOT generalize non-trademarked descriptions. If the prompt says "Viktor von Doom" but that's a fictional character not on any trademark list, leave it alone.
5. Do NOT shorten the prompt. The output should have a similar word count to the input, with only the trigger name swapped.

Surgical edit example:
- Input:  "Spider-Man swinging through neon Tokyo at night, cinematic lighting, 35mm film grain, dynamic action pose, low angle"
- Output: "a red and blue spider-themed hero in a web-pattern suit swinging through neon Tokyo at night, cinematic lighting, 35mm film grain, dynamic action pose, low angle"

Notice: only the character name changed. Every other word is identical.

Return ONLY the rewritten prompt — no preamble, no explanation, no list of changes.

BLOCKED PROMPT:
${failedPrompt}

REWRITTEN PROMPT:`;
  }

  if (isContentBlock) {
    return `This prompt was blocked by content moderation (${classifications.join(', ')}). Rewrite it to be cleaner and shorter (40–60 words max). Remove any violence, gore, or explicit language. Keep the character names and core concept. Return ONLY the rewritten prompt.

BLOCKED PROMPT:
${failedPrompt}

REWRITTEN PROMPT:`;
  }

  // Unknown / mixed classification — conservative fallback (pre-fix wording).
  return `This prompt was blocked by content moderation. Rewrite it to be cleaner and shorter (40–60 words max). Remove any violence, gore, or explicit language. Keep the character names and core concept. Return ONLY the rewritten prompt.

BLOCKED PROMPT:
${failedPrompt}

REWRITTEN PROMPT:`;
}

/**
 * SUCCESS-PATH-ALLOWED-MARKING (2026-05-22): when a generation
 * succeeds on first try (no retry), every trademark-list name that
 * appeared in the submitted prompt is recorded as 'allowed' in the
 * outcome store. Future TRADEMARK blocks involving other prompts that
 * happen to contain these names won't auto-substitute them — the
 * substitution path filters to names with outcome 'blocked' only.
 *
 * setOutcome's sticky-blocked guard (lib/trademark-outcomes.ts) means
 * we can never revive a previously-blocked name to 'allowed' by a
 * coincidental success — once a name has reliably failed, the
 * 'allowed' marking is a no-op.
 *
 * Only call on FIRST-TRY successes (the success path before the
 * retry catch). A success that came AFTER a retry doesn't prove the
 * names are allowed — the retry's substitution may have removed them.
 */
export function markPromptNamesAllowed(prompt: string, modelId: string): void {
  const names = extractTrademarkNames(prompt);
  for (const name of names) setOutcome(name, 'allowed', modelId);
}
