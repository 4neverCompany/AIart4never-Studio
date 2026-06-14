/**
 * V1.7.0-PRE-PROD-FIX: tests for `extractDraftFromCommentary` and
 * `trimCommentarySuffix`. The previous `cleanModelOutput` only
 * stripped <think> blocks and markdown fences, so the model's
 * commentary around the actual prompt leaked into the image prompt
 * verbatim. See lib/agent-tools/prompt-extract.ts for the helper.
 *
 * We test the helper directly (not through the Vercel AI SDK) so
 * each case is fast and the failure messages are precise.
 */
import { describe, it, expect } from 'vitest';
import {
  extractDraftFromCommentary,
  isCommentaryOnly,
  stripModelCommentary,
  trimCommentarySuffix,
} from '@/lib/agent-tools/prompt-extract';

describe('extractDraftFromCommentary — marker-based', () => {
  it('extracts the draft after "Final prompt (copy-paste ready):"', () => {
    const raw = `The checker is strict about literal keyword matches. Let me build a final draft that explicitly weaves in the niche vocabulary and required anti-AI-look tokens.

Final prompt (copy-paste ready):
A weathered Mandalorian bounty hunter in a smoke-filled Coruscant cantina, single light source, cinematic. Aspect ratio 2:3, quality MEDIUM.

Niches anchored. Ready to feed to generate_image — just say the word.`;

    const { draft, matchedMarker, source } = extractDraftFromCommentary(raw);
    expect(matchedMarker).toBe(true);
    expect(source).toBe('marker');
    expect(draft).toContain('Mandalorian bounty hunter');
    expect(draft).not.toContain('checker is strict');
    expect(draft).not.toContain('Niches anchored');
    expect(draft).not.toContain('just say the word');
  });

  it('extracts the draft after "Final draft:"', () => {
    const raw = `Some preamble.

Final draft: A neon-lit cyberpunk alley at midnight, rain-slicked cobblestones, lone figure in a long coat, low angle, cinematic.`;

    const { draft, matchedMarker } = extractDraftFromCommentary(raw);
    expect(matchedMarker).toBe(true);
    expect(draft).toContain('neon-lit cyberpunk alley');
    expect(draft).not.toContain('Some preamble');
  });

  it('extracts the draft after "Here\'s the prompt:"', () => {
    const raw = `Let me think about this.

Here's the prompt: A vast desert landscape at golden hour, lone wanderer on a dune ridge, warm cinematic light, widescreen composition.`;

    const { draft, matchedMarker } = extractDraftFromCommentary(raw);
    expect(matchedMarker).toBe(true);
    expect(draft).toContain('vast desert landscape');
  });

  it('extracts the draft after "Image prompt:"', () => {
    const raw = `Building the draft now.

Image prompt: Close-up portrait of an elderly fisherman, weathered face, salt-encrusted hat, soft side light, shallow depth of field.`;

    const { draft, matchedMarker } = extractDraftFromCommentary(raw);
    expect(matchedMarker).toBe(true);
    expect(draft).toContain('weathered face');
  });

  it('handles the marker on a line with trailing punctuation', () => {
    const raw = `Final prompt:
A misty forest path at dawn, volumetric light streaming through trees, lone figure in a cloak, cinematic, muted palette.`;

    const { draft, matchedMarker } = extractDraftFromCommentary(raw);
    expect(matchedMarker).toBe(true);
    expect(draft.startsWith('A misty forest path')).toBe(true);
  });
});

describe('extractDraftFromCommentary — paragraph heuristic (no marker)', () => {
  it('picks the prompt-like paragraph when commentary surrounds it', () => {
    const raw = `Let me build a final draft that explicitly weaves in the niche vocabulary.

A weathered Mandalorian bounty hunter in a smoke-filled Coruscant cantina, single light source, cinematic. Aspect ratio 2:3.

Niches anchored. Ready to feed to generate_image — just say the word.`;

    const { draft, source, matchedMarker } = extractDraftFromCommentary(raw);
    expect(matchedMarker).toBe(false);
    expect(source).toBe('paragraph-heuristic');
    expect(draft).toContain('Mandalorian bounty hunter');
    expect(draft).not.toContain('checker is strict');
    expect(draft).not.toContain('Niches anchored');
  });

  it('ranks image-prompt vocabulary higher than commentary', () => {
    const raw = `Some setup text that doesn't matter.

The prompt should have cinematic lighting and a dramatic low angle.

Close-up of a samurai in full armor, dramatic rim light, dark background, portrait composition.

And the final sign-off line.`;

    const { draft, source } = extractDraftFromCommentary(raw);
    expect(source).toBe('paragraph-heuristic');
    expect(draft).toContain('samurai in full armor');
  });

  it('falls back to the last paragraph when no paragraph scores positive', () => {
    // No image-prompt vocabulary, no commentary tells — only the
    // last paragraph has any text that could plausibly be a prompt.
    const raw = `First paragraph of nothing in particular.

Second paragraph that is also nothing.

The last paragraph of something.`;

    const { draft, source } = extractDraftFromCommentary(raw);
    expect(source).toBe('last-paragraph');
    expect(draft).toBe('The last paragraph of something.');
  });
});

describe('extractDraftFromCommentary — edge cases', () => {
  it('returns empty string for empty input', () => {
    const { draft, source } = extractDraftFromCommentary('');
    expect(draft).toBe('');
    expect(source).toBe('fallback');
  });

  it('returns the raw text for plain text without commentary', () => {
    const raw = 'A simple image prompt with no preamble or sign-off.';
    const { draft, matchedMarker, source } = extractDraftFromCommentary(raw);
    // No marker matched, no paragraph scored positively (too short
    // and lacks vocabulary) → fall back to last-paragraph.
    expect(matchedMarker).toBe(false);
    expect(source).toBe('last-paragraph');
    expect(draft).toBe(raw);
  });

  it('strips a leading <think> block before extracting', () => {
    // The caller (cleanModelOutput) is expected to strip think blocks
    // first, but verify our helper is robust if that didn't happen.
    const raw = `<think>thinking about the prompt carefully</think>

Final prompt: A dramatic mountain vista at sunrise, jagged peaks catching first light, vast valley below, cinematic widescreen.`;

    const { draft, matchedMarker } = extractDraftFromCommentary(raw);
    expect(matchedMarker).toBe(true);
    expect(draft).toContain('mountain vista');
  });

  it('rejects drafts that are too short to be valid prompts', () => {
    const raw = `Final prompt: too short`;
    const { draft, matchedMarker } = extractDraftFromCommentary(raw);
    // Marker matched but the post-marker content is < 40 chars, so
    // we fall through to paragraph heuristic / fallback.
    expect(matchedMarker).toBe(false);
  });
});

describe('extractDraftFromCommentary — V1.8.1 all-commentary give-up', () => {
  // Maurice 2026-06-13: the WHOLE thinking process landed in the image
  // prompt and generated random off-topic images. The v1.7.0 extractor
  // handled commentary WRAPPING a prompt, but pure-commentary-with-no-
  // draft fell through to last-paragraph and was returned verbatim.
  it("gives up (empty) on Maurice's exact all-commentary example", () => {
    const raw =
      'The checker is strict about literal keyword matches. Let me build a final draft that explicitly weaves in the niche vocabulary and required anti-AI-look tokens.';
    const { draft, source } = extractDraftFromCommentary(raw);
    expect(draft).toBe('');
    expect(source).toBe('rejected-commentary');
  });

  it('gives up on a sign-off-only output', () => {
    const raw = 'Let me think. Niches anchored, ready to feed to generate_image — just say the word.';
    const { draft, source } = extractDraftFromCommentary(raw);
    expect(draft).toBe('');
    expect(source).toBe('rejected-commentary');
  });

  it('does NOT give up on a marker followed by a real body', () => {
    const raw =
      'The checker is strict. Let me build a final draft.\n\nFinal prompt: A weathered Mandalorian in a smoke-filled cantina, single warm light source, cinematic close-up.';
    const { draft } = extractDraftFromCommentary(raw);
    expect(draft).toContain('Mandalorian');
    expect(draft).not.toContain('the checker');
  });

  it('does NOT reject a clean short prompt that lacks commentary tells', () => {
    const raw = 'Darth Vader in an Iron Man suit, dramatic neon backlight.';
    const { draft } = extractDraftFromCommentary(raw);
    expect(draft).toBe(raw);
  });
});

describe('isCommentaryOnly', () => {
  it('flags commentary with no visual vocabulary', () => {
    expect(isCommentaryOnly('Let me build a final draft that weaves in the niche.')).toBe(true);
    expect(isCommentaryOnly('The checker is strict about keyword matches.')).toBe(true);
  });
  it('spares text with image-prompt vocabulary even if it has a tell', () => {
    // "let me" tell, but "cinematic"/"close-up" vocab redeems it.
    expect(isCommentaryOnly('Let me show a cinematic close-up of a warrior.')).toBe(false);
  });
  it('spares clean prompts and empty input', () => {
    expect(isCommentaryOnly('A dramatic mountain vista, golden hour.')).toBe(false);
    expect(isCommentaryOnly('')).toBe(false);
  });
});

describe('stripModelCommentary — convenience wrapper', () => {
  it('returns just the draft string', () => {
    const raw = `Some preamble.

Final prompt: A cinematic wide shot of a misty harbor at dawn, fishing boats, soft golden light, muted palette.`;

    const draft = stripModelCommentary(raw);
    expect(draft).toContain('misty harbor');
    expect(draft).not.toContain('preamble');
  });
});

describe('trimCommentarySuffix', () => {
  it('trims trailing "Ready to feed" sign-off', () => {
    const draft = `A dramatic cinematic wide shot of a misty harbor, soft golden light, muted palette.

Ready to feed to generate_image — just say the word.`;
    const trimmed = trimCommentarySuffix(draft);
    expect(trimmed).toContain('misty harbor');
    expect(trimmed).not.toContain('just say the word');
  });

  it('trims trailing "Niches anchored" commentary', () => {
    const draft = `Close-up of an elderly fisherman, weathered face, side light, muted palette.

Niches anchored. Style tags verified.`;
    const trimmed = trimCommentarySuffix(draft);
    expect(trimmed).toContain('elderly fisherman');
    expect(trimmed).not.toContain('Style tags verified');
  });

  it('leaves a clean prompt alone', () => {
    const draft = 'A simple image prompt, no commentary.';
    expect(trimCommentarySuffix(draft)).toBe(draft);
  });
});
