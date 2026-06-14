// V1.1.1-CAMERA-ANGLE-CLEAR: regression test for the `clearSettings`
// hook returned from `useSettings`. This is the parent-side primitive
// the SettingsModal uses to actually drop a setting key (e.g. when the
// CameraAnglePicker emits `undefined` to mean "clear"). The
// `mergeSettings` helper strips `undefined` patches by design, so
// without this hook, a `updateSettings({ cameraAngle: undefined })`
// call leaves the key in place — which is the bug we're closing.
//
// The contract:
//   1. `clearSettings([...keys])` removes each named key from settings.
//   2. Other keys (including nested objects like `watermark`) are preserved.
//   3. `clearSettings` is stable across renders (useCallback with [] deps).
//   4. Persisting after `clearSettings` actually writes the cleared
//      state to IDB — the next mount should not see the key resurrected.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSettings } from '@/hooks/useSettings';
import { defaultSettings } from '@/types/mashup';

// Mute the load path so renderHook starts from the in-memory defaults.
// `get` and `set` are pulled from '@/lib/persistence' (Tauri plugin in
// production, idb-keyval in dev/test). The Settings modal's debounced
// save triggers a set call; we spy on it instead of going through the
// real IDB. The `skipFirstSaveRef` inside useSettings skips the
// initial mount-time save, so the first non-load set is the one we
// want to observe.
vi.mock('@/lib/persistence', () => ({
  get: vi.fn(async () => null),
  set: vi.fn(async () => undefined),
}));

import { set as persistenceSet } from '@/lib/persistence';
const setMock = persistenceSet as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  setMock.mockClear();
  // jsdom doesn't ship localStorage in the harness by default; the
  // load path checks `localStorage.getItem('mashup_settings')` and
  // short-circuits to IDB if it's empty. We give it an empty entry
  // so the migration path is exercised — the result is the same
  // (defaults), but it covers both branches in the load flow.
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSettings — clearSettings', () => {
  it('removes a single top-level key from settings', async () => {
    const { result } = renderHook(() => useSettings());
    // Wait for the load effect to settle.
    await act(async () => {
      await Promise.resolve();
    });

    // Seed: set a cameraAngle so we can confirm it gets cleared.
    act(() => {
      result.current.updateSettings({ cameraAngle: 'low-anonymous' });
    });
    expect(result.current.settings.cameraAngle).toBe('low-anonymous');

    // Clear it via the new primitive.
    act(() => {
      result.current.clearSettings(['cameraAngle']);
    });
    // Key is removed: the value is now undefined, not the default.
    expect(result.current.settings.cameraAngle).toBeUndefined();
  });

  it('removes multiple keys in a single call without touching other fields', async () => {
    const { result } = renderHook(() => useSettings());
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.updateSettings({
        cameraAngle: 'low-anonymous',
        defaultVideoModel: 'kling-3.0',
        antiAiLook: true,
      });
    });
    expect(result.current.settings.cameraAngle).toBe('low-anonymous');
    expect(result.current.settings.defaultVideoModel).toBe('kling-3.0');
    expect(result.current.settings.antiAiLook).toBe(true);

    act(() => {
      result.current.clearSettings(['cameraAngle', 'defaultVideoModel']);
    });
    // Both cleared.
    expect(result.current.settings.cameraAngle).toBeUndefined();
    expect(result.current.settings.defaultVideoModel).toBeUndefined();
    // Untouched keys stay put.
    expect(result.current.settings.antiAiLook).toBe(true);
    // Nested objects (e.g. watermark) stay put too.
    expect(result.current.settings.watermark).toEqual(defaultSettings.watermark);
  });

  it('is stable across renders (useCallback with [] deps)', async () => {
    const { result, rerender } = renderHook(() => useSettings());
    await act(async () => {
      await Promise.resolve();
    });
    const initial = result.current.clearSettings;
    rerender();
    expect(result.current.clearSettings).toBe(initial);
  });

  it('persists the cleared state to the debounced IDB sink', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSettings());
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.updateSettings({ cameraAngle: 'low-anonymous' });
    });
    // Flush the 300ms debounce so the write actually happens.
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });

    setMock.mockClear();

    act(() => {
      result.current.clearSettings(['cameraAngle']);
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });

    // The cleared state (no cameraAngle key) was persisted.
    expect(setMock).toHaveBeenCalled();
    const lastCall = setMock.mock.calls[setMock.mock.calls.length - 1];
    const persisted = lastCall[1] as Record<string, unknown>;
    expect(persisted.cameraAngle).toBeUndefined();
  });
});
