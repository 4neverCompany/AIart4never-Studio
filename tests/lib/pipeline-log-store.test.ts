// V030-003: pipeline-log-store wraps idb-keyval for crash-surviving log
// persistence. Tests cover the happy-path roundtrip (including Date ↔ ISO
// serialization), the 50-entry cap, and the "IDB threw" swallow behavior.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PipelineLogEntry } from '@/types/mashup';

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

const { savePipelineLog, loadPipelineLog, clearPipelineLog } = await import(
  '@/lib/pipeline-log-store'
);

function makeEntry(i: number, status: 'success' | 'error' = 'success'): PipelineLogEntry {
  return {
    timestamp: new Date(2026, 3, 18, 12, 0, i),
    step: `step-${i}`,
    ideaId: `idea-${i}`,
    status,
    message: `message-${i}`,
  };
}

describe('pipeline-log-store', () => {
  beforeEach(() => {
    store.clear();
    shouldThrow = 'none';
  });

  it('saves then loads the same entries with Date fields intact', async () => {
    const entries = [makeEntry(0), makeEntry(1, 'error'), makeEntry(2)];
    await savePipelineLog(entries);
    const loaded = await loadPipelineLog();
    expect(loaded).toHaveLength(3);
    expect(loaded[0].timestamp).toBeInstanceOf(Date);
    expect(loaded[0].timestamp.getTime()).toBe(entries[0].timestamp.getTime());
    expect(loaded[1].status).toBe('error');
    expect(loaded[2].ideaId).toBe('idea-2');
  });

  it('returns an empty array when nothing has been saved', async () => {
    const loaded = await loadPipelineLog();
    expect(loaded).toEqual([]);
  });

  it('clearPipelineLog wipes so a subsequent load returns []', async () => {
    await savePipelineLog([makeEntry(0)]);
    await clearPipelineLog();
    const loaded = await loadPipelineLog();
    expect(loaded).toEqual([]);
  });

  it('trims to the last 50 entries when the input exceeds the cap', async () => {
    const entries = Array.from({ length: 75 }, (_, i) => makeEntry(i));
    await savePipelineLog(entries);
    const loaded = await loadPipelineLog();
    expect(loaded).toHaveLength(50);
    // Oldest entries (0-24) should have been dropped; newest (25-74) kept.
    expect(loaded[0].step).toBe('step-25');
    expect(loaded[49].step).toBe('step-74');
  });

  it('savePipelineLog swallows IDB errors (best-effort)', async () => {
    shouldThrow = 'set';
    await expect(savePipelineLog([makeEntry(0)])).resolves.toBeUndefined();
  });

  it('loadPipelineLog swallows IDB errors and returns []', async () => {
    shouldThrow = 'get';
    const loaded = await loadPipelineLog();
    expect(loaded).toEqual([]);
  });

  it('clearPipelineLog swallows IDB errors (best-effort)', async () => {
    shouldThrow = 'del';
    await expect(clearPipelineLog()).resolves.toBeUndefined();
  });

  it('loadPipelineLog returns [] when the stored value is not an array', async () => {
    store.set('mashup_pipeline_log', { not: 'an array' });
    const loaded = await loadPipelineLog();
    expect(loaded).toEqual([]);
  });

  it('saving an empty array produces an empty load (no corruption)', async () => {
    await savePipelineLog([makeEntry(0)]);
    await savePipelineLog([]);
    const loaded = await loadPipelineLog();
    expect(loaded).toEqual([]);
  });

  it('entries at exactly 50 are stored without trimming', async () => {
    const entries = Array.from({ length: 50 }, (_, i) => makeEntry(i));
    await savePipelineLog(entries);
    const loaded = await loadPipelineLog();
    expect(loaded).toHaveLength(50);
    expect(loaded[0].step).toBe('step-0');
    expect(loaded[49].step).toBe('step-49');
  });
});
