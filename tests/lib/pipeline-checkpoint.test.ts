// SHOULDFIX-001: pipeline-checkpoint wraps idb-keyval with a best-effort
// error-swallowing boundary. Tests cover the happy-path roundtrip and the
// "IDB threw" behavior — a bad storage layer must never break callers.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PipelineCheckpoint } from '@/lib/pipeline-checkpoint';

// Module-level mock store that our vi.mock factory references.
const store = new Map<unknown, unknown>();
let shouldThrow: 'none' | 'get' | 'set' | 'del' = 'none';

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: unknown) => {
    if (shouldThrow === 'get') throw new Error('idb get failed');
    return store.get(key);
  }),
  set: vi.fn(async (key: unknown, value: unknown) => {
    if (shouldThrow === 'set') throw new Error('idb set failed');
    store.set(key, value);
  }),
  del: vi.fn(async (key: unknown) => {
    if (shouldThrow === 'del') throw new Error('idb del failed');
    store.delete(key);
  }),
}));

// Import AFTER vi.mock so the mock is in place.
const { saveCheckpoint, loadCheckpoint, clearCheckpoint } = await import('@/lib/pipeline-checkpoint');

const sampleCheckpoint: PipelineCheckpoint = {
  ideaId: 'idea-abc',
  step: 'Captioning',
  concept: 'Sherlock Holmes meets Dune',
  ts: '2026-04-18T12:00:00Z',
  settings: { delay: 30, continuous: true, interval: 60, targetDays: 7 },
  imageIds: ['img-1', 'img-2'],
};

describe('pipeline-checkpoint', () => {
  beforeEach(() => {
    store.clear();
    shouldThrow = 'none';
  });

  it('saveCheckpoint then loadCheckpoint roundtrips the exact object', async () => {
    await saveCheckpoint(sampleCheckpoint);
    const loaded = await loadCheckpoint();
    expect(loaded).toEqual(sampleCheckpoint);
  });

  it('loadCheckpoint returns null when nothing has been saved', async () => {
    const loaded = await loadCheckpoint();
    expect(loaded).toBeNull();
  });

  it('clearCheckpoint wipes so a subsequent load returns null', async () => {
    await saveCheckpoint(sampleCheckpoint);
    await clearCheckpoint();
    const loaded = await loadCheckpoint();
    expect(loaded).toBeNull();
  });

  it('loadCheckpoint swallows IDB errors and returns null', async () => {
    shouldThrow = 'get';
    // Must resolve, not throw — storage failure cannot break the caller.
    const loaded = await loadCheckpoint();
    expect(loaded).toBeNull();
  });

  it('saveCheckpoint swallows IDB errors (best-effort)', async () => {
    shouldThrow = 'set';
    await expect(saveCheckpoint(sampleCheckpoint)).resolves.toBeUndefined();
  });

  it('clearCheckpoint swallows IDB errors (best-effort)', async () => {
    shouldThrow = 'del';
    await expect(clearCheckpoint()).resolves.toBeUndefined();
  });

  it('saveCheckpoint overwrites a previous checkpoint', async () => {
    await saveCheckpoint(sampleCheckpoint);
    const updated: PipelineCheckpoint = {
      ...sampleCheckpoint,
      step: 'Generating images',
      imageIds: ['img-1', 'img-2', 'img-3'],
    };
    await saveCheckpoint(updated);
    const loaded = await loadCheckpoint();
    expect(loaded?.step).toBe('Generating images');
    expect(loaded?.imageIds).toHaveLength(3);
  });
});
