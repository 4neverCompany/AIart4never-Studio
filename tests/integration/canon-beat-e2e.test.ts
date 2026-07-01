/**
 * M1 proof gate (4NE-9) — one beat end-to-end through the canon engine.
 *
 * Composes the REAL canon modules to prove the loop holds together:
 *   plan (reuse-first) → canon-anchored system prompt → compliance guard →
 *   canon-tagged asset → reuse-first picks it up next time.
 *
 * This exercises the canon LOGIC layer that M1 delivers; the actual LLM call
 * + reference-anchored image execution land in M2 (Higgsfield MCP).
 */
import { describe, expect, it } from 'vitest';
import { buildCanonSystemBlock } from '@/lib/canon';
import { checkCanonCompliance } from '@/lib/canon/guard';
import { assetMatchesCanon, buildWeeklyContentPlan, canonTags } from '@/lib/canon/content-plan';

describe('M1 one-beat e2e (4NE-9): plan → canon prompt → guard → tag → reuse', () => {
  it('a Story-Beat for Kael flows on-canon through the whole loop', () => {
    // 1. PLAN — with an empty library, the Friday Story-Beat is a new generation.
    const plan0 = buildWeeklyContentPlan({ featuredCharacterId: 'kael' });
    const beat = plan0.slots.find((s) => s.pillarId === 'story-beat')!;
    expect(beat).toBeDefined();
    expect(beat.day).toBe('fri');
    expect(beat.decision).toBe('generate');

    // 2. PROMPT — the director's system prompt is STRUCTURAL (Story 2.8): the
    //    per-character lore lives in the live Element, so the block carries the
    //    framing + the resolve-live instruction, not hardcoded cyberdeck/anchor.
    const system = buildCanonSystemBlock(beat.characterId);
    expect(system).toContain('Master4never (Kael)');
    expect(system).toMatch(/show_reference_elements/);
    expect(system).not.toMatch(/cyberdeck/i);

    // 3. GUARD — a produced, anchored image prompt (resolved Element token +
    //    prose lock) passes compliance.
    const prompt =
      'Editing from <<<9349dc19-0801-40de-8bb6-e433328f83e2>>>: Master4never steps into a neon-rain reality, ' +
      'keep the same man, same face.';
    const check = checkCanonCompliance(beat.characterId, prompt);
    expect(check.ok).toBe(true);
    expect(check.violations).toHaveLength(0);

    // 4. TAG — the persisted asset carries the beat's canon facets.
    const asset = { tags: canonTags(beat.characterId, beat.pillarId) };
    expect(assetMatchesCanon(asset, { characterId: 'kael', pillarId: 'story-beat' })).toBe(true);

    // 5. REUSE — next time, a non-Friday slot with a matching library asset
    //    REUSES instead of regenerating (FR-2; reuse-first lowers new-gen count).
    const reusable = { tags: canonTags('kael', 'variant-reveal') };
    const plan1 = buildWeeklyContentPlan({ featuredCharacterId: 'kael', library: [reusable] });
    const monday = plan1.slots.find((s) => s.day === 'mon' && s.pillarId === 'variant-reveal')!;
    expect(monday.decision).toBe('reuse');
    expect(plan1.newGenCount).toBeLessThan(plan0.newGenCount);
  });

  it('the guard BLOCKS an un-anchored beat (no resolved Element token) — Story 2.8', () => {
    // The structural guard now blocks on the ONE lore-agnostic guarantee: a
    // recurring-character prompt with no <<<Element>>> anchor (edit-from-scratch).
    const unanchored = 'Kaelus Vorne with crimson ceramite, same man.'; // no <<<uuid>>>
    const check = checkCanonCompliance('kaelus-vorne', unanchored);
    expect(check.ok).toBe(false);
    expect(check.violations.some((v) => v.rule === 'missing-element-token' && v.severity === 'error')).toBe(true);
  });
});
