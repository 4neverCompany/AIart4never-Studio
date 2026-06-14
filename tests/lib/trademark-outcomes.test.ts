import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getOutcome,
  setOutcome,
  getAllBlocked,
  genericFor,
  addUserWhitelist,
  removeUserWhitelist,
  isUserWhitelisted,
  getAllUserWhitelisted,
  isEffectivelyBlocked,
  planStagedSubstitution,
  __resetForTests,
} from '@/lib/trademark-outcomes';

// Two representative model ids the production code emits today.
const MODEL_LEONARDO = 'nano-banana-2';
const MODEL_GPT = 'gpt-image-2';

function setupLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  });
  return store;
}

describe('trademark-outcomes store (per-model)', () => {
  beforeEach(() => {
    setupLocalStorage();
    __resetForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns "unknown" for unseeded names (no seed in per-model store)', () => {
    expect(getOutcome('Batman', MODEL_LEONARDO)).toBe('unknown');
    expect(getOutcome('Spider-Man', MODEL_LEONARDO)).toBe('unknown');
    expect(getOutcome('SomeNewCharacter', MODEL_LEONARDO)).toBe('unknown');
  });

  it('persists setOutcome between calls, scoped to (name, modelId)', () => {
    setOutcome('Batman', 'blocked', MODEL_LEONARDO);
    expect(getOutcome('Batman', MODEL_LEONARDO)).toBe('blocked');
    // Other model is unaffected — that is the whole point of issue 2.
    expect(getOutcome('Batman', MODEL_GPT)).toBe('unknown');
  });

  it('"blocked" markings are sticky per (name, modelId) — "allowed" cannot overwrite them on the same model', () => {
    setOutcome('Batman', 'blocked', MODEL_LEONARDO);
    setOutcome('Batman', 'allowed', MODEL_LEONARDO);
    expect(getOutcome('Batman', MODEL_LEONARDO)).toBe('blocked');
  });

  it('blocking a name on one model does NOT block it on another model', () => {
    setOutcome('Warhammer', 'blocked', MODEL_LEONARDO);
    expect(getOutcome('Warhammer', MODEL_LEONARDO)).toBe('blocked');
    expect(getOutcome('Warhammer', MODEL_GPT)).toBe('unknown');
    // And learning on GPT later doesn't disturb the Leonardo block.
    setOutcome('Warhammer', 'allowed', MODEL_GPT);
    expect(getOutcome('Warhammer', MODEL_GPT)).toBe('allowed');
    expect(getOutcome('Warhammer', MODEL_LEONARDO)).toBe('blocked');
  });

  it('"allowed" markings can move to "blocked" on the same model', () => {
    setOutcome('Yoda', 'allowed', MODEL_LEONARDO);
    expect(getOutcome('Yoda', MODEL_LEONARDO)).toBe('allowed');
    setOutcome('Yoda', 'blocked', MODEL_LEONARDO);
    expect(getOutcome('Yoda', MODEL_LEONARDO)).toBe('blocked');
  });

  it('getAllBlocked(modelId) returns names blocked for that model only', () => {
    setOutcome('Batman', 'blocked', MODEL_LEONARDO);
    setOutcome('Warhammer', 'blocked', MODEL_GPT);
    setOutcome('Yoda', 'allowed', MODEL_LEONARDO);

    expect(getAllBlocked(MODEL_LEONARDO)).toEqual(['Batman']);
    expect(getAllBlocked(MODEL_GPT)).toEqual(['Warhammer']);
  });

  it('getAllBlocked() with no modelId returns the union (any name blocked anywhere)', () => {
    setOutcome('Batman', 'blocked', MODEL_LEONARDO);
    setOutcome('Warhammer', 'blocked', MODEL_GPT);
    setOutcome('Yoda', 'allowed', MODEL_LEONARDO);

    const union = getAllBlocked();
    expect(union).toContain('Batman');
    expect(union).toContain('Warhammer');
    expect(union).not.toContain('Yoda');
  });
});

describe('legacy migration', () => {
  beforeEach(() => {
    setupLocalStorage();
    __resetForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('wipes the v1 storage keys on first v2 read', () => {
    window.localStorage.setItem('mashup_trademark_outcomes', '{"Spider-Man":"blocked"}');
    window.localStorage.setItem('mashup_trademark_user_whitelist', '["Mandalorian"]');

    // First read triggers the one-shot wipe.
    expect(getOutcome('Spider-Man', MODEL_LEONARDO)).toBe('unknown');
    expect(window.localStorage.getItem('mashup_trademark_outcomes')).toBeNull();
    expect(window.localStorage.getItem('mashup_trademark_user_whitelist')).toBeNull();
  });
});

describe('genericFor', () => {
  beforeEach(() => {
    setupLocalStorage();
    __resetForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a visually-distinctive curated generic for known names', () => {
    // TRADEMARK-SURGICAL-REWRITE (2026-05-21): generics enriched to
    // preserve visual identity per Maurice's "generic descriptions are
    // NOT acceptable — they lose what makes the character distinct" rule.
    // Assert STRUCTURAL shape (key visual cues present) rather than
    // verbatim wording so future tuning doesn't break the suite.
    const spider = genericFor('Spider-Man');
    expect(spider).toMatch(/red and blue/i);
    expect(spider).toMatch(/spider/i);

    const grogu = genericFor('Grogu');
    expect(grogu).toMatch(/green/i);
    expect(grogu).toMatch(/alien/i);

    const astartes = genericFor('Astartes');
    expect(astartes).toMatch(/armored/i);
    expect(astartes).toMatch(/sci-fi|super-soldier/i);
  });

  it('case-insensitive lookup returns the same enriched generic', () => {
    expect(genericFor('SPIDER-MAN')).toBe(genericFor('Spider-Man'));
    expect(genericFor('grogu')).toBe(genericFor('Grogu'));
  });

  it('falls back to a permissive default for unknown names', () => {
    expect(genericFor('SomeFutureCharacter')).toBe('a popular character');
  });
});

describe('TRADEMARK-STAGED-PIPELINE (2026-05-22): user whitelist', () => {
  beforeEach(() => {
    setupLocalStorage();
    __resetForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('addUserWhitelist + isUserWhitelisted + getAllUserWhitelisted round-trip', () => {
    expect(isUserWhitelisted('Mandalorian')).toBe(false);
    addUserWhitelist('Mandalorian');
    expect(isUserWhitelisted('Mandalorian')).toBe(true);
    expect(getAllUserWhitelisted()).toContain('Mandalorian');
  });

  it('addUserWhitelist is idempotent', () => {
    addUserWhitelist('Mandalorian');
    addUserWhitelist('Mandalorian');
    expect(getAllUserWhitelisted().filter((n) => n === 'Mandalorian')).toHaveLength(1);
  });

  it('removeUserWhitelist deletes the entry', () => {
    addUserWhitelist('Mandalorian');
    removeUserWhitelist('Mandalorian');
    expect(isUserWhitelisted('Mandalorian')).toBe(false);
    expect(getAllUserWhitelisted()).not.toContain('Mandalorian');
  });

  it('whitelisting a blocked name hides it from getAllBlocked across models', () => {
    setOutcome('Spider-Man', 'blocked', MODEL_LEONARDO);
    expect(getAllBlocked(MODEL_LEONARDO)).toContain('Spider-Man');
    addUserWhitelist('Spider-Man');
    expect(getAllBlocked(MODEL_LEONARDO)).not.toContain('Spider-Man');
    expect(getAllBlocked()).not.toContain('Spider-Man');
    // The auto outcome itself is preserved — the whitelist is an
    // override at the read sites, not an erase of history.
    expect(getOutcome('Spider-Man', MODEL_LEONARDO)).toBe('blocked');
  });

  it('isEffectivelyBlocked respects the whitelist per model', () => {
    setOutcome('Mandalorian', 'blocked', MODEL_LEONARDO);
    expect(isEffectivelyBlocked('Mandalorian', MODEL_LEONARDO)).toBe(true);
    // A different model that hasn't seen it returns false (unknown).
    expect(isEffectivelyBlocked('Mandalorian', MODEL_GPT)).toBe(false);
    addUserWhitelist('Mandalorian');
    expect(isEffectivelyBlocked('Mandalorian', MODEL_LEONARDO)).toBe(false);
  });
});

describe('planStagedSubstitution — TRADEMARK-STAGED-PIPELINE (per-model)', () => {
  beforeEach(() => {
    setupLocalStorage();
    __resetForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when the prompt has no trademark names', () => {
    expect(planStagedSubstitution('an original character on a hill', MODEL_LEONARDO)).toBeNull();
  });

  it('prefers names with outcome="blocked" for the same model over other extracted names', () => {
    // The prompt mentions two trademark names; Spider-Man is blocked
    // on MODEL_LEONARDO. Plan must target Spider-Man, not Yoda.
    setOutcome('Spider-Man', 'blocked', MODEL_LEONARDO);
    setOutcome('Yoda', 'allowed', MODEL_LEONARDO);
    const plan = planStagedSubstitution('Spider-Man fights Yoda in the rain', MODEL_LEONARDO);
    expect(plan).not.toBeNull();
    expect(plan!.targetName).toBe('Spider-Man');
  });

  it('IGNORES blocks recorded for a different model when planning for this model', () => {
    // Block Spider-Man for MODEL_LEONARDO but plan for MODEL_GPT —
    // the picker should fall back to longest-extracted (Spider-Man)
    // since neither name is blocked on MODEL_GPT.
    setOutcome('Spider-Man', 'blocked', MODEL_LEONARDO);
    const plan = planStagedSubstitution('Spider-Man fights Yoda in the rain', MODEL_GPT);
    expect(plan).not.toBeNull();
    // No tier-1 candidates for GPT → fall through to longest extracted
    // (Spider-Man, 10 chars vs Yoda, 4 chars).
    expect(plan!.targetName).toBe('Spider-Man');
  });

  it('falls back to longest extracted name when nothing is outcome="blocked" for this model', () => {
    // No name in this prompt has outcome="blocked" — Iron Man and
    // Mandalorian are both unknown by default. Picker prefers the
    // longer canonical (Mandalorian, 11 chars).
    const plan = planStagedSubstitution('a Mandalorian beside Thor in a forest', MODEL_LEONARDO);
    expect(plan).not.toBeNull();
    expect(plan!.targetName).toBe('Mandalorian');
  });

  it('stage2Prompt swaps target with the minimal placeholder', () => {
    setOutcome('Spider-Man', 'blocked', MODEL_LEONARDO);
    const plan = planStagedSubstitution(
      'Spider-Man swinging through Tokyo at night',
      MODEL_LEONARDO,
    );
    expect(plan).not.toBeNull();
    expect(plan!.stage2Prompt).toContain('a character');
    expect(plan!.stage2Prompt).not.toContain('Spider-Man');
    expect(plan!.stage2Prompt).toContain('swinging through Tokyo at night');
  });

  it('stage3Prompt swaps target with the rich GENERIC_FOR descriptor', () => {
    setOutcome('Spider-Man', 'blocked', MODEL_LEONARDO);
    const plan = planStagedSubstitution(
      'Spider-Man swinging through Tokyo at night',
      MODEL_LEONARDO,
    );
    expect(plan).not.toBeNull();
    expect(plan!.stage3Prompt).not.toContain('Spider-Man');
    expect(plan!.stage3Prompt).toMatch(/spider/i);
    expect(plan!.stage3Prompt).toContain('swinging through Tokyo at night');
  });

  it('skips user-whitelisted names entirely — returns null when only whitelisted names match', () => {
    addUserWhitelist('Mandalorian');
    expect(
      planStagedSubstitution('the Mandalorian rides his speeder', MODEL_LEONARDO),
    ).toBeNull();
  });

  it('skips user-whitelisted names — picks a non-whitelisted alternative', () => {
    // Spider-Man is blocked. User whitelists Spider-Man. Plan must
    // fall back to the only other trademark name in the prompt (Yoda),
    // not pick Spider-Man.
    setOutcome('Spider-Man', 'blocked', MODEL_LEONARDO);
    addUserWhitelist('Spider-Man');
    const plan = planStagedSubstitution('Spider-Man fights Yoda in the rain', MODEL_LEONARDO);
    expect(plan).not.toBeNull();
    expect(plan!.targetName).toBe('Yoda');
  });

  it('returns null when the prompt has only user-whitelisted blocked names', () => {
    setOutcome('Spider-Man', 'blocked', MODEL_LEONARDO);
    addUserWhitelist('Spider-Man');
    expect(planStagedSubstitution('Spider-Man poses for a photo', MODEL_LEONARDO)).toBeNull();
  });
});
