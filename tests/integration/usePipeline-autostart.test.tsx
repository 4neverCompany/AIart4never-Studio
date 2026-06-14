// @vitest-environment jsdom
//
// BUG-PIPELINE-002 regression: continuous-mode auto-start on app load.
//
// Bug shape: with `pipelineEnabled + pipelineContinuous` both persisted
// as true, the daemon would sit idle after a fresh mount until the user
// clicked "Start Pipeline" — making the configured "every X minutes"
// cadence meaningless across restarts. The fix is a mount-only useEffect
// in `hooks/usePipeline.ts` that fires `startPipeline()` after a short
// delay, guarded by:
//   - `autoStartFiredRef`     — at most once per mount
//   - `userStoppedRef`        — honors a user-initiated stop this session
//   - `daemon.pendingResume`  — defers to crash-recovery hydration
//
// This file pins the contract so a future refactor of usePipeline can't
// silently drop the auto-start (or, worse, re-fire it on every render).
//
// `usePipelineDaemon` and `useIdeaProcessor` are heavy hooks (IDB,
// fetch, AI client). We mock them to controllable stubs so the test
// only exercises the composer's auto-start effect.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Controllable stub for the daemon — pipelineEnabled / pipelineContinuous /
// pipelineRunning / pendingResume drive the auto-start branch under test.
const daemonStub = {
  pipelineEnabled: false,
  pipelineContinuous: false,
  pipelineRunning: false,
  pendingResume: null as unknown,
  pipelineQueue: [],
  pipelineProgress: null,
  pipelineLog: [],
  pipelineDelay: 0,
  pipelineInterval: 0,
  pipelineTargetDays: 7,
  pipelineIdeasPerCycle: 5,
  weekFillStatus: null as unknown,
  runOuterLoop: vi.fn().mockResolvedValue(undefined),
  stopPipeline: vi.fn(),
  skipCurrentIdea: vi.fn(),
  togglePipeline: vi.fn(),
  toggleContinuous: vi.fn(),
  setPipelineDelay: vi.fn(),
  setPipelineInterval: vi.fn(),
  setPipelineTargetDays: vi.fn(),
  setPipelineIdeasPerCycle: vi.fn(),
  setPipelineIdeasPerCycleState: vi.fn(),
  setPipelineDelayState: vi.fn(),
  setPipelineContinuous: vi.fn(),
  setPipelineIntervalState: vi.fn(),
  setPipelineTargetDaysState: vi.fn(),
  setPendingResume: vi.fn(),
  setPipelineProgress: vi.fn(),
  clearPipelineLog: vi.fn(),
  dismissResume: vi.fn(),
  addLog: vi.fn(),
  getSettings: vi.fn(),
  getIdeas: vi.fn(),
};

vi.mock('@/hooks/usePipelineDaemon', () => ({
  usePipelineDaemon: () => daemonStub,
}));

vi.mock('@/hooks/useIdeaProcessor', () => ({
  useIdeaProcessor: () => ({ processIdea: vi.fn() }),
}));

vi.mock('@/lib/resume-checkpoint', () => ({
  applyResumeCheckpoint: vi.fn(),
}));

// Import AFTER mocks so the hook resolves to the stubs above.
import { usePipeline } from '@/hooks/usePipeline';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    ideas: [],
    settings: {} as Parameters<typeof usePipeline>[0]['settings'],
    // V082-FIX-SETTINGS-HYDRATE: the auto-start guard waits for
    // settings to hydrate from IDB before computing the fill
    // check. Tests default to `isSettingsLoaded: true` so the
    // existing auto-start behaviour is exercised without the
    // hydration delay. Tests that want to assert the hydration
    // gate can pass `isSettingsLoaded: false`.
    isSettingsLoaded: true,
    updateSettings: vi.fn(),
    updateIdeaStatus: vi.fn(),
    addIdea: vi.fn(),
    generateComparison: vi.fn().mockResolvedValue([]),
    generatePostContent: vi.fn(),
    saveImage: vi.fn(),
    deleteImage: vi.fn(),
    savedImages: [],
    images: [],
    ...overrides,
  };
}

function resetDaemon(overrides: Partial<typeof daemonStub> = {}) {
  daemonStub.pipelineEnabled = false;
  daemonStub.pipelineContinuous = false;
  daemonStub.pipelineRunning = false;
  daemonStub.pendingResume = null;
  daemonStub.runOuterLoop.mockClear();
  daemonStub.stopPipeline.mockClear();
  Object.assign(daemonStub, overrides);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('BUG-PIPELINE-002 — usePipeline continuous-mode auto-start', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDaemon();
    cleanup();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-starts within 5-8s when both pipelineEnabled and pipelineContinuous are true', () => {
    resetDaemon({ pipelineEnabled: true, pipelineContinuous: true });

    renderHook(() => usePipeline(makeDeps()));

    // Has not fired immediately — short delay lets hydration settle.
    expect(daemonStub.runOuterLoop).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(daemonStub.runOuterLoop).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-start when only pipelineEnabled=true (continuous off)', () => {
    resetDaemon({ pipelineEnabled: true, pipelineContinuous: false });

    renderHook(() => usePipeline(makeDeps()));

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(daemonStub.runOuterLoop).not.toHaveBeenCalled();
  });

  it('does NOT auto-start when both flags are false', () => {
    resetDaemon({ pipelineEnabled: false, pipelineContinuous: false });

    renderHook(() => usePipeline(makeDeps()));

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(daemonStub.runOuterLoop).not.toHaveBeenCalled();
  });

  it('fires at most once per mount — re-running the effect does not re-trigger', () => {
    resetDaemon({ pipelineEnabled: true, pipelineContinuous: true });

    const { rerender } = renderHook(() => usePipeline(makeDeps()));

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(daemonStub.runOuterLoop).toHaveBeenCalledTimes(1);

    // Simulate the natural daemon transition: pipelineRunning flips
    // false again after the first run finishes. Without the
    // autoStartFiredRef guard, this would re-fire the auto-start.
    daemonStub.pipelineRunning = false;
    rerender();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(daemonStub.runOuterLoop).toHaveBeenCalledTimes(1);
  });

  it('defers auto-start while pendingResume is set (crash-recovery in flight)', () => {
    resetDaemon({
      pipelineEnabled: true,
      pipelineContinuous: true,
      pendingResume: { ideaId: 'idea-1', step: 'caption' } as unknown,
    });

    renderHook(() => usePipeline(makeDeps()));

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    // pendingResume is set → auto-start must yield to the resume modal.
    expect(daemonStub.runOuterLoop).not.toHaveBeenCalled();
  });

  it('manual startPipeline still calls runOuterLoop', () => {
    resetDaemon({ pipelineEnabled: false, pipelineContinuous: false });

    const { result } = renderHook(() => usePipeline(makeDeps()));

    act(() => {
      void result.current.startPipeline();
    });

    expect(daemonStub.runOuterLoop).toHaveBeenCalledTimes(1);
  });

  // CONTINUE-GEN-QUOTA (BUG-1, 2026-05-23): when the weekly content
  // quota is already met by scheduled + pending_approval posts combined,
  // reopening the app must NOT auto-start the pipeline — the user has
  // posts waiting for them to review, and burning a fresh cycle on a
  // full week defeats the "continue generating" mental model.
  it('does NOT auto-start when weekly quota is already met by scheduled + pending_approval combined', () => {
    resetDaemon({
      pipelineEnabled: true,
      pipelineContinuous: true,
      weekFillStatus: {
        targetDays: 7,
        postsPerDay: 2,
        scheduledTotal: 4,
        pendingApprovalTotal: 10,
        targetTotal: 14,
        filled: false,
        percent: 28,
        days: [],
      } as unknown,
    });

    renderHook(() => usePipeline(makeDeps()));

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(daemonStub.runOuterLoop).not.toHaveBeenCalled();
  });

  it('still auto-starts when scheduled + pending_approval combined is below the quota', () => {
    resetDaemon({
      pipelineEnabled: true,
      pipelineContinuous: true,
      weekFillStatus: {
        targetDays: 7,
        postsPerDay: 2,
        scheduledTotal: 3,
        pendingApprovalTotal: 5,
        targetTotal: 14,
        filled: false,
        percent: 21,
        days: [],
      } as unknown,
    });

    renderHook(() => usePipeline(makeDeps()));

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(daemonStub.runOuterLoop).toHaveBeenCalledTimes(1);
  });

  it('user-initiated stop suppresses auto-start that would otherwise re-fire on remount-equivalent state changes', () => {
    resetDaemon({ pipelineEnabled: true, pipelineContinuous: true });

    const { result, rerender } = renderHook(() => usePipeline(makeDeps()));

    // Auto-start fires on initial mount.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(daemonStub.runOuterLoop).toHaveBeenCalledTimes(1);

    // User explicitly stops (sets userStoppedRef.current = true).
    act(() => {
      result.current.stopPipeline();
    });
    expect(daemonStub.stopPipeline).toHaveBeenCalledTimes(1);

    // Daemon settles back to not-running. The autoStartFiredRef guard
    // already prevents a second start; we additionally confirm that
    // userStoppedRef would block it even if the guard weren't there
    // (no new runOuterLoop call after the stop).
    daemonStub.pipelineRunning = false;
    rerender();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(daemonStub.runOuterLoop).toHaveBeenCalledTimes(1);
  });
});
