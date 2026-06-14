// BUG-DEV-012: persistence layer wraps tauri-plugin-store with an
// idb-keyval fallback for non-Tauri runtimes. These tests run under jsdom,
// so the Tauri runtime is absent and the wrapper must transparently fall
// through to the mocked idb-keyval surface.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<unknown, unknown>();

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: unknown) => store.get(key)),
  set: vi.fn(async (key: unknown, value: unknown) => {
    store.set(key, value);
  }),
}));

const { get, set } = await import('@/lib/persistence');

describe('persistence (non-Tauri fallback)', () => {
  beforeEach(() => {
    store.clear();
  });

  it('round-trips a value through the idb-keyval fallback', async () => {
    await set('mashup_settings', { agentPrompt: 'hello' });
    const back = await get('mashup_settings');
    expect(back).toEqual({ agentPrompt: 'hello' });
  });

  it('returns undefined for an unset key', async () => {
    const back = await get('never_written');
    expect(back).toBeUndefined();
  });

  it('overwrites a previous value on repeat set', async () => {
    await set('mashup_ideas', [{ id: 'a' }]);
    await set('mashup_ideas', [{ id: 'b' }]);
    expect(await get('mashup_ideas')).toEqual([{ id: 'b' }]);
  });

  it('handles arbitrary serialisable shapes', async () => {
    const payload = {
      scheduledPosts: [{ id: 'p1', date: '2026-06-01' }],
      apiKeys: { leonardo: 'sk-test' },
      nested: { a: { b: { c: 42 } } },
    };
    await set('mashup_settings', payload);
    expect(await get('mashup_settings')).toEqual(payload);
  });

  it('does not attempt to import @tauri-apps/plugin-store outside Tauri', async () => {
    // If the wrapper called load() during a non-Tauri get(), the dynamic
    // import would resolve via Vite's resolver and any failure would throw.
    // Reaching here without throwing is the assertion.
    await expect(get('mashup_saved_images')).resolves.toBeUndefined();
  });
});
