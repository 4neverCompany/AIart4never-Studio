/**
 * Story 8-12 — persisted TUNED WEEKLY TEMPLATE tests (OAQ-5: local Studio
 * config via @/lib/persistence). Persistence is mocked with an in-memory
 * backing store (per decision-log.test.ts / journal.test.ts) so the
 * save/load/validate/clear logic is exercised without idb-keyval /
 * tauri-plugin-store — the in-memory store doubles as the "app restart"
 * boundary (a fresh load() reads only what was persisted).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/persistence', () => ({
  get: vi.fn(),
  set: vi.fn(),
  __resetStoreForTests: vi.fn(),
}));

import { WEEKLY_TEMPLATE } from '@/lib/canon';
import type { WeeklySlot } from '@/lib/canon';
import {
  TUNED_TEMPLATE_KEY,
  isValidTunedTemplate,
  saveTunedTemplate,
  loadTunedTemplate,
  clearTunedTemplate,
} from '@/lib/growth/tuned-template';
import type { SavedTunedTemplate } from '@/lib/growth/tuned-template';
import type { TunedSlot } from '@/lib/growth';
import * as persistenceModule from '@/lib/persistence';

const persistenceMock = {
  get: persistenceModule.get as ReturnType<typeof vi.fn>,
  set: persistenceModule.set as ReturnType<typeof vi.fn>,
};

let store: Record<string, unknown>;

/** A canon-shaped tuned template with an accepted Friday hour + hook. */
function tunedSlots(): TunedSlot[] {
  return WEEKLY_TEMPLATE.map((slot) =>
    slot.day === 'fri' ? { ...slot, recommendedHour: 19, hookId: 'hook-top' } : { ...slot },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  store = {};
  persistenceMock.get.mockImplementation(async (k: string) => store[k]);
  persistenceMock.set.mockImplementation(async (k: string, v: unknown) => {
    store[k] = v;
  });
});

describe('isValidTunedTemplate — the staleness/invariant guard', () => {
  it('accepts the canon template itself and a tuned superset of it', () => {
    expect(isValidTunedTemplate([...WEEKLY_TEMPLATE])).toBe(true);
    expect(isValidTunedTemplate(tunedSlots())).toBe(true);
  });

  it('rejects a wrong slot count (six-slot invariant)', () => {
    expect(isValidTunedTemplate(tunedSlots().slice(0, 5))).toBe(false);
    expect(isValidTunedTemplate([...tunedSlots(), { ...WEEKLY_TEMPLATE[0]! }])).toBe(false);
  });

  it('rejects structural drift: moved day, reassigned pillar, or a flipped Friday guarantee', () => {
    const movedDay = tunedSlots();
    movedDay[4] = { ...movedDay[4]!, day: 'sat' };
    expect(isValidTunedTemplate(movedDay)).toBe(false);

    const swappedPillar = tunedSlots();
    swappedPillar[0] = { ...swappedPillar[0]!, pillarId: 'story-beat' };
    expect(isValidTunedTemplate(swappedPillar)).toBe(false);

    const flippedGuarantee = tunedSlots();
    flippedGuarantee[4] = { ...flippedGuarantee[4]!, guaranteesNewGen: false };
    expect(isValidTunedTemplate(flippedGuarantee)).toBe(false);
  });

  it('rejects malformed advisory annotations (hour out of range / empty hook)', () => {
    const badHour = tunedSlots();
    badHour[4] = { ...badHour[4]!, recommendedHour: 99 };
    expect(isValidTunedTemplate(badHour)).toBe(false);

    const fractionalHour = tunedSlots();
    fractionalHour[4] = { ...fractionalHour[4]!, recommendedHour: 19.5 };
    expect(isValidTunedTemplate(fractionalHour)).toBe(false);

    const emptyHook = tunedSlots();
    emptyHook[4] = { ...emptyHook[4]!, hookId: '  ' };
    expect(isValidTunedTemplate(emptyHook)).toBe(false);
  });

  it('validates against an injected base — a template saved under an OLDER canon stops validating', () => {
    const oldCanon = tunedSlots(); // valid against today's canon…
    const newCanon: WeeklySlot[] = [
      ...WEEKLY_TEMPLATE,
      { day: 'sat', pillarId: 'lore-poll', format: 'story', guaranteesNewGen: false },
    ];
    // …but canon grew a seventh slot → the saved template is stale.
    expect(isValidTunedTemplate(oldCanon, newCanon)).toBe(false);
  });

  it('rejects non-arrays and junk entries', () => {
    expect(isValidTunedTemplate(undefined)).toBe(false);
    expect(isValidTunedTemplate('corrupted')).toBe(false);
    expect(isValidTunedTemplate([...WEEKLY_TEMPLATE.slice(0, 5), null])).toBe(false);
  });
});

describe('saveTunedTemplate / loadTunedTemplate — the durable round-trip (AC2)', () => {
  it('persists under the decided key and loads back slots + savedAt', async () => {
    await saveTunedTemplate(tunedSlots(), 1234);
    expect(store[TUNED_TEMPLATE_KEY]).toBeDefined();

    const loaded = await loadTunedTemplate();
    expect(loaded).not.toBeNull();
    expect(loaded!.savedAt).toBe(1234);
    expect(loaded!.slots).toHaveLength(WEEKLY_TEMPLATE.length);
    const friday = loaded!.slots.find((s) => s.day === 'fri')!;
    expect(friday.recommendedHour).toBe(19);
    expect(friday.hookId).toBe('hook-top');
    expect(friday.guaranteesNewGen).toBe(true); // Friday guarantee intact through the store
  });

  it('normalizes on save: only the canon structure + advisory annotations persist', async () => {
    // An AdaptedSlot-ish input with extra growth fields must not leak into the store.
    const rich = tunedSlots().map((s) => ({
      ...s,
      adapted: true,
      rationale: 'why',
      hourBasis: 'top',
    })) as unknown as TunedSlot[];
    await saveTunedTemplate(rich, 1);
    const stored = store[TUNED_TEMPLATE_KEY] as SavedTunedTemplate;
    const allowed = new Set(['day', 'pillarId', 'format', 'guaranteesNewGen', 'recommendedHour', 'hookId']);
    for (const slot of stored.slots) {
      const extras = Object.keys(slot).filter((k) => !allowed.has(k));
      expect(extras).toEqual([]);
      expect(slot).not.toHaveProperty('adapted');
      expect(slot).not.toHaveProperty('rationale');
      expect(slot).not.toHaveProperty('hourBasis');
    }
  });

  it('save is STRICT: an invariant-violating template throws and writes nothing', async () => {
    const broken = tunedSlots();
    broken[4] = { ...broken[4]!, guaranteesNewGen: false }; // flip the Friday guarantee
    await expect(saveTunedTemplate(broken, 1)).rejects.toThrow(/canon template invariants/);
    expect(persistenceMock.set).not.toHaveBeenCalled();
    expect(await loadTunedTemplate()).toBeNull();
  });

  it('cold start (nothing stored) → null (AC4)', async () => {
    expect(await loadTunedTemplate()).toBeNull();
  });

  it('tolerates a corrupt stored value → null, never a crash', async () => {
    store[TUNED_TEMPLATE_KEY] = 'corrupted';
    expect(await loadTunedTemplate()).toBeNull();

    store[TUNED_TEMPLATE_KEY] = { slots: 'nope', savedAt: 1 };
    expect(await loadTunedTemplate()).toBeNull();

    store[TUNED_TEMPLATE_KEY] = { slots: tunedSlots(), savedAt: 'yesterday' };
    expect(await loadTunedTemplate()).toBeNull();

    persistenceMock.get.mockRejectedValueOnce(new Error('store unavailable'));
    expect(await loadTunedTemplate()).toBeNull();
  });

  it('a stored template that no longer matches the CURRENT canon shape → null (stale-canon guard)', async () => {
    store[TUNED_TEMPLATE_KEY] = { slots: tunedSlots().slice(0, 5), savedAt: 1 } satisfies SavedTunedTemplate;
    expect(await loadTunedTemplate()).toBeNull();
  });
});

describe('clearTunedTemplate — the explicit revert to canon', () => {
  it('after clear, load returns null (the planner falls back to canon)', async () => {
    await saveTunedTemplate(tunedSlots(), 1);
    expect(await loadTunedTemplate()).not.toBeNull();
    await clearTunedTemplate();
    expect(await loadTunedTemplate()).toBeNull();
  });
});
