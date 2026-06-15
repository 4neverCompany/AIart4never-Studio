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

    // 2. PROMPT — the director's system prompt is anchored to Kael's canon.
    const system = buildCanonSystemBlock(beat.characterId);
    expect(system).toContain('cyberdeck'); // PRIME signature lock
    expect(system).toContain('AIART4NEVER'); // channel-tag lock
    expect(system).toContain('<<<9349dc19-0801-40de-8bb6-e433328f83e2>>>'); // Element anchor

    // 3. GUARD — a produced, on-canon image prompt passes compliance.
    const prompt =
      'Editing from <<<9349dc19-0801-40de-8bb6-e433328f83e2>>>: Master4never steps into a neon-rain reality, ' +
      'his forehead cyberdeck flaring cyan, an AIART4NEVER tag on his collar — keep the same man, same face.';
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

  it('the guard BLOCKS an off-canon beat (a cyberdeck on the W40K variant)', () => {
    const offCanon = '<<<812c9a78-4b78-4910-a301-3083c8c65ecc>>> Kaelus Vorne with a glowing forehead cyberdeck, crimson ceramite.';
    const check = checkCanonCompliance('kaelus-vorne', offCanon);
    expect(check.ok).toBe(false);
    expect(check.violations.some((v) => v.rule === 'no-cyberdeck-on-variant' && v.severity === 'error')).toBe(true);
  });
});
