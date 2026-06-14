// @vitest-environment jsdom
//
// V091-QA-FOLLOWUP — wiring contract for `pipelineIdeasPerCycle`.
//
// QA flagged that the new ideas/cycle control had no test asserting
// the round-trip: input → state → persistence → reload. This file
// covers the daemon side end-to-end (state setter, clamp, localStorage
// round-trip across unmount/remount). The PipelinePanel wiring side is
// pinned in tests/components/PipelinePanel-ideasPerCycle-pin.test.ts.

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePipelineDaemon } from '@/hooks/usePipelineDaemon';
import type { Idea, UserSettings, GeneratedImage } from '@/types/mashup';

const PIPELINE_STORAGE_KEY = 'mashup_pipeline_state';

function makeDeps() {
  return {
    ideas: [] as Idea[],
    settings: {} as UserSettings,
    images: [] as GeneratedImage[],
    savedImages: [] as GeneratedImage[],
    addIdea: () => {},
    updateIdeaStatus: () => {},
  };
}

describe('usePipelineDaemon — pipelineIdeasPerCycle wiring (PIPELINE-CONT-V2)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to 5 when localStorage is empty', () => {
    const { result } = renderHook(() => usePipelineDaemon(makeDeps()));
    expect(result.current.pipelineIdeasPerCycle).toBe(5);
  });

  it('setter updates state and clamps to [1, 10]', () => {
    const { result } = renderHook(() => usePipelineDaemon(makeDeps()));

    act(() => result.current.setPipelineIdeasPerCycle(7));
    expect(result.current.pipelineIdeasPerCycle).toBe(7);

    // Below min → clamped to 1.
    act(() => result.current.setPipelineIdeasPerCycle(-1));
    expect(result.current.pipelineIdeasPerCycle).toBe(1);

    // Above max → clamped to 10.
    act(() => result.current.setPipelineIdeasPerCycle(99));
    expect(result.current.pipelineIdeasPerCycle).toBe(10);
  });

  it('persists across unmount/remount via mashup_pipeline_state', () => {
    const { result, unmount } = renderHook(() =>
      usePipelineDaemon(makeDeps()),
    );
    act(() => result.current.setPipelineIdeasPerCycle(8));

    // The persistence effect runs synchronously after the state commit,
    // so by the time setPipelineIdeasPerCycle returns and React has
    // flushed, localStorage already has the new value.
    const persisted = JSON.parse(localStorage.getItem(PIPELINE_STORAGE_KEY) || '{}');
    expect(persisted.ideasPerCycle).toBe(8);

    unmount();

    // Fresh mount → reads persisted value, NOT the default.
    const remount = renderHook(() => usePipelineDaemon(makeDeps()));
    expect(remount.result.current.pipelineIdeasPerCycle).toBe(8);
  });

  it('falls back to default 5 when persisted value is missing the field', () => {
    // Simulate a pre-V2 user whose persisted blob has every other field
    // but no ideasPerCycle. The loader must fill the default in.
    localStorage.setItem(
      PIPELINE_STORAGE_KEY,
      JSON.stringify({
        enabled: true,
        delay: 30,
        continuous: true,
        interval: 120,
        targetDays: 7,
      }),
    );
    const { result } = renderHook(() => usePipelineDaemon(makeDeps()));
    expect(result.current.pipelineIdeasPerCycle).toBe(5);
  });
});
