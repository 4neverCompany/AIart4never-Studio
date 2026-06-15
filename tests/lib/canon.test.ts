import { describe, expect, it } from 'vitest';
import {
  CONSISTENCY_MANDATE,
  CONTENT_PILLARS,
  REALITIES,
  RENDER_METHOD,
  WATERMARK,
  WEEKLY_TEMPLATE,
  buildCanonSystemBlock,
  buildCharacterLockBlock,
  getCharacter,
  getElementRef,
  getPillar,
  getReality,
  listCharacters,
} from '@/lib/canon';

describe('canon data integrity', () => {
  it('has the three recurring characters', () => {
    const ids = listCharacters().map((c) => c.id).sort();
    expect(ids).toEqual(['kael', 'kaelus-alt', 'kaelus-vorne']);
  });

  it('only Kael (PRIME) is prime', () => {
    expect(getCharacter('kael').isPrime).toBe(true);
    expect(getCharacter('kaelus-vorne').isPrime).toBe(false);
    expect(getCharacter('kaelus-alt').isPrime).toBe(false);
  });

  it('every character has at least one locked reference', () => {
    for (const c of listCharacters()) {
      expect(c.persistence.lockedRefs.length).toBeGreaterThan(0);
    }
  });

  it('registered Elements: Kael + Kaelus Vorne have one; the alt study does not', () => {
    expect(getElementRef('kael')).toBe('<<<9349dc19-0801-40de-8bb6-e433328f83e2>>>');
    expect(getElementRef('kaelus-vorne')).toBe('<<<812c9a78-4b78-4910-a301-3083c8c65ecc>>>');
    expect(getElementRef('kaelus-alt')).toBeUndefined();
  });

  it('throws on unknown ids', () => {
    // @ts-expect-error — exercising the runtime guard
    expect(() => getCharacter('nobody')).toThrow();
    // @ts-expect-error
    expect(() => getReality('nowhere')).toThrow();
  });
});

describe('realities', () => {
  it('maps the three realities', () => {
    expect(Object.keys(REALITIES).sort()).toEqual(['prime', 'w40k', 'w40k-alt']);
    expect(getReality('w40k').hallmarks.length).toBeGreaterThan(0);
  });
});

describe('buildCanonSystemBlock', () => {
  it('Kael block carries his PRIME-only locks + anchor + mandate', () => {
    const b = buildCanonSystemBlock('kael');
    expect(b).toContain('Master4never (Kael)');
    expect(b).toContain('cyberdeck');
    expect(b).toContain('AIART4NEVER');
    expect(b).toContain('<<<9349dc19-0801-40de-8bb6-e433328f83e2>>>');
    expect(b.toLowerCase()).toContain('never generate a recurring character from scratch');
    expect(b).toContain('neon cyberpunk'); // PRIME reality hallmark
  });

  it('Kaelus Vorne block enforces NO cyberdeck + Astartes iconography + his Element', () => {
    const b = buildCanonSystemBlock('kaelus-vorne');
    expect(b).toContain('Kaelus Vorne');
    expect(b).toContain('NO cyberdeck');
    expect(b).toContain('service studs');
    expect(b).toContain('Iron Halo');
    expect(b).toContain('<<<812c9a78-4b78-4910-a301-3083c8c65ecc>>>');
    // a W40K variant does NOT wear the channel tag
    expect(b).toContain('Does NOT wear the AIART4NEVER channel tag');
  });

  it('the alt study falls back to a locked reference (no Element)', () => {
    const b = buildCanonSystemBlock('kaelus-alt');
    // The character anchor line uses the locked-reference fallback (no registered Element).
    // (The mandate text itself shows a `<<<id>>>` example, so we check the anchor line specifically.)
    expect(b).toContain('Anchor for this character: locked reference image');
  });
});

describe('buildCharacterLockBlock', () => {
  it('emits an identity lock + anchor for image prompts', () => {
    const b = buildCharacterLockBlock('kael');
    expect(b).toContain('Identity lock');
    expect(b).toContain('same face');
    expect(b).toContain('Anchor element: <<<9349dc19-0801-40de-8bb6-e433328f83e2>>>');
  });
});

describe('channel strategy', () => {
  it('has the 4 content pillars', () => {
    expect(CONTENT_PILLARS.map((p) => p.id).sort()).toEqual([
      'lore-poll',
      'same-soul',
      'story-beat',
      'variant-reveal',
    ]);
    expect(getPillar('story-beat')?.format).toBe('carousel');
  });

  it('the weekly template has exactly one guaranteed-new-gen slot, and it is the Friday Story-Beat', () => {
    const newGen = WEEKLY_TEMPLATE.filter((s) => s.guaranteesNewGen);
    expect(newGen).toHaveLength(1);
    expect(newGen[0].day).toBe('fri');
    expect(newGen[0].pillarId).toBe('story-beat');
  });

  it('every weekly slot references a real pillar', () => {
    for (const slot of WEEKLY_TEMPLATE) {
      expect(getPillar(slot.pillarId)).toBeDefined();
    }
  });
});

describe('locked recipes', () => {
  it('watermark recipe matches the locked spec', () => {
    expect(WATERMARK.opacity).toBe(0.75);
    expect(WATERMARK.widthFraction).toBeCloseTo(0.16);
    expect(WATERMARK.position).toBe('bottom-right');
    expect(WATERMARK.logoElementId).toBe('6c36180d-28ba-4535-8655-dfd2b502f9ae');
  });

  it('render method names Higgsfield for character anchoring + excludes MiniMax image-01', () => {
    expect(RENDER_METHOD).toContain('Higgsfield');
    expect(RENDER_METHOD).toContain('MiniMax image-01 cannot take a reference image');
    expect(CONSISTENCY_MANDATE.length).toBeGreaterThan(50);
  });
});
