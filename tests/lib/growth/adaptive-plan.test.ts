/**
 * M3 loop-closer — adaptive weekly planner tests (PURE, deterministic).
 *
 * Pins down:
 *  - Cold start (no attribution) → the canon WEEKLY_TEMPLATE returned unchanged,
 *    every slot `adapted:false`, `coldStart:true`, no adjustments/explored.
 *  - A real attribution report (pillar A over-, B under-performing) → adjustments
 *    reflect it AND the canon invariants hold: the Friday `guaranteesNewGen`
 *    story-beat slot is never dropped/decreased, the slot count is stable (6),
 *    and no pillar disappears.
 *  - slotRecs/hookRecs annotate the RIGHT slot (recommendedHour + hookId land on
 *    the matching pillar/day).
 *  - ε-greedy: rng ≥ rate → pure exploit (top picks, `explored` empty); rng < rate
 *    → exploration recorded; both fully deterministic via injected rng.
 */
import { describe, it, expect } from 'vitest';
import { adaptWeeklyTemplate, DEFAULT_EXPLORATION_RATE } from '@/lib/growth';
import type { AttributedInsight } from '@/lib/growth';
import { attributeEngagement } from '@/lib/growth';
import { WEEKLY_TEMPLATE } from '@/lib/canon';
import type { AttributionReport, HookRecommendation, SlotRecommendation } from '@/lib/growth';

/** Build an AttributedInsight with zero defaults, overriding what each case needs. */
function insight(
  over: Partial<AttributedInsight> & Pick<AttributedInsight, 'postId'>,
): AttributedInsight {
  return {
    assetId: undefined,
    pillarId: undefined,
    reality: undefined,
    day: undefined,
    hookId: undefined,
    postedAt: 1_700_000_000_000,
    likes: 0,
    comments: 0,
    saves: 0,
    shares: 0,
    reach: 0,
    impressions: 0,
    ...over,
  };
}

/**
 * Attribution where `variant-reveal` over-performs and `lore-poll` under-performs
 * (each well-sampled at ≥5 posts), and `story-beat` sits mid. All at reach=1000,
 * so scoreInsight = weighted-action count:
 *   - variant-reveal: saves 30 → 120 (over-performer)
 *   - story-beat:     saves 12 →  48 (mid; the FRIDAY new-gen pillar)
 *   - lore-poll:      saves  2 →   8 (under-performer)
 */
function buildAttribution(): AttributionReport {
  const fixture: AttributedInsight[] = [];
  for (let i = 0; i < 5; i++) {
    fixture.push(insight({ postId: `vr${i}`, pillarId: 'variant-reveal', reality: 'w40k', saves: 30, reach: 1000 }));
    fixture.push(insight({ postId: `sb${i}`, pillarId: 'story-beat', reality: 'prime', saves: 12, reach: 1000 }));
    fixture.push(insight({ postId: `lp${i}`, pillarId: 'lore-poll', reality: 'prime', saves: 2, reach: 1000 }));
  }
  return attributeEngagement(fixture);
}

describe('adaptWeeklyTemplate — cold start', () => {
  it('with no attribution returns the canon template unchanged, coldStart:true', () => {
    const r = adaptWeeklyTemplate();
    expect(r.coldStart).toBe(true);
    expect(r.adjustments).toEqual([]);
    expect(r.explored).toEqual([]);
    // Same count and structure as the canon template, every slot un-adapted.
    expect(r.slots).toHaveLength(WEEKLY_TEMPLATE.length);
    r.slots.forEach((slot, i) => {
      const base = WEEKLY_TEMPLATE[i]!;
      expect(slot.day).toBe(base.day);
      expect(slot.pillarId).toBe(base.pillarId);
      expect(slot.format).toBe(base.format);
      expect(slot.guaranteesNewGen).toBe(base.guaranteesNewGen);
      expect(slot.adapted).toBe(false);
      expect(slot.recommendedHour).toBeUndefined();
      expect(slot.hookId).toBeUndefined();
      expect(slot.rationale).toBeUndefined();
    });
  });

  it('treats a zero-sample attribution report as cold start too', () => {
    const r = adaptWeeklyTemplate({
      attribution: { byPillar: [], byHook: [], byReality: [], sampleSize: 0 },
    });
    expect(r.coldStart).toBe(true);
    expect(r.adjustments).toEqual([]);
    expect(r.slots.every((s) => s.adapted === false)).toBe(true);
  });
});

describe('adaptWeeklyTemplate — frequency nudges preserve canon invariants', () => {
  it('reflects over/under-performers AND keeps the Friday new-gen guarantee + slot count + every pillar', () => {
    const attribution = buildAttribution();
    // rng=0.99 ≥ rate → no exploration, so we isolate the nudge behavior.
    const r = adaptWeeklyTemplate({ attribution, rng: () => 0.99 });

    expect(r.coldStart).toBe(false);

    // Adjustments reflect the signal: variant-reveal increase, lore-poll decrease.
    const byPillar = r.adjustments.filter((a) => a.dimension === 'pillar');
    expect(byPillar.find((a) => a.key === 'variant-reveal')?.kind).toBe('increase');
    expect(byPillar.find((a) => a.key === 'lore-poll')?.kind).toBe('decrease');

    // INVARIANT: slot count is stable (the fixed 6-slot template).
    expect(r.slots).toHaveLength(WEEKLY_TEMPLATE.length);
    expect(r.slots).toHaveLength(6);

    // INVARIANT: the Friday story-beat slot still guarantees new gen, unchanged.
    const friday = r.slots.find((s) => s.day === 'fri');
    expect(friday).toBeDefined();
    expect(friday!.pillarId).toBe('story-beat');
    expect(friday!.guaranteesNewGen).toBe(true);

    // INVARIANT: no pillar dropped to zero — every base pillar still present.
    const basePillars = new Set(WEEKLY_TEMPLATE.map((s) => s.pillarId));
    const adaptedPillars = new Set(r.slots.map((s) => s.pillarId));
    for (const p of basePillars) expect(adaptedPillars.has(p)).toBe(true);

    // INVARIANT: guaranteesNewGen flags are preserved 1:1 with the base template.
    r.slots.forEach((slot, i) => {
      expect(slot.guaranteesNewGen).toBe(WEEKLY_TEMPLATE[i]!.guaranteesNewGen);
    });

    // The over-performing pillar's slot(s) get a "favor" preference annotation.
    const variantSlots = r.slots.filter((s) => s.pillarId === 'variant-reveal');
    expect(variantSlots.length).toBeGreaterThan(0);
    expect(variantSlots.every((s) => s.adapted && /favor/i.test(s.rationale ?? ''))).toBe(true);

    // The under-performing lore-poll slots get a "de-emphasize" preference.
    const loreSlots = r.slots.filter((s) => s.pillarId === 'lore-poll');
    expect(loreSlots.every((s) => /de-emphasize/i.test(s.rationale ?? ''))).toBe(true);
  });

  it('never applies a decrease to the Friday new-gen story-beat slot', () => {
    // Make story-beat the UNDER-performer so a naive nudge would decrease it.
    const fixture: AttributedInsight[] = [];
    for (let i = 0; i < 5; i++) {
      fixture.push(insight({ postId: `vr${i}`, pillarId: 'variant-reveal', reality: 'w40k', saves: 30, reach: 1000 }));
      fixture.push(insight({ postId: `sb${i}`, pillarId: 'story-beat', reality: 'prime', saves: 2, reach: 1000 }));
    }
    const attribution = attributeEngagement(fixture);
    const r = adaptWeeklyTemplate({ attribution, rng: () => 0.99 });

    // The proposal layer may well say "decrease story-beat"...
    const sbAdj = r.adjustments.find((a) => a.dimension === 'pillar' && a.key === 'story-beat');
    expect(sbAdj?.kind).toBe('decrease');

    // ...but the Friday slot must NOT carry a de-emphasize; it's explicitly held.
    const friday = r.slots.find((s) => s.day === 'fri')!;
    expect(friday.guaranteesNewGen).toBe(true);
    expect(friday.rationale ?? '').not.toMatch(/de-emphasize/i);
    expect(friday.rationale ?? '').toMatch(/held|guaranteed new-gen|canon invariant/i);
  });
});

describe('adaptWeeklyTemplate — slotRecs/hookRecs annotate the right slots', () => {
  const attribution = buildAttribution();

  it('puts recommendedHour + hookId on the matching pillar/day slot only', () => {
    const slotRecs: SlotRecommendation[] = [
      // Matches the Friday story-beat slot exactly.
      { pillarId: 'story-beat', day: 'fri', recommendedHour: 19, score: 100, basis: 8 },
      // Matches the Monday variant-reveal slot.
      { pillarId: 'variant-reveal', day: 'mon', recommendedHour: 12, score: 80, basis: 6 },
      // A non-matching day (variant-reveal on tue) must NOT leak onto any slot.
      { pillarId: 'variant-reveal', day: 'tue', recommendedHour: 3, score: 50, basis: 4 },
    ];
    const hookRecs: HookRecommendation[] = [
      { pillarId: 'story-beat', hookId: 'hook-sb-top', score: 90, basis: 7 },
      { pillarId: 'variant-reveal', hookId: 'hook-vr-top', score: 70, basis: 5 },
    ];

    const r = adaptWeeklyTemplate({ attribution, slotRecs, hookRecs, rng: () => 0.99 });

    const friday = r.slots.find((s) => s.day === 'fri' && s.pillarId === 'story-beat')!;
    expect(friday.recommendedHour).toBe(19);
    expect(friday.hookId).toBe('hook-sb-top');
    expect(friday.adapted).toBe(true);

    const monday = r.slots.find((s) => s.day === 'mon' && s.pillarId === 'variant-reveal')!;
    expect(monday.recommendedHour).toBe(12);
    expect(monday.hookId).toBe('hook-vr-top');

    // Sunday is also variant-reveal but has no slotRec for `sun` → no hour, but it
    // still gets the pillar's top hook (hooks are per-pillar, not per-day).
    const sunday = r.slots.find((s) => s.day === 'sun' && s.pillarId === 'variant-reveal')!;
    expect(sunday.recommendedHour).toBeUndefined();
    expect(sunday.hookId).toBe('hook-vr-top');

    // lore-poll slots got neither a slotRec nor a hookRec → no hour/hook.
    const lore = r.slots.filter((s) => s.pillarId === 'lore-poll');
    expect(lore.every((s) => s.recommendedHour === undefined && s.hookId === undefined)).toBe(true);
  });
});

describe('adaptWeeklyTemplate — ε-greedy exploration', () => {
  const attribution = buildAttribution();
  const slotRecs: SlotRecommendation[] = [
    // Two candidate hours for the Friday story-beat slot, top first.
    { pillarId: 'story-beat', day: 'fri', recommendedHour: 19, score: 100, basis: 8 },
    { pillarId: 'story-beat', day: 'fri', recommendedHour: 7, score: 40, basis: 3 },
  ];
  const hookRecs: HookRecommendation[] = [
    // Two candidate hooks for story-beat, top first.
    { pillarId: 'story-beat', hookId: 'hook-top', score: 90, basis: 7 },
    { pillarId: 'story-beat', hookId: 'hook-alt', score: 30, basis: 2 },
  ];

  it('rng ≥ rate → pure exploit (top picks, explored empty)', () => {
    const r = adaptWeeklyTemplate({ attribution, slotRecs, hookRecs, rng: () => 0.99 });
    expect(r.explored).toEqual([]);
    const friday = r.slots.find((s) => s.day === 'fri')!;
    expect(friday.recommendedHour).toBe(19); // top hour
    expect(friday.hookId).toBe('hook-top'); // top hook
  });

  it('rng < rate → exploration recorded (non-top picks), deterministically', () => {
    const r = adaptWeeklyTemplate({ attribution, slotRecs, hookRecs, rng: () => 0.0 });
    // Friday explored both its hour and hook decision → key recorded once.
    expect(r.explored).toContain('fri:story-beat');
    const friday = r.slots.find((s) => s.day === 'fri')!;
    expect(friday.recommendedHour).toBe(7); // runner-up hour
    expect(friday.hookId).toBe('hook-alt'); // runner-up hook
    // The same slot key isn't double-recorded even though both decisions explored.
    expect(r.explored.filter((k) => k === 'fri:story-beat')).toHaveLength(1);
  });

  it('default exploration rate is the documented 0.15', () => {
    expect(DEFAULT_EXPLORATION_RATE).toBe(0.15);
  });
});
