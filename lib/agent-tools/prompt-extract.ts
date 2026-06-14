/**
 * V1.7.0-PRE-PROD-FIX: extract the actual image-prompt draft from
 * model output that includes a "commentary" section.
 *
 * Background: reasoning-friendly models (M3, GLM-5.1, DeepSeek-R1) and
 * even vanilla M3 often emit a small report around the actual draft
 * when invoked through `generateText` — the output may look like:
 *
 *   The checker is strict about literal keyword matches. Let me
 *   build a final draft that explicitly weaves in the niche vocabulary
 *   and required anti-AI-look tokens.
 *
 *   Final prompt (copy-paste ready):
 *   A weathered Mandalorian bounty hunter in a smoke-filled Coruscant
 *   cantina, single light source, cinematic. Aspect ratio 2:3, MEDIUM.
 *
 *   Niches anchored. Ready to feed to generate_image — just say the
 *   word.
 *
 * The previous `cleanModelOutput` only stripped `<think>` blocks and
 * markdown fences, so this commentary leaked verbatim into the image
 * prompt and the image model produced off-topic output. This helper
 * pulls out just the prompt body using a layered heuristic:
 *
 *   1. Look for explicit "here is the prompt" markers first.
 *   2. Otherwise pick the longest non-empty paragraph that looks like
 *      a prompt (>= 40 chars, has image-y vocabulary, no "I" / "let me"
 *      / "the checker" commentary tells).
 *   3. Otherwise fall back to the last non-empty paragraph (best-effort).
 *
 * Shared by:
 *   - `lib/agent-tools/generate-prompt.ts` `cleanModelOutput`
 *   - `lib/agent-loop/index.ts` `stripDirectorReasoning` fallback
 *
 * Exported as both `extractDraftFromCommentary` (full pipeline) and
 * `stripModelCommentary` (alias used by callers).
 */

// Markers the model commonly uses to signal "the prompt starts here".
// Each regex matches a marker like "Final prompt:" (the part BEFORE
// the draft body) and uses a capture group so the caller can split
// at the boundary. We do NOT match "Prompt:" alone because the
// system-prompt already contains that phrase.
const DRAFT_MARKERS: readonly RegExp[] = [
  // "Final prompt:" / "Final prompt (copy-paste ready):" / "Final prompt\n"
  /^\s*(final\s+prompt(?:\s*\([^)]*?\))?:?)\s*/im,
  // "Final draft:" / "Final draft\n"
  /^\s*(final\s+draft:?\s*)/im,
  // "Here's the prompt:" / "Here is the final prompt:" / "Here's the prompt\n"
  /^\s*(here(?:'s| is)\s+(?:the\s+)?(?:final\s+)?prompt:?\s*)/im,
  // "Image prompt:" / "Image prompt\n"
  /^\s*(image\s+prompt:?\s*)/im,
  // "Draft:" / "Draft\n"
  /^\s*(draft:?\s*)/im,
];

// Commentar-y tells. If a line is mostly made of these, it's almost
// certainly the model talking ABOUT the prompt rather than the prompt
// itself.
const COMMENTARY_PATTERNS: readonly RegExp[] = [
  /\blet me\b/i,
  /\bthe checker\b/i,
  /\bi'?ll\b/i,
  /\bi should\b/i,
  /\bhere'?s why\b/i,
  /\bready to feed\b/i,
  /\bniches? anchored\b/i,
  /\biteration\s+\d+\b/i,
  /\bbuild a\b/i,
  /\bdraft that\b/i,
];

/**
 * Image-prompt vocabulary heuristics. A line that contains at least
 * one of these is much more likely to BE a prompt than to be commentary
 * about one. Not perfect, but cheap and surprisingly effective on
 * the M3 family.
 */
const PROMPT_VOCAB: readonly RegExp[] = [
  // Visual descriptors
  /\b(soft|hard|cinematic|dramatic|warm|cool|harsh|muted|vibrant|pastel|monochrome|sepia)\b/i,
  // Camera / framing
  /\b(close[-\s]?up|wide[-\s]?angle|low angle|high angle|portrait|landscape|headshot|full[-\s]?body|macro|telephoto|wide[-\s]?shot)\b/i,
  // Lighting
  /\b(rim\s*light|back[-\s]?light|side[-\s]?light|golden hour|blue hour|overcast|neon|volumetric\s*light|diffused|hard light)\b/i,
  // Environment / context
  /\b(corridor|street|alley|forest|desert|cafe|office|studio|skyline|horizon|sky|cloud|fog|rain|smoke)\b/i,
  // Subject
  /\b(figure|character|warrior|robot|cyborg|child|elderly|man|woman|person)\b/i,
  // Composition / aspect
  /\b(aspect\s*ratio|portrait orientation|landscape orientation|composition)\b/i,
];

interface ExtractResult {
  /** The extracted draft text. Empty string when nothing could be found. */
  draft: string;
  /** True if a marker was matched, false if we fell back to heuristic. */
  matchedMarker: boolean;
  /** How the draft was extracted — for diagnostics / future-proofing. */
  source: 'marker' | 'paragraph-heuristic' | 'last-paragraph' | 'fallback' | 'rejected-commentary';
}

/**
 * V1.8.1-COMMENTARY-LEAK: a candidate draft is "commentary-only" when it
 * has at least one commentary tell AND zero image-prompt vocabulary. The
 * v1.7.0 extractor handled commentary that WRAPS a real prompt body, but
 * when the model emits ONLY commentary and no draft at all (Maurice's
 * "The checker is strict… Let me build a final draft…" with nothing
 * after it), the last-paragraph fallback returned that commentary
 * verbatim — and it sailed into the image model.
 *
 * The conjunction is deliberately conservative: a clean short prompt
 * ("Darth Vader in an Iron Man suit") has no commentary tell, so it is
 * NEVER rejected. Only text that openly narrates ABOUT the prompt (and
 * carries no visual vocabulary to redeem it) is dropped — at which point
 * the caller's empty-draft path (`generate_prompt`'s min(40) schema /
 * the agent-loop fallback / the pipeline's plausibility gate) correctly
 * falls back to the verbatim concept instead of generating garbage.
 */
export function isCommentaryOnly(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  const hasCommentaryTell = COMMENTARY_PATTERNS.some((p) => p.test(text));
  if (!hasCommentaryTell) return false;
  const hasPromptVocab = PROMPT_VOCAB.some((re) => re.test(text));
  return !hasPromptVocab;
}

/**
 * Pull the draft text out of a model output that may contain commentary.
 *
 * Returns `{ draft, matchedMarker, source }` so callers can log when the
 * extraction had to fall back to heuristics (and thus the prompt may
 * need a manual review).
 */
export function extractDraftFromCommentary(raw: string): ExtractResult {
  if (!raw) {
    return { draft: '', matchedMarker: false, source: 'fallback' };
  }

  // 0. Defensive: callers that skipped the <think>-strip step (or that
  //    have a leading <think> with no closing tag) should still get a
  //    sensible result. We do NOT call back into cleanModelOutput to
  //    avoid an import cycle, but we strip terminated <think> blocks
  //    and drop everything before an unterminated <think>.
  let text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const openIdx = text.indexOf('<think>');
  if (openIdx !== -1 && !text.slice(openIdx).includes('</think>')) {
    text = text.slice(0, openIdx);
  }

  // 1. Look for an explicit marker. Everything AFTER the marker is the
  //    candidate draft. We keep stripping commentary lines from the
  //    top until we find prompt-like content.
  for (const marker of DRAFT_MARKERS) {
    const match = text.match(marker);
    if (!match || match.index === undefined) continue;
    // The marker regex captures just the marker prefix (group 1);
    // the rest of the line is part of the draft body, not the marker.
    const markerText = match[1] ?? match[0];
    const after = text.slice(match.index + markerText.length).trim();
    if (after.length === 0) continue;

    // The model sometimes continues with a short commentary line right
    // after the marker ("prompt follows"). Trim those off.
    const trimmed = trimCommentaryPrefix(after);
    // Also trim trailing commentary the model appends AFTER the
    // prompt body ("Niches anchored. Ready to feed to generate_image
    // — just say the word.").
    const finalDraft = trimCommentarySuffix(trimmed);
    // V1.8.1: a marker followed by pure commentary (no real body) must
    // not be handed off — fall through to the heuristic / give-up path.
    if (finalDraft.length >= 40 && !isCommentaryOnly(finalDraft)) {
      return { draft: finalDraft, matchedMarker: true, source: 'marker' };
    }
  }

  // 2. No marker matched. Split into paragraphs (blank-line or
  //    single-newline separated) and pick the best candidate.
  const paragraphs = raw
    .split(/\n\s*\n+|\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paragraphs.length === 0) {
    return { draft: raw.trim(), matchedMarker: false, source: 'fallback' };
  }

  // Score each paragraph. Best score wins.
  const scored = paragraphs.map((p) => ({
    text: p,
    score: scoreParagraph(p),
  }));
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best.score > 0 && best.text.length >= 40) {
    return {
      draft: trimCommentarySuffix(best.text),
      matchedMarker: false,
      source: 'paragraph-heuristic',
    };
  }

  // 3. Last-resort: last paragraph (often the prompt when the model
  //    leads with the commentary).
  const last = trimCommentarySuffix(paragraphs[paragraphs.length - 1]);
  // V1.8.1-COMMENTARY-LEAK: if even the last paragraph is pure
  // commentary, GIVE UP — return empty so the caller falls back to the
  // verbatim concept rather than feeding the model's musings to the
  // image generator (the credit-burning "random not-fitting images"
  // Maurice reported). The previous code returned this verbatim.
  if (isCommentaryOnly(last)) {
    return { draft: '', matchedMarker: false, source: 'rejected-commentary' };
  }
  return {
    draft: last,
    matchedMarker: false,
    source: 'last-paragraph',
  };
}

/**
 * Convenience wrapper: returns just the draft string. Kept as the
 * single import the rest of the codebase needs.
 */
export function stripModelCommentary(raw: string): string {
  return extractDraftFromCommentary(raw).draft;
}

/**
 * Strip trailing commentary appended to a prompt (e.g. "Ready to
 * feed to generate_image — just say the word"). Defensive: if the
 * whole string reads like commentary, we return it as-is (caller's
 * fallback will pick it up).
 */
export function trimCommentarySuffix(draft: string): string {
  // Split on the first line that smells like commentary.
  const lines = draft.split(/\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (kept.length === 0) {
      kept.push(line);
      continue;
    }
    if (COMMENTARY_PATTERNS.some((p) => p.test(line))) break;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

function trimCommentaryPrefix(text: string): string {
  const lines = text.split(/\n/);
  let startIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) {
      startIdx = i + 1;
      continue;
    }
    // If the line is clearly commentary, skip it. Otherwise stop.
    if (COMMENTARY_PATTERNS.some((p) => p.test(line))) {
      startIdx = i + 1;
      continue;
    }
    break;
  }
  return lines.slice(startIdx).join('\n').trim();
}

function scoreParagraph(p: string): number {
  if (p.length < 40) return -1; // too short to be a real prompt
  if (p.length > 2000) return -1; // safety: an extracted prompt shouldn't be longer than 2000 chars

  let score = 0;

  // Image-prompt vocabulary presence — REQUIRED. A paragraph that
  // matches zero of our prompt-y vocabulary is almost certainly not a
  // prompt at all; length alone is too noisy a signal. Each match
  // adds 2 points.
  for (const re of PROMPT_VOCAB) {
    if (re.test(p)) score += 2;
  }

  // No vocabulary at all → fall through to last-paragraph in the
  // caller. Return -1 so the caller skips this candidate.
  if (score === 0) return -1;

  // Length sweet spot: 80-400 chars is most image-prompt-y. These
  // are bonus points; the vocabulary match above is the gate.
  if (p.length >= 80 && p.length <= 400) score += 3;
  else if (p.length >= 40 && p.length <= 600) score += 1;

  // Commentary tells: penalize.
  for (const re of COMMENTARY_PATTERNS) {
    if (re.test(p)) score -= 3;
  }

  // First-person pronoun heavy: probably commentary.
  const firstPerson = (p.match(/\b(I|i)\b/g) || []).length;
  if (firstPerson > 2) score -= 2;

  return score;
}
