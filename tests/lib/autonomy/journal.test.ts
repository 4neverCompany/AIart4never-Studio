/**
 * M2 autonomy loop — JOURNAL (append-only audit) tests.
 *
 * Persistence is mocked with an in-memory backing store (per
 * tests/lib/mcp/registry.test.ts) so the append/cap/read logic is exercised
 * without idb-keyval / tauri-plugin-store.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/persistence', () => ({
  get: vi.fn(),
  set: vi.fn(),
  __resetStoreForTests: vi.fn(),
}));

import {
  AUTONOMY_JOURNAL_KEY,
  JOURNAL_CAP,
  appendTick,
  readJournal,
} from '@/lib/autonomy/journal';
import type { AutonomyTickResult } from '@/lib/autonomy/types';
import * as persistenceModule from '@/lib/persistence';

const persistenceMock = {
  get: persistenceModule.get as ReturnType<typeof vi.fn>,
  set: persistenceModule.set as ReturnType<typeof vi.fn>,
};

let store: Record<string, unknown>;

function tick(at: number, over: Partial<AutonomyTickResult> = {}): AutonomyTickResult {
  return {
    at,
    day: 'fri',
    decision: 'generate',
    queued: true,
    note: `tick ${at}`,
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

describe('appendTick', () => {
  it('persists under the journal key and accumulates oldest-first', async () => {
    await appendTick(tick(1));
    await appendTick(tick(2));
    expect(store[AUTONOMY_JOURNAL_KEY]).toBeDefined();
    const stored = store[AUTONOMY_JOURNAL_KEY] as AutonomyTickResult[];
    expect(stored.map((t) => t.at)).toEqual([1, 2]);
  });

  it('tolerates a corrupt (non-array) stored value', async () => {
    store[AUTONOMY_JOURNAL_KEY] = 'corrupted';
    const out = await appendTick(tick(1));
    expect(out.map((t) => t.at)).toEqual([1]);
  });

  it('caps at the most recent JOURNAL_CAP entries', async () => {
    for (let i = 1; i <= JOURNAL_CAP + 5; i++) {
      await appendTick(tick(i));
    }
    const stored = store[AUTONOMY_JOURNAL_KEY] as AutonomyTickResult[];
    expect(stored).toHaveLength(JOURNAL_CAP);
    // Oldest 5 dropped; the most recent entry is the last appended.
    expect(stored[0]!.at).toBe(6);
    expect(stored[stored.length - 1]!.at).toBe(JOURNAL_CAP + 5);
  });
});

describe('readJournal', () => {
  it('returns most-recent-first', async () => {
    await appendTick(tick(1));
    await appendTick(tick(2));
    await appendTick(tick(3));
    const out = await readJournal();
    expect(out.map((t) => t.at)).toEqual([3, 2, 1]);
  });

  it('returns [] when nothing stored', async () => {
    expect(await readJournal()).toEqual([]);
  });
});
