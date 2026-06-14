// TRADEMARK-SELF-HEAL (2026-05-21): Regression tests for the
// classification-aware moderation rewrite prompt. The pre-fix version
// always told the AI to "Keep the character names and core concept",
// guaranteeing TRADEMARK retries also failed. These tests pin the new
// behaviour so a future refactor doesn't quietly drop it.

import { describe, it, expect } from 'vitest';
import { buildModerationRewriteInstruction } from '@/hooks/useImageGeneration';

describe('buildModerationRewriteInstruction', () => {
  describe('TRADEMARK classification', () => {
    it('instructs the AI to replace ONLY the trademark name with a visual descriptor', () => {
      const out = buildModerationRewriteInstruction(
        'Jeff the Land Shark as Spider-Man wearing a red-and-blue suit',
        ['TRADEMARK'],
      );
      // TRADEMARK-SURGICAL-REWRITE (2026-05-21): instruction must
      // emphasize ONLY-the-name substitution and explicit preservation
      // of everything else. Previously the wording was "drop the named-
      // character anchor" which trained the LLM to over-generalize.
      expect(out).toMatch(/ONLY/);
      expect(out).toMatch(/replace/i);
      expect(out).toMatch(/preserve.*EXACTLY|preserved.*EXACTLY/);
      expect(out).toMatch(/visual descriptor/i);
      // Critical inverse: the trademark path MUST NOT tell the AI to
      // keep ALL names — that was the bug.
      expect(out).not.toMatch(/keep the character names/i);
      // Critical inverse: must NOT tell the AI to drop the anchor —
      // that framing taught it to over-rewrite.
      expect(out).not.toMatch(/drop the named-character anchor/i);
      // Critical inverse: must NOT carry a lossy franchise example list.
      // The pre-fix wording listed "Black Panther → a panther-themed
      // warrior" style examples which the LLM mimicked too aggressively.
      expect(out).not.toMatch(/Black Panther.*panther-themed warrior/);
      expect(out).not.toMatch(/Captain America.*patriotic shield-bearing/);
    });

    it('also handles COPYRIGHT classification with the same surgical instruction', () => {
      const out = buildModerationRewriteInstruction('test prompt', ['COPYRIGHT']);
      expect(out).toMatch(/ONLY/);
      expect(out).toMatch(/replace/i);
      expect(out).not.toMatch(/keep the character names/i);
    });

    it('treats classifications case-insensitively', () => {
      const out = buildModerationRewriteInstruction('test', ['trademark']);
      expect(out).toMatch(/ONLY/);
      expect(out).toMatch(/replace/i);
    });

    it('takes the TRADEMARK path when mixed with other classifications', () => {
      // Real Leonardo responses sometimes carry multiple classes —
      // TRADEMARK + NSFW for example. Trademark is the harder block
      // (renaming would clear NSFW too via shorter cleaner prompt), so
      // we let trademark win the routing.
      const out = buildModerationRewriteInstruction('test', ['NSFW', 'TRADEMARK']);
      expect(out).toMatch(/ONLY/);
      expect(out).toMatch(/replace/i);
    });

    it('explicitly forbids generalizing non-trademark descriptions (Viktor von Doom regression)', () => {
      // Maurice tested with "Viktor von Doom" — a fictional character
      // NOT on any trademark list — and the prior wording rewrote it
      // anyway because the LLM was trained on too many franchise
      // examples to recognize IP-shaped patterns broadly. New
      // instruction explicitly tells the model not to generalize
      // non-trademarked names.
      const out = buildModerationRewriteInstruction('test', ['TRADEMARK']);
      expect(out).toMatch(/not on any trademark list|leave it alone|not auto-generalize|Do NOT generalize/i);
    });
  });

  describe('NSFW / EXTREME_VIOLENCE / CHILD classification', () => {
    it('keeps character names and softens the imagery for NSFW', () => {
      const out = buildModerationRewriteInstruction('test prompt', ['NSFW']);
      expect(out).toMatch(/keep the character names/i);
      expect(out).toMatch(/violence.*gore.*explicit/i);
    });

    it('keeps character names for EXTREME_VIOLENCE', () => {
      const out = buildModerationRewriteInstruction('test', ['EXTREME_VIOLENCE']);
      expect(out).toMatch(/keep the character names/i);
    });

    it('keeps character names for CHILD', () => {
      const out = buildModerationRewriteInstruction('test', ['CHILD']);
      expect(out).toMatch(/keep the character names/i);
    });

    it('lists the classifications back to the AI for context', () => {
      const out = buildModerationRewriteInstruction('test', ['NSFW', 'EXTREME_VIOLENCE']);
      expect(out).toMatch(/NSFW.*EXTREME_VIOLENCE/);
    });
  });

  describe('unknown / empty classification', () => {
    it('falls back to the conservative pre-fix wording when classifications is empty', () => {
      // Back-compat: callers that don't yet pass classifications get the
      // old "Keep the character names" behaviour rather than a broken
      // empty path.
      const out = buildModerationRewriteInstruction('test prompt');
      expect(out).toMatch(/keep the character names/i);
    });

    it('falls back when the only classification is unknown to us', () => {
      const out = buildModerationRewriteInstruction('test', ['UNKNOWN_FUTURE_CLASS']);
      expect(out).toMatch(/keep the character names/i);
    });
  });

  it('always echoes the original failed prompt and asks for ONLY the rewrite', () => {
    const failed = 'Spider-Man swinging through Tokyo at night';
    for (const cls of [['TRADEMARK'], ['NSFW'], []]) {
      const out = buildModerationRewriteInstruction(failed, cls);
      expect(out).toContain(failed);
      expect(out).toMatch(/Return ONLY the rewritten prompt/i);
    }
  });
});
