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

  it('the spine carries only routing keys (Story 2.8: no persistence/lockedRefs/lore fields)', () => {
    for (const c of listCharacters()) {
      expect(Object.keys(c).sort()).toEqual(['id', 'isPrime', 'name', 'reality']);
    }
  });

  it('getElementRef returns undefined without a live resolution (no hardcoded Element ids) — Story 2.8', () => {
    // The Element id is NOT hardcoded anymore; it is resolved live into the
    // RunContext memo by show_reference_elements. With no active run/memo here,
    // every character is unresolved.
    expect(getElementRef('kael')).toBeUndefined();
    expect(getElementRef('kaelus-vorne')).toBeUndefined();
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

describe('buildCanonSystemBlock — STRUCTURAL only (Story 2.8; lore lives in the live Element)', () => {
  it('Kael block: framing + reality hallmarks + mandate + resolve-live instruction, NO hardcoded lore/anchor', () => {
    const b = buildCanonSystemBlock('kael');
    expect(b).toContain('Master4never (Kael)');
    expect(b).toContain('neon cyberpunk'); // PRIME reality hallmark (structural, kept)
    expect(b.toLowerCase()).toContain('never generate a recurring character from scratch'); // mandate
    expect(b).toMatch(/show_reference_elements/); // resolve-live instruction
    // No hardcoded per-character lore or Element id in the block.
    expect(b).not.toMatch(/cyberdeck/i);
    expect(b).not.toMatch(/<<<[0-9a-f-]{8,}>>>/i);
  });

  it('Kaelus Vorne block: name + reality framing, no hardcoded lore/anchor', () => {
    const b = buildCanonSystemBlock('kaelus-vorne');
    expect(b).toContain('Kaelus Vorne');
    expect(b).toMatch(/show_reference_elements/);
    expect(b).not.toMatch(/cyberdeck/i);
    expect(b).not.toContain('service studs');
    expect(b).not.toMatch(/<<<[0-9a-f-]{8,}>>>/i);
  });

  it('the alt study block is structural too — no lockedRefs fallback, no anchor line', () => {
    const b = buildCanonSystemBlock('kaelus-alt');
    expect(b).toContain('Kaelus');
    // No per-character anchor line, and no lockedRefs image PATH is read into the block.
    expect(b).not.toContain('Anchor for this character');
    expect(b).not.toMatch(/\.png/i);
  });
});

describe('buildCharacterLockBlock — character-agnostic lock (Story 2.8)', () => {
  it('emits the identity lock only — no lore, no anchor at prompt-build time', () => {
    const b = buildCharacterLockBlock('kael');
    expect(b).toContain('Identity lock');
    expect(b).toContain('same face');
    expect(b).toMatch(/resolved Higgsfield Element reference/i);
    expect(b).not.toMatch(/Anchor element/);
    expect(b).not.toMatch(/<<<[0-9a-f-]{8,}>>>/i);
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
