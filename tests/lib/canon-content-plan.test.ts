import { describe, expect, it } from 'vitest';
import {
  assetMatchesCanon,
  buildWeeklyContentPlan,
  canonTags,
} from '@/lib/canon/content-plan';

describe('canonTags', () => {
  it('stamps character + reality, and pillar when given', () => {
    expect(canonTags('kael')).toEqual(['character:kael', 'reality:prime']);
    expect(canonTags('kaelus-vorne', 'variant-reveal')).toEqual([
      'character:kaelus-vorne',
      'reality:w40k',
      'pillar:variant-reveal',
    ]);
  });
});

describe('assetMatchesCanon', () => {
  const asset = { tags: canonTags('kael', 'variant-reveal') };
  it('matches on character + pillar facets', () => {
    expect(assetMatchesCanon(asset, { characterId: 'kael' })).toBe(true);
    expect(assetMatchesCanon(asset, { characterId: 'kael', pillarId: 'variant-reveal' })).toBe(true);
  });
  it('rejects a mismatched facet', () => {
    expect(assetMatchesCanon(asset, { characterId: 'kaelus-vorne' })).toBe(false);
    expect(assetMatchesCanon(asset, { pillarId: 'lore-poll' })).toBe(false);
    expect(assetMatchesCanon({}, { characterId: 'kael' })).toBe(false);
  });
});

describe('buildWeeklyContentPlan', () => {
  it('with an EMPTY library, every slot must generate', () => {
    const plan = buildWeeklyContentPlan({ featuredCharacterId: 'kael' });
    expect(plan.slots.length).toBeGreaterThan(0);
    expect(plan.reuseCount).toBe(0);
    expect(plan.newGenCount).toBe(plan.slots.length);
  });

  it('reuse-first: with a stocked library, only the Friday Story-Beat is new', () => {
    // Library has a Kael asset for each non-Friday pillar (variant-reveal,
    // lore-poll, same-soul) → those slots reuse; the guaranteed Story-Beat generates.
    const library = [
      { tags: canonTags('kael', 'variant-reveal') },
      { tags: canonTags('kael', 'lore-poll') },
      { tags: canonTags('kael', 'same-soul') },
    ];
    const plan = buildWeeklyContentPlan({ featuredCharacterId: 'kael', library });

    expect(plan.newGenCount).toBe(1);
    const newGen = plan.slots.filter((s) => s.decision === 'generate');
    expect(newGen).toHaveLength(1);
    expect(newGen[0].day).toBe('fri');
    expect(newGen[0].pillarId).toBe('story-beat');
    // everything else reuses
    expect(plan.reuseCount).toBe(plan.slots.length - 1);
  });

  it('the featured character drives the reality + per-slot casting', () => {
    const plan = buildWeeklyContentPlan({ featuredCharacterId: 'kaelus-vorne' });
    expect(plan.slots.every((s) => s.characterId === 'kaelus-vorne')).toBe(true);
    expect(plan.slots.every((s) => s.realityId === 'w40k')).toBe(true);
  });

  it('defaults the featured character to Kael', () => {
    const plan = buildWeeklyContentPlan();
    expect(plan.slots.every((s) => s.characterId === 'kael')).toBe(true);
  });
});

describe('buildWeeklyContentPlan — adapted-template loop close (M3)', () => {
  it('plans against an injected baseTemplate and carries growth annotations', async () => {
    const { adaptWeeklyTemplate } = await import('@/lib/growth');
    // Cold start returns the canon template unchanged → the plan must match the
    // default-template plan exactly (backward compatible).
    const cold = adaptWeeklyTemplate();
    const adaptedPlan = buildWeeklyContentPlan({ baseTemplate: cold.slots });
    const defaultPlan = buildWeeklyContentPlan();
    expect(adaptedPlan.slots.map((s) => `${s.day}:${s.pillarId}:${s.decision}`)).toEqual(
      defaultPlan.slots.map((s) => `${s.day}:${s.pillarId}:${s.decision}`),
    );
    expect(adaptedPlan.newGenCount).toBe(defaultPlan.newGenCount);
  });

  it('carries recommendedHour/hookId from an enriched slot onto the PlannedSlot', () => {
    // A hand-built adapted slot (superset of WeeklySlot) proves the passthrough.
    const enriched = [
      {
        day: 'fri' as const,
        pillarId: 'story-beat',
        format: 'carousel' as const,
        guaranteesNewGen: true,
        recommendedHour: 18,
        hookId: 'hook-cliffhanger',
      },
    ];
    const plan = buildWeeklyContentPlan({ baseTemplate: enriched });
    const fri = plan.slots.find((s) => s.day === 'fri');
    expect(fri?.recommendedHour).toBe(18);
    expect(fri?.hookId).toBe('hook-cliffhanger');
    expect(fri?.decision).toBe('generate'); // guaranteesNewGen still honored
  });
});
