'use client';

import { useCallback, useEffect, useRef } from 'react';
import { applyResumeCheckpoint } from '@/lib/resume-checkpoint';
import { usePipelineDaemon, type PipelineResumeHint } from './usePipelineDaemon';
import { useIdeaProcessor } from './useIdeaProcessor';
import type { Idea, UserSettings, GeneratedImage, GenerateOptions } from '../types/mashup';

interface UsePipelineDeps {
  ideas: Idea[];
  settings: UserSettings;
  /**
   * V082-FIX-SETTINGS-HYDRATE: settings are loaded from IDB on mount
   * (useSettings). The default state has an empty scheduledPosts
   * array, so any auto-start logic that reads scheduledPosts before
   * hydration finishes will think the week's quota is unmet and fire
   * a generation cycle. Callers should pass `isSettingsLoaded` from
   * useSettings so the auto-start can wait for hydration.
   *
   * Optional with a default of `true` so existing tests + callers
   * keep working without the prop (the new auto-start gate is
   * opt-in via the dep).
   */
  isSettingsLoaded?: boolean;
  updateSettings: (
    newSettings: Partial<UserSettings> | ((prev: UserSettings) => Partial<UserSettings>),
  ) => void;
  updateIdeaStatus: (id: string, status: 'idea' | 'in-work' | 'done') => void;
  addIdea: (concept: string, context?: string) => void;
  generateComparison: (
    prompt: string,
    modelIds: string[],
    options?: GenerateOptions,
    cachedEnhancements?: Record<string, import('./useComparison').CachedEnhancement>,
  ) => Promise<GeneratedImage[]>;
  generatePostContent: (image: GeneratedImage) => Promise<GeneratedImage | undefined>;
  saveImage: (img: GeneratedImage) => void;
  /** Used by the skip-cleanup path to purge orphaned pipeline images. */
  deleteImage: (id: string, fromSaved: boolean) => unknown;
  savedImages: GeneratedImage[];
  images: GeneratedImage[];
}

/**
 * V030-001: thin composer over usePipelineDaemon + useIdeaProcessor.
 * Public surface (20 fields) unchanged — MashupContextType consumers don't
 * see the split. See docs/bmad/stories/V030-001.md for the design.
 */
export function usePipeline(deps: UsePipelineDeps) {
  const {
    ideas,
    settings,
    isSettingsLoaded,
    updateSettings,
    updateIdeaStatus,
    addIdea,
    generateComparison,
    generatePostContent,
    saveImage,
    deleteImage,
    savedImages,
    images,
  } = deps;

  const daemon = usePipelineDaemon({
    ideas,
    settings,
    images,
    savedImages,
    addIdea,
    updateIdeaStatus,
  });

  const processor = useIdeaProcessor({
    getSettings: daemon.getSettings,
    generateComparison,
    generatePostContent,
    saveImage,
    updateIdeaStatus,
    updateSettings,
    addLog: daemon.addLog,
    setPipelineProgress: daemon.setPipelineProgress,
  });

  // Tracks whether the user has explicitly stopped the pipeline this
  // session. Used by the auto-start effect below so a user-initiated
  // stop is honored — even when `pipelineEnabled + pipelineContinuous`
  // are both still true (those are persisted preferences, not session
  // state). Reset on every fresh mount so the next app launch will
  // auto-start again per the persisted settings.
  const userStoppedRef = useRef(false);
  // One-shot guard so the auto-start fires at most once per mount.
  // Without this, the effect would re-fire whenever `pipelineRunning`
  // flips back to false (e.g. after the run loop's natural exit) and
  // start a fresh run the user didn't ask for.
  const autoStartFiredRef = useRef(false);

  const startPipeline = useCallback(
    (resumeHint?: PipelineResumeHint) => {
      userStoppedRef.current = false;
      return daemon.runOuterLoop(processor.processIdea, resumeHint);
    },
    [daemon, processor.processIdea],
  );

  const stopPipeline = useCallback(() => {
    userStoppedRef.current = true;
    daemon.stopPipeline();
  }, [daemon]);

  /**
   * Skip + cleanup. Aborts the current idea via the daemon, then
   * deletes any pipeline-produced images that were stamped with this
   * idea's id (so approved-but-then-skipped generations don't linger
   * as grayed-out pipelinePending entries) and drops their not-yet-
   * posted ScheduledPosts. Already-posted entries are left alone so
   * the history view still shows them.
   */
  const skipCurrentIdea = useCallback(() => {
    const currentIdeaId = daemon.pipelineProgress?.currentIdeaId;
    daemon.skipCurrentIdea();
    if (!currentIdeaId) return;
    const orphaned = savedImages.filter((i) => i.sourceIdeaId === currentIdeaId);
    for (const img of orphaned) deleteImage(img.id, true);
    updateSettings((prev) => ({
      scheduledPosts: (prev.scheduledPosts || []).filter(
        (p) => p.sourceIdeaId !== currentIdeaId || p.status === 'posted',
      ),
    }));
  }, [daemon, savedImages, deleteImage, updateSettings]);

  const acceptResume = useCallback(() => {
    applyResumeCheckpoint(daemon.pendingResume, {
      setPipelineDelayState: daemon.setPipelineDelayState,
      setPipelineContinuous: daemon.setPipelineContinuous,
      setPipelineIntervalState: daemon.setPipelineIntervalState,
      setPipelineTargetDaysState: daemon.setPipelineTargetDaysState,
      getIdeas: daemon.getIdeas,
      // V050-001: live reader over the saved gallery so the resume helper
      // can hydrate pre-generated images from checkpoint.imageIds.
      getSavedImages: () => savedImages,
      updateIdeaStatus,
      setPendingResume: daemon.setPendingResume,
      startPipeline,
    });
  }, [daemon, updateIdeaStatus, startPipeline, savedImages]);

  // Auto-start in continuous mode after mount. When the user has
  // persisted `pipelineEnabled + pipelineContinuous` and closes/reopens
  // the app, the daemon would otherwise sit idle until they manually
  // clicked "Start Pipeline" — making the configured "every X minutes"
  // cadence meaningless across restarts. Fires at most once per mount,
  // honors a session-scoped userStoppedRef, and waits for the resume-
  // checkpoint hydration effect (which sets `pendingResume` async on
  // mount) so a recoverable crash isn't trampled by a fresh auto-start.
  //
  // CONTINUE-GEN-QUOTA (BUG-1, 2026-05-23): also skip auto-start when
  // the weekly content quota is already met by `scheduled` +
  // `pending_approval` posts combined. The user's mental model is
  // "if my week is full, don't generate more" — regardless of whether
  // those posts are awaiting approval. Without this gate, reopening
  // the app with a queue full of pending approvals would burn a fresh
  // cycle of ideas + image gen on a week that has nothing left to fill.
  // The daemon's pre-cycle check at the start of every cycle uses the
  // same fill measure, but it only fires AFTER runOuterLoop has spun
  // up; gating here avoids the start-up cost entirely.
  //
  // V082-FIX-SETTINGS-HYDRATE: also wait for `isSettingsLoaded` to
  // flip true before computing the fill check. On a cold mount,
  // settings start as defaultSettings (scheduledPosts = []), so the
  // pre-cycle check would evaluate to "0/7 posts, not full" and
  // auto-start a generation cycle — even if the IDB-loaded reality is
  // "7/7 already scheduled". The 2s setTimeout below isn't enough
  // when IDB takes a beat, and the daemon's own pre-cycle check only
  // runs AFTER runOuterLoop starts up (wasting the first cycle).
  // Gating on isSettingsLoaded here means we wait for the real
  // scheduledPosts to land before we make the start/no-start call.
  const quotaAlreadyMet = (() => {
    const fill = daemon.weekFillStatus;
    if (!fill) return false;
    return fill.scheduledTotal + fill.pendingApprovalTotal >= fill.targetTotal;
  })();
  useEffect(() => {
    if (autoStartFiredRef.current) return;
    if (!isSettingsLoaded) return;
    if (!daemon.pipelineEnabled || !daemon.pipelineContinuous) return;
    if (daemon.pipelineRunning) return;
    if (userStoppedRef.current) return;
    if (daemon.pendingResume) return;
    if (quotaAlreadyMet) return;
    // Short delay lets settings hydration / pendingResume async load
    // settle before we kick off a run; keeps the effect from racing
    // those mount-time effects in usePipelineDaemon.
    const timer = setTimeout(() => {
      if (autoStartFiredRef.current) return;
      if (!isSettingsLoaded) return;
      if (!daemon.pipelineEnabled || !daemon.pipelineContinuous) return;
      if (daemon.pipelineRunning) return;
      if (userStoppedRef.current) return;
      if (daemon.pendingResume) return;
      if (quotaAlreadyMet) return;
      autoStartFiredRef.current = true;
      void startPipeline();
    }, 2000);
    return () => clearTimeout(timer);
  }, [
    isSettingsLoaded,
    daemon.pipelineEnabled,
    daemon.pipelineContinuous,
    daemon.pipelineRunning,
    daemon.pendingResume,
    quotaAlreadyMet,
    startPipeline,
  ]);

  return {
    pipelineEnabled: daemon.pipelineEnabled,
    pipelineRunning: daemon.pipelineRunning,
    pipelineQueue: daemon.pipelineQueue,
    pipelineProgress: daemon.pipelineProgress,
    pipelineLog: daemon.pipelineLog,
    pipelineDelay: daemon.pipelineDelay,
    setPipelineDelay: daemon.setPipelineDelay,
    togglePipeline: daemon.togglePipeline,
    startPipeline,
    stopPipeline,
    skipCurrentIdea,
    pipelineContinuous: daemon.pipelineContinuous,
    toggleContinuous: daemon.toggleContinuous,
    pipelineInterval: daemon.pipelineInterval,
    setPipelineInterval: daemon.setPipelineInterval,
    pipelineTargetDays: daemon.pipelineTargetDays,
    setPipelineTargetDays: daemon.setPipelineTargetDays,
    pipelineIdeasPerCycle: daemon.pipelineIdeasPerCycle,
    setPipelineIdeasPerCycle: daemon.setPipelineIdeasPerCycle,
    clearPipelineLog: daemon.clearPipelineLog,
    pendingResume: daemon.pendingResume,
    acceptResume,
    dismissResume: daemon.dismissResume,
    weekFillStatus: daemon.weekFillStatus,
  };
}
