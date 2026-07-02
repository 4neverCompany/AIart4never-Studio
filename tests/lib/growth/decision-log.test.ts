/**
 * Story 8-11 — tuning DECISION LOG tests (append-only audit of accepted
 * changes). Persistence is mocked with an in-memory backing store (per
 * tests/lib/autonomy/journal.test.ts) so the append/cap/read logic is
 * exercised without idb-keyval / tauri-plugin-store.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/persistence', () => ({
  get: vi.fn(),
  set: vi.fn(),
  __resetStoreForTests: vi.fn(),
}));

import {
  TUNING_DECISION_LOG_KEY,
  TUNING_DECISION_CAP,
  appendTuningDecisions,
  readTuningDecisions,
} from '@/lib/growth/decision-log';
import type { RecordedTuningChange } from '@/lib/growth/decision-log';
import * as persistenceModule from '@/lib/persistence';

const persistenceMock = {
  get: persistenceModule.get as ReturnType<typeof vi.fn>,
  set: persistenceModule.set as ReturnType<typeof vi.fn>,
};

let store: Record<string, unknown>;

function change(decidedAt: number, over: Partial<RecordedTuningChange> = {}): RecordedTuningChange {
  return {
    proposalId: 'hour:fri:story-beat',
    kind: 'posting-hour',
    day: 'fri',
    pillarId: 'story-beat',
    recommendedValue: 19,
    appliedValue: 19,
    edited: false,
    decidedAt,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  store = {};
  persistenceMock.get.mockImplementation(async (k: string) => store[k]);
  persistenceMock.set.mockImplementation(async (k: string, v: unknown) => {
    store[k] = v;
  });
});

describe('appendTuningDecisions', () => {
  it('persists under the log key and accumulates oldest-first (batch append)', async () => {
    await appendTuningDecisions([change(1)]);
    await appendTuningDecisions([change(2), change(3, { proposalId: 'hook:fri:story-beat', kind: 'hook', recommendedValue: 'hook-top', appliedValue: 'my-hook', edited: true })]);
    const stored = store[TUNING_DECISION_LOG_KEY] as RecordedTuningChange[];
    expect(stored.map((c) => c.decidedAt)).toEqual([1, 2, 3]);
    // The edited record keeps both the recommendation and the applied value.
    expect(stored[2]).toMatchObject({ recommendedValue: 'hook-top', appliedValue: 'my-hook', edited: true });
  });

  it('an empty batch is a no-op (nothing written)', async () => {
    const out = await appendTuningDecisions([]);
    expect(out).toEqual([]);
    expect(persistenceMock.set).not.toHaveBeenCalled();
  });

  it('tolerates a corrupt (non-array) stored value', async () => {
    store[TUNING_DECISION_LOG_KEY] = 'corrupted';
    const out = await appendTuningDecisions([change(1)]);
    expect(out.map((c) => c.decidedAt)).toEqual([1]);
  });

  it('caps at the most recent TUNING_DECISION_CAP entries', async () => {
    for (let i = 1; i <= TUNING_DECISION_CAP + 5; i++) {
      await appendTuningDecisions([change(i)]);
    }
    const stored = store[TUNING_DECISION_LOG_KEY] as RecordedTuningChange[];
    expect(stored).toHaveLength(TUNING_DECISION_CAP);
    expect(stored[0]!.decidedAt).toBe(6);
    expect(stored[stored.length - 1]!.decidedAt).toBe(TUNING_DECISION_CAP + 5);
  });
});

describe('readTuningDecisions', () => {
  it('returns most-recent-first', async () => {
    await appendTuningDecisions([change(1)]);
    await appendTuningDecisions([change(2)]);
    await appendTuningDecisions([change(3)]);
    const out = await readTuningDecisions();
    expect(out.map((c) => c.decidedAt)).toEqual([3, 2, 1]);
  });

  it('returns [] when nothing stored', async () => {
    expect(await readTuningDecisions()).toEqual([]);
  });
});
