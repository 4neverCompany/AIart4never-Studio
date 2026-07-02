/**
 * Story 8-11 — operator tuning proposals tests (PURE, deterministic).
 *
 * Pins down the accept/edit/reject control seam:
 *  - buildTuningProposals: one explicit proposal per fresh hour/hook decision,
 *    with the per-dimension basis (top vs ε-greedy exploration) + rationale;
 *    cold start → []; unchanged re-recommendations and carried-over annotations
 *    (no basis) propose nothing.
 *  - applyProposalDecisions: accept applies the recommendation; accept+edit
 *    applies the OPERATOR'S value (AC2) and records both; reject/ignore leaves
 *    the base value (AC3); canon invariants (slot count, Friday guarantee) hold;
 *    bad edits throw instead of half-applying.
 *  - measurePostingTimeChange (OAQ-9): new vs prior arm scored with the shared
 *    scoreInsight → shrinkScore yardstick; dead-band verdicts; minSample floor.
 */
import { describe, it, expect } from 'vitest';

import {
  adaptWeeklyTemplate,
  attributeEngagement,
  buildTuningProposals,
  applyProposalDecisions,
  measurePostingTimeChange,
  AB_MIN_SAMPLE,
} from '@/lib/growth';
import type {
  AttributedInsight,
  HookRecommendation,
  SlotRecommendation,
  TunedSlot,
  TuningProposal,
} from '@/lib/growth';
import { WEEKLY_TEMPLATE } from '@/lib/canon';

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

/** A well-sampled attribution so adaptWeeklyTemplate is NOT cold-start. */
function buildAttribution() {
  const fixture: AttributedInsight[] = [];
  for (let i = 0; i < 5; i++) {
    fixture.push(insight({ postId: `vr${i}`, pillarId: 'variant-reveal', reality: 'w40k', saves: 30, reach: 1000 }));
    fixture.push(insight({ postId: `sb${i}`, pillarId: 'story-beat', reality: 'prime', saves: 12, reach: 1000 }));
    fixture.push(insight({ postId: `lp${i}`, pillarId: 'lore-poll', reality: 'prime', saves: 2, reach: 1000 }));
  }
  return attributeEngagement(fixture);
}

const SLOT_RECS: SlotRecommendation[] = [
  { pillarId: 'story-beat', day: 'fri', recommendedHour: 19, score: 100, basis: 8 },
  { pillarId: 'story-beat', day: 'fri', recommendedHour: 7, score: 40, basis: 3 },
];
const HOOK_RECS: HookRecommendation[] = [
  { pillarId: 'story-beat', hookId: 'hook-top', score: 90, basis: 7 },
  { pillarId: 'story-beat', hookId: 'hook-alt', score: 30, basis: 2 },
];

describe('buildTuningProposals', () => {
  it('emits one explicit proposal per fresh hour/hook decision with basis "top" on exploit', () => {
    const adapted = adaptWeeklyTemplate({
      attribution: buildAttribution(),
      slotRecs: SLOT_RECS,
      hookRecs: HOOK_RECS,
      rng: () => 0.99, // exploit
    });
    const proposals = buildTuningProposals(adapted);

    const hour = proposals.find((p) => p.id === 'hour:fri:story-beat');
    expect(hour).toBeDefined();
    expect(hour!.kind).toBe('posting-hour');
    expect(hour!.day).toBe('fri');
    expect(hour!.pillarId).toBe('story-beat');
    expect(hour!.recommendedValue).toBe(19); // top candidate
    expect(hour!.basis).toBe('top');
    expect(hour!.priorValue).toBeUndefined(); // canon default carries no hour
    expect(hour!.rationale).toMatch(/posting hour 19:00/);

    const hook = proposals.find((p) => p.id === 'hook:fri:story-beat');
    expect(hook).toBeDefined();
    expect(hook!.kind).toBe('hook');
    expect(hook!.recommendedValue).toBe('hook-top');
    expect(hook!.basis).toBe('top');
  });

  it('names ε-greedy exploration picks as basis "exploration" (AC1: top vs exploration)', () => {
    const adapted = adaptWeeklyTemplate({
      attribution: buildAttribution(),
      slotRecs: SLOT_RECS,
      hookRecs: HOOK_RECS,
      rng: () => 0.0, // explore every decision
    });
    const proposals = buildTuningProposals(adapted);

    const hour = proposals.find((p) => p.id === 'hour:fri:story-beat')!;
    expect(hour.recommendedValue).toBe(7); // runner-up candidate
    expect(hour.basis).toBe('exploration');
    expect(hour.rationale).toMatch(/exploring hour/);

    const hook = proposals.find((p) => p.id === 'hook:fri:story-beat')!;
    expect(hook.recommendedValue).toBe('hook-alt');
    expect(hook.basis).toBe('exploration');
  });

  it('cold start (no signal) → no proposals', () => {
    expect(buildTuningProposals(adaptWeeklyTemplate())).toEqual([]);
  });

  it('a re-recommendation equal to the base template value proposes nothing', () => {
    // The base template already carries the value the tuner would recommend.
    const tunedBase: TunedSlot[] = WEEKLY_TEMPLATE.map((s) =>
      s.day === 'fri' ? { ...s, recommendedHour: 19, hookId: 'hook-top' } : { ...s },
    );
    const adapted = adaptWeeklyTemplate({
      baseTemplate: tunedBase,
      attribution: buildAttribution(),
      slotRecs: SLOT_RECS,
      hookRecs: HOOK_RECS,
      rng: () => 0.99,
    });
    const proposals = buildTuningProposals(adapted, tunedBase);
    expect(proposals.find((p) => p.id === 'hour:fri:story-beat')).toBeUndefined();
    expect(proposals.find((p) => p.id === 'hook:fri:story-beat')).toBeUndefined();
  });

  it('carries the tuned base value as priorValue when the recommendation differs', () => {
    const tunedBase: TunedSlot[] = WEEKLY_TEMPLATE.map((s) =>
      s.day === 'fri' ? { ...s, recommendedHour: 9 } : { ...s },
    );
    const adapted = adaptWeeklyTemplate({
      baseTemplate: tunedBase,
      attribution: buildAttribution(),
      slotRecs: SLOT_RECS,
      rng: () => 0.99,
    });
    const hour = buildTuningProposals(adapted, tunedBase).find(
      (p) => p.id === 'hour:fri:story-beat',
    )!;
    expect(hour.recommendedValue).toBe(19);
    expect(hour.priorValue).toBe(9);
  });
});

describe('applyProposalDecisions', () => {
  /** The Friday hour + hook proposals from a deterministic exploit run. */
  function proposals(): TuningProposal[] {
    return buildTuningProposals(
      adaptWeeklyTemplate({
        attribution: buildAttribution(),
        slotRecs: SLOT_RECS,
        hookRecs: HOOK_RECS,
        rng: () => 0.99,
      }),
    );
  }

  it('accept → the recommended value lands on the matching slot only', () => {
    const { slots, applied, rejected } = applyProposalDecisions(WEEKLY_TEMPLATE, proposals(), [
      { proposalId: 'hour:fri:story-beat', action: 'accept' },
    ]);
    const friday = slots.find((s) => s.day === 'fri')!;
    expect(friday.recommendedHour).toBe(19);
    expect(friday.hookId).toBeUndefined(); // the hook proposal was NOT accepted
    // No other slot was touched.
    for (const s of slots.filter((x) => x.day !== 'fri')) {
      expect(s.recommendedHour).toBeUndefined();
      expect(s.hookId).toBeUndefined();
    }
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      proposalId: 'hour:fri:story-beat',
      kind: 'posting-hour',
      recommendedValue: 19,
      appliedValue: 19,
      edited: false,
    });
    expect(rejected).toEqual([]);
  });

  it('accept + edited value → the OPERATOR value flows, and the record names both (AC2)', () => {
    const { slots, applied } = applyProposalDecisions(WEEKLY_TEMPLATE, proposals(), [
      { proposalId: 'hour:fri:story-beat', action: 'accept', editedValue: 7 },
      { proposalId: 'hook:fri:story-beat', action: 'accept', editedValue: 'my-own-hook' },
    ]);
    const friday = slots.find((s) => s.day === 'fri')!;
    expect(friday.recommendedHour).toBe(7); // NOT the recommended 19
    expect(friday.hookId).toBe('my-own-hook'); // NOT the recommended hook-top

    const hourChange = applied.find((c) => c.proposalId === 'hour:fri:story-beat')!;
    expect(hourChange.appliedValue).toBe(7);
    expect(hourChange.recommendedValue).toBe(19);
    expect(hourChange.edited).toBe(true);

    const hookChange = applied.find((c) => c.proposalId === 'hook:fri:story-beat')!;
    expect(hookChange.appliedValue).toBe('my-own-hook');
    expect(hookChange.edited).toBe(true);
  });

  it('reject and ignore both keep the base value — nothing applies silently (AC3)', () => {
    const props = proposals();
    // Reject the hour explicitly; IGNORE the hook (no decision at all).
    const { slots, applied, rejected } = applyProposalDecisions(WEEKLY_TEMPLATE, props, [
      { proposalId: 'hour:fri:story-beat', action: 'reject' },
    ]);
    const friday = slots.find((s) => s.day === 'fri')!;
    expect(friday.recommendedHour).toBeUndefined();
    expect(friday.hookId).toBeUndefined();
    expect(applied).toEqual([]);
    expect(rejected).toEqual(['hour:fri:story-beat']);
    // The base slots come back structurally identical.
    expect(slots.map((s) => ({ ...s }))).toEqual(WEEKLY_TEMPLATE.map((s) => ({ ...s })));
  });

  it('preserves the canon invariants: 6 slots, Friday guarantee, days/pillars untouched', () => {
    const { slots } = applyProposalDecisions(WEEKLY_TEMPLATE, proposals(), [
      { proposalId: 'hour:fri:story-beat', action: 'accept' },
      { proposalId: 'hook:fri:story-beat', action: 'accept' },
    ]);
    expect(slots).toHaveLength(WEEKLY_TEMPLATE.length);
    slots.forEach((slot, i) => {
      const base = WEEKLY_TEMPLATE[i]!;
      expect(slot.day).toBe(base.day);
      expect(slot.pillarId).toBe(base.pillarId);
      expect(slot.format).toBe(base.format);
      expect(slot.guaranteesNewGen).toBe(base.guaranteesNewGen);
    });
  });

  it('a decision for an unknown proposal id is a no-op', () => {
    const { slots, applied } = applyProposalDecisions(WEEKLY_TEMPLATE, proposals(), [
      { proposalId: 'hour:mon:ghost-pillar', action: 'accept' },
    ]);
    expect(applied).toEqual([]);
    expect(slots.every((s) => s.recommendedHour === undefined && s.hookId === undefined)).toBe(true);
  });

  it('throws on an invalid edited hour or empty edited hook (never half-applies)', () => {
    expect(() =>
      applyProposalDecisions(WEEKLY_TEMPLATE, proposals(), [
        { proposalId: 'hour:fri:story-beat', action: 'accept', editedValue: 99 },
      ]),
    ).toThrow(/integer 0\.\.23/);
    expect(() =>
      applyProposalDecisions(WEEKLY_TEMPLATE, proposals(), [
        { proposalId: 'hook:fri:story-beat', action: 'accept', editedValue: '  ' },
      ]),
    ).toThrow(/non-empty hook/);
  });
});

describe('measurePostingTimeChange (OAQ-9 A/B measurement)', () => {
  /** A cell post at a given UTC hour with a given engagement (saves). */
  function cellPost(id: string, hourUtc: number, saves: number): AttributedInsight {
    return insight({
      postId: id,
      pillarId: 'story-beat',
      day: 'fri',
      postedAt: Date.UTC(2026, 5, 5, hourUtc, 0, 0),
      saves,
      reach: 1000,
    });
  }

  it('new-wins when the new hour clearly out-scores the prior baseline', () => {
    const history: AttributedInsight[] = [];
    for (let i = 0; i < 5; i++) history.push(cellPost(`new${i}`, 19, 30)); // strong
    for (let i = 0; i < 5; i++) history.push(cellPost(`old${i}`, 9, 5)); // weak
    const m = measurePostingTimeChange(history, {
      pillarId: 'story-beat',
      day: 'fri',
      newHour: 19,
      priorHour: 9,
    });
    expect(m.newArm.posts).toBe(5);
    expect(m.priorArm.posts).toBe(5);
    expect(m.newArm.avgScore).toBeGreaterThan(m.priorArm.avgScore);
    expect(m.verdict).toBe('new-wins');
  });

  it('prior-wins when the prior hour clearly out-scores the new one', () => {
    const history: AttributedInsight[] = [];
    for (let i = 0; i < 5; i++) history.push(cellPost(`new${i}`, 19, 5));
    for (let i = 0; i < 5; i++) history.push(cellPost(`old${i}`, 9, 30));
    const m = measurePostingTimeChange(history, {
      pillarId: 'story-beat',
      day: 'fri',
      newHour: 19,
      priorHour: 9,
    });
    expect(m.verdict).toBe('prior-wins');
  });

  it('inconclusive inside the ±15% dead-band', () => {
    const history: AttributedInsight[] = [];
    for (let i = 0; i < 5; i++) history.push(cellPost(`new${i}`, 19, 20));
    for (let i = 0; i < 5; i++) history.push(cellPost(`old${i}`, 9, 20));
    const m = measurePostingTimeChange(history, {
      pillarId: 'story-beat',
      day: 'fri',
      newHour: 19,
      priorHour: 9,
    });
    expect(m.verdict).toBe('inconclusive');
  });

  it('insufficient-data below the per-arm minSample floor (arms still reported)', () => {
    const history: AttributedInsight[] = [
      cellPost('new0', 19, 30),
      cellPost('old0', 9, 5),
    ];
    const m = measurePostingTimeChange(history, {
      pillarId: 'story-beat',
      day: 'fri',
      newHour: 19,
      priorHour: 9,
    });
    expect(m.minSample).toBe(AB_MIN_SAMPLE);
    expect(m.newArm.posts).toBe(1);
    expect(m.priorArm.posts).toBe(1);
    expect(m.verdict).toBe('insufficient-data');
  });

  it('an untimed prior (canon default) baselines against ALL other hours in the cell', () => {
    const history: AttributedInsight[] = [];
    for (let i = 0; i < 5; i++) history.push(cellPost(`new${i}`, 19, 30));
    // Prior posts scattered across other hours.
    history.push(cellPost('o1', 8, 5), cellPost('o2', 9, 5), cellPost('o3', 10, 5));
    history.push(cellPost('o4', 11, 5), cellPost('o5', 12, 5));
    const m = measurePostingTimeChange(history, {
      pillarId: 'story-beat',
      day: 'fri',
      newHour: 19,
      // priorHour omitted — untimed canon default
    });
    expect(m.priorArm.hour).toBeUndefined();
    expect(m.priorArm.posts).toBe(5);
    expect(m.verdict).toBe('new-wins');
  });

  it('only the experiment cell counts — other pillars/days are excluded', () => {
    const history: AttributedInsight[] = [];
    for (let i = 0; i < 5; i++) history.push(cellPost(`new${i}`, 19, 30));
    for (let i = 0; i < 5; i++) history.push(cellPost(`old${i}`, 9, 5));
    // Noise in other cells that would flip the verdict if it leaked in.
    for (let i = 0; i < 10; i++) {
      history.push(
        insight({
          postId: `noise${i}`,
          pillarId: 'lore-poll',
          day: 'tue',
          postedAt: Date.UTC(2026, 5, 2, 19, 0, 0),
          saves: 1,
          reach: 1000,
        }),
      );
    }
    const m = measurePostingTimeChange(history, {
      pillarId: 'story-beat',
      day: 'fri',
      newHour: 19,
      priorHour: 9,
    });
    expect(m.newArm.posts).toBe(5);
    expect(m.priorArm.posts).toBe(5);
    expect(m.verdict).toBe('new-wins');
  });
});
