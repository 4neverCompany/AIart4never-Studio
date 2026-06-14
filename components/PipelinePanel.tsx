'use client';

import { useCallback, useState } from 'react';
import { shouldAutoContinuePipeline } from '@/lib/approval-continue';
import { motion, AnimatePresence } from 'motion/react';
import {
  Play,
  Square,
  ChevronDown,
  ChevronUp,
  Loader2,
  CheckCircle2,
  XCircle,
  Zap,
  Clock,
  Lightbulb,
  Check,
  RefreshCw,
} from 'lucide-react';
import { useMashup } from './MashupContext';
import type { ScheduledPost, UserSettings } from '@/types/mashup';
import { isPlatformAutoApproved } from '@/lib/pipeline-daemon-utils';
import { isPlatformConfigured } from '@/lib/platform-credentials';
import { UndoToast } from './UndoToast';
import { useDesktopConfig } from '@/hooks/useDesktopConfig';
import {
  countAffectedPosts,
  applyPlatformToggleToExistingPosts,
} from '@/lib/pipeline-platforms-sync';
import { BestTimesWidget } from './pipeline/BestTimesWidget';
import { ActiveIdeaCard } from './pipeline/ActiveIdeaCard';
import { ApprovalQueue } from './pipeline/ApprovalQueue';
import { WeekProgressMeter } from './pipeline/WeekProgressMeter';
import { STAGES } from './pipeline/stages';
import { ManualGenerationPanel } from './Studio/ManualGenerationPanel';
import { type GeneratedImage } from '@/types/mashup';

type PipelinePlatform = 'instagram' | 'pinterest' | 'twitter' | 'discord';

const STEP_LABELS: Record<string, string> = {
  'status-update':   'Status',
  'trending':        'Trending',
  'prompt-expand':   'Prompt',
  'image-gen':       'Image Gen',
  'image-ready':     'Ready',
  'auto-generate':   'Auto-Gen',
  'caption':         'Caption',
  'schedule':        'Schedule',
  'post':            'Post',
  'engagement':      'Engagement',
  'daemon':          'Daemon',
  'pi-precheck':     'Pre-Check',
  'pipeline-start':  'Start',
  'pipeline-stop':   'Stop',
  'pipeline-skip':   'Skip',
  'pipeline-cycle':  'Cycle',
  'pipeline-end':    'End',
  'pipeline-error':  'Error',
  'pipeline-timeout':    'Timeout',
  'pipeline-week-filled': 'Week Filled',
  'pipeline-week-confirmed': 'Week Confirmed',
  'pipeline-week-partial':   'Week Partial',
  'complete':        'Complete',
};

export function PipelinePanel() {
  const {
    pipelineEnabled,
    pipelineRunning,
    pipelineQueue,
    pipelineProgress,
    pipelineLog,
    clearPipelineLog,
    pipelineDelay,
    setPipelineDelay,
    togglePipeline,
    startPipeline,
    stopPipeline,
    skipCurrentIdea,
    ideas,
    settings,
    updateSettings,
    images,
    setImages,
    savedImages,
    approveScheduledPost,
    rejectScheduledPost,
    bulkApproveScheduledPosts,
    bulkRejectScheduledPosts,
    updateScheduledPostsCaption,
    pipelineContinuous,
    toggleContinuous,
    pipelineInterval,
    setPipelineInterval,
    pipelineTargetDays,
    setPipelineTargetDays,
    pipelineIdeasPerCycle,
    setPipelineIdeasPerCycle,
    weekFillStatus,
  } = useMashup();

  // V040-006: after a bulk approve/reject, show a 10s undo toast so a
  // mis-click on the big "Approve All" / "Reject Selected" buttons is
  // recoverable. Snapshots are captured from `settings.scheduledPosts`
  // *before* dispatching the bulk mutation, and merged back via
  // updateSettings when the user clicks Undo.
  const [undoState, setUndoState] = useState<
    | { kind: 'approve' | 'reject'; snapshots: ScheduledPost[] }
    | null
  >(null);

  const undoBulkAction = useCallback(() => {
    setUndoState((current) => {
      if (!current) return null;
      const snapById = new Map(current.snapshots.map((s) => [s.id, s]));
      updateSettings((prev) => {
        const currentPosts = prev.scheduledPosts || [];
        const existingIds = new Set(currentPosts.map((p) => p.id));
        // Approve undo: posts still in list with status='scheduled' —
        // restore from snapshot (flips back to pending_approval).
        // Reject undo: posts were removed — re-append the snapshots.
        // Guard: if a post already moved to 'posted' or 'failed' in
        // the undo window (auto-poster fired), skip it to avoid a
        // misleading restore.
        const restored = currentPosts.map((p) => {
          const snap = snapById.get(p.id);
          if (!snap) return p;
          if (p.status === 'posted' || p.status === 'failed') return p;
          return snap;
        });
        const toAppend = current.snapshots.filter((s) => !existingIds.has(s.id));
        return { scheduledPosts: [...restored, ...toAppend] };
      });
      return null;
    });
  }, [updateSettings]);

  // V030-005: after a bulk approval, kick off the pipeline when the
  // window still has gaps and there are ideas left to process. Keeps
  // single-item approvals passive — see lib/approval-continue.ts.
  const onBulkApproveWithAutoContinue = useCallback(
    (ids: string[]) => {
      const snapshots = (settings.scheduledPosts || []).filter(
        (p) => ids.includes(p.id) && p.status === 'pending_approval',
      );
      bulkApproveScheduledPosts(ids);
      setUndoState({ kind: 'approve', snapshots });
      if (
        shouldAutoContinuePipeline({
          pipelineRunning,
          isBulk: ids.length > 1,
          approvedCount: ids.length,
          weekFilled: weekFillStatus.filled,
          pendingIdeaCount: ideas.filter(i => i.status === 'idea').length,
        })
      ) {
        startPipeline();
      }
    },
    [
      bulkApproveScheduledPosts,
      pipelineRunning,
      weekFillStatus.filled,
      ideas,
      startPipeline,
      settings.scheduledPosts,
    ],
  );

  const onBulkRejectWithUndo = useCallback(
    (ids: string[]) => {
      const snapshots = (settings.scheduledPosts || []).filter((p) => ids.includes(p.id));
      bulkRejectScheduledPosts(ids);
      setUndoState({ kind: 'reject', snapshots });
    },
    [bulkRejectScheduledPosts, settings.scheduledPosts],
  );

  const { isDesktop, credentials: desktopCreds } = useDesktopConfig();

  const [logExpanded, setLogExpanded] = useState(true);
  const [queueExpanded, setQueueExpanded] = useState(true);
  const [logErrorsOnly, setLogErrorsOnly] = useState(false);

  const pendingIdeas = ideas.filter((i) => i.status === 'idea');
  const reversedLog = [...pipelineLog].reverse();
  const errorCount = pipelineLog.filter((e) => e.status === 'error').length;
  const displayLog = logErrorsOnly ? reversedLog.filter((e) => e.status === 'error') : reversedLog;

  const autoTag = settings.pipelineAutoTag ?? true;
  const autoCaption = settings.pipelineAutoCaption ?? true;
  const autoSchedule = settings.pipelineAutoSchedule ?? true;
  const platforms: PipelinePlatform[] = (settings.pipelinePlatforms as PipelinePlatform[]) || [];

  const hasCreds = (p: PipelinePlatform): boolean =>
    isPlatformConfigured(p, settings, isDesktop ? desktopCreds : undefined);
  const availablePlatforms: PipelinePlatform[] = (['instagram', 'pinterest', 'twitter', 'discord'] as PipelinePlatform[]).filter(hasCreds);

  // V1.7.0-PRE-PROD-FIX: when the user toggles a platform OFF, ask
  // whether the change should also apply to existing scheduled posts.
  // Without this, every post scheduled with the platform enabled keeps
  // posting to it (Maurice's bug: disabled Pinterest in Pipeline tab,
  // the auto-poster still sent old posts to Pinterest). The defensive
  // `filterPlatformsBySetting` in lib/pipeline-platforms-sync.ts is a
  // safety net for posts that slip through; this dialog is the
  // user-facing fix.
  const togglePlatform = (p: PipelinePlatform) => {
    const isDisabling = platforms.includes(p);
    const next = isDisabling ? platforms.filter((x) => x !== p) : [...platforms, p];

    if (isDisabling) {
      const counts = countAffectedPosts(settings.scheduledPosts || [], p);
      if (counts.total > 0) {
        const summary: string[] = [];
        if (counts.scheduled) summary.push(`${counts.scheduled} scheduled`);
        if (counts.pending_approval) summary.push(`${counts.pending_approval} pending approval`);
        if (counts.posted) summary.push(`${counts.posted} already posted`);
        if (counts.failed) summary.push(`${counts.failed} failed`);
        const countsLine = summary.length > 0 ? `\n\n${summary.join(', ')}.` : '';
        const applyToExisting = window.confirm(
          `Disable ${p}?${countsLine}\n\n` +
            `OK — Remove ${p} from these ${counts.total} existing scheduled post(s) too. They will no longer post to ${p}.\n\n` +
            `Cancel — Only new posts will skip ${p}; existing posts keep posting to it.`,
        );
        if (applyToExisting) {
          // Apply the toggle to the setting AND to existing posts.
          updateSettings((prev) => ({
            pipelinePlatforms: next,
            scheduledPosts: applyPlatformToggleToExistingPosts(
              prev.scheduledPosts || [],
              p,
            ),
          }));
          return;
        }
        // User chose "only new posts" — just the setting.
        updateSettings({ pipelinePlatforms: next });
        return;
      }
    }
    // Toggling ON, or toggling OFF with no existing posts affected.
    updateSettings({ pipelinePlatforms: next });
  };

  const autoApprove = settings.pipelineAutoApprove || {};
  const setAutoApprove = (p: PipelinePlatform, value: boolean) => {
    updateSettings({ pipelineAutoApprove: { ...autoApprove, [p]: value } });
  };

  const dailyCaps = settings.pipelineDailyCaps || {};
  const setDailyCap = (p: PipelinePlatform, value: number | null) => {
    const next: typeof dailyCaps = { ...dailyCaps };
    if (value == null || Number.isNaN(value)) {
      delete next[p];
    } else {
      next[p] = Math.max(1, Math.min(99, value));
    }
    updateSettings({ pipelineDailyCaps: next });
  };

  const toggleStage = (key: 'pipelineAutoTag' | 'pipelineAutoCaption' | 'pipelineAutoSchedule') => {
    const current = settings[key];
    const defaults: Record<string, boolean> = {
      pipelineAutoTag: true,
      pipelineAutoCaption: true,
      pipelineAutoSchedule: true,
    };
    const effective = current ?? defaults[key];
    updateSettings({ [key]: !effective } as Partial<UserSettings>);
  };

  const activeStageKey = (() => {
    if (!pipelineProgress || !pipelineRunning) return null;
    const step = pipelineProgress.currentStep || '';
    for (const stage of STAGES) {
      if (stage.matchStep && step.toLowerCase().includes(stage.matchStep.toLowerCase())) {
        return stage.key;
      }
    }
    return null;
  })();

  return (
    <div className="max-w-5xl mx-auto space-y-4 sm:space-y-6">
      {/* V1.3.5: Manual generation panel — unified UI for ALL providers
          (Higgsfield, Leonardo, MiniMax) with provider/model picker,
          aspect ratio, resolution, prompt, and per-provider dispatch.
          Rendered prominently at the top of the Studio so users can
          generate content with any provider without going through
          the AI agent loop. The result is added to the gallery and
          persisted to disk (lib/images/storage). */}
      <ManualGenerationPanel
        onImageGenerated={(img) => {
          // Forward into the gallery state via the MashupContext.
          // The same context the AI-agent pipeline uses, so manual
          // generations show up alongside pipeline output.
          setImages((prev: GeneratedImage[]) => [
            {
              ...img,
              status: 'ready' as const,
            } as GeneratedImage,
            ...prev,
          ])
        }}
      />

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-[#00e6ff]/10 border border-[#00e6ff]/25 flex items-center justify-center shrink-0">
          <Zap className="w-4 h-4 sm:w-5 sm:h-5 text-[#00e6ff]" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="type-title truncate">Ideas-to-Content Pipeline</h2>
          <p className="text-[11px] sm:text-sm text-zinc-400 leading-snug">
            Automatically process ideas into images, captions, and scheduled posts
          </p>
        </div>
      </div>

      {/* Stage flow visualization */}
      <div className="card p-3 sm:p-5">
        <div className="space-y-2 sm:space-y-4">
          {STAGES.map((stage, idx) => {
            const isActive = activeStageKey === stage.key;
            const isCompleted = idx < STAGES.findIndex(s => s.key === activeStageKey);
            return (
              <motion.div
                key={stage.key}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: idx * 0.05 }}
                className={`relative p-2.5 sm:p-4 rounded-xl border overflow-hidden transition-colors duration-200 ${
                  isActive ? 'bg-[#050505]/90 border-[#00e6ff]/40 shadow-[0_0_18px_rgba(0,230,255,0.10)]' :
                  isCompleted ? 'bg-[#050505]/70 border-[#c5a062]/30' : 'bg-[#050505]/80 border-[#c5a062]/15'
                }`}
              >
                {/* Shared-layout glow — spring-animates between active stages */}
                {isActive && (
                  <motion.div
                    layoutId="active-stage-bg"
                    className="absolute inset-0 bg-[#00e6ff]/8 shadow-[inset_0_0_16px_rgba(0,230,255,0.06)]"
                    transition={{ type: 'spring', stiffness: 400, damping: 35 }}
                  />
                )}
                <div className="relative flex items-center gap-3">
                  {isActive ? (
                    <div className="relative w-3 h-3">
                      <div className={`absolute inset-0 ${stage.dotColor} rounded-full animate-ping motion-reduce:animate-none`} />
                      <div className={`relative ${stage.dotColor} w-3 h-3 rounded-full`} />
                    </div>
                  ) : (
                    <div className={`w-3 h-3 rounded-full ${isCompleted ? stage.dotColor : 'bg-zinc-700'}`} />
                  )}
                  <span className={`text-sm font-medium ${isActive ? 'text-[#00e6ff]' : isCompleted ? 'text-white' : 'text-zinc-500'}`}>
                    {stage.label}
                  </span>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>

      {/* Controls */}
      <div className="card p-4 sm:p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-zinc-300">Pipeline</span>
            <button
              onClick={togglePipeline}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                pipelineEnabled ? 'bg-[#00e6ff]' : 'bg-zinc-700'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  pipelineEnabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                pipelineEnabled ? 'bg-[#00e6ff]/15 text-[#00e6ff]' : 'bg-zinc-800 text-zinc-500'
              }`}
            >
              {pipelineEnabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {!pipelineRunning ? (
              <button
                onClick={startPipeline}
                disabled={!pipelineEnabled}
                className="btn-primary disabled:bg-zinc-900/80 disabled:text-zinc-600 disabled:shadow-none"
              >
                <Play className="w-4 h-4" />
                Start Pipeline
              </button>
            ) : (
              <button
                onClick={stopPipeline}
                className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-sm font-medium rounded-xl transition-colors"
              >
                <Square className="w-4 h-4" />
                Stop
              </button>
            )}
          </div>
        </div>

        {/* Delay config */}
        <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-[#c5a062]/15">
          <Clock className="w-4 h-4 text-zinc-500" />
          <span className="text-sm text-zinc-400">Delay between ideas:</span>
          <input
            type="number"
            min={5}
            max={300}
            value={pipelineDelay}
            onChange={(e) =>
              setPipelineDelay(Math.max(5, Math.min(300, Number(e.target.value))))
            }
            className="w-20 px-2 py-1 bg-zinc-900 border border-[#c5a062]/25 rounded-xl text-sm text-white text-center focus:outline-none focus:ring-2 focus:ring-[#00e6ff]/30 focus:border-[#00e6ff]/40 transition-colors"
          />
          <span className="text-sm text-zinc-500">seconds</span>
        </div>

        {/* Continuous mode */}
        <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-[#c5a062]/15">
          <RefreshCw className="w-4 h-4 text-zinc-500" />
          <span className="text-sm text-zinc-400">Continuous mode</span>
          <button
            onClick={toggleContinuous}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              pipelineContinuous ? 'bg-[#00e6ff]' : 'bg-zinc-700'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                pipelineContinuous ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
          {pipelineContinuous && (
            // V082-PIPELINE-RESPONSIVE / STORY-012 — keep "Every X min" and
            // "target Y days ahead" as inseparable groups so the row wraps
            // semantically at 390px instead of breaking inside a phrase.
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="flex items-center gap-2">
                <span className="text-sm text-zinc-500">Every</span>
                <input
                  type="number"
                  min={120}
                  max={1440}
                  value={pipelineInterval}
                  onChange={(e) => setPipelineInterval(Math.max(120, Math.min(1440, Number(e.target.value))))}
                  className="w-20 px-2 py-1 bg-zinc-900 border border-[#c5a062]/25 rounded-xl text-sm text-white text-center focus:outline-none focus:ring-2 focus:ring-[#00e6ff]/30 focus:border-[#00e6ff]/40 transition-colors"
                />
                <span className="text-sm text-zinc-500">min</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-zinc-500">target</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={pipelineTargetDays}
                  onChange={(e) => setPipelineTargetDays(Math.max(1, Math.min(30, Number(e.target.value))))}
                  className="w-16 px-2 py-1 bg-zinc-900 border border-[#c5a062]/25 rounded-xl text-sm text-white text-center focus:outline-none focus:ring-2 focus:ring-[#00e6ff]/30 focus:border-[#00e6ff]/40 transition-colors"
                />
                <span className="text-sm text-zinc-500">days ahead</span>
              </div>
              {/* PIPELINE-CONT-V2: configurable ideas/cycle so the daemon
                  can sustain a full week even when posts get rejected. */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-zinc-500">ideas/cycle</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={pipelineIdeasPerCycle}
                  onChange={(e) => setPipelineIdeasPerCycle(Math.max(1, Math.min(10, Number(e.target.value))))}
                  className="w-16 px-2 py-1 bg-zinc-900 border border-[#c5a062]/25 rounded-xl text-sm text-white text-center focus:outline-none focus:ring-2 focus:ring-[#00e6ff]/30 focus:border-[#00e6ff]/40 transition-colors"
                />
              </div>
            </div>
          )}
        </div>

        {/* V030-004: week-ahead progress meter */}
        <WeekProgressMeter />

        {/* V082-WEEK-FULL-BANNER: when continuous mode is armed but the
            weekly quota is met (no pending approvals), show an
            emerald "Week full" callout so the user understands why
            nothing is happening. Distinct from the pending-approval
            indicator below (which surfaces a backlog, not a done
            state). Tells the user: "your week is full, the daemon
            is sleeping until the next horizon roll-over." */}
        {pipelineContinuous &&
          pipelineEnabled &&
          weekFillStatus.scheduledTotal + weekFillStatus.pendingApprovalTotal >=
            weekFillStatus.targetTotal &&
          weekFillStatus.pendingApprovalTotal === 0 && (
            <div
              data-testid="pipeline-week-full-banner"
              className="flex items-start gap-3 px-4 py-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
            >
              <CheckCircle2 className="w-4 h-4 text-emerald-300 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-emerald-200">
                  Week full — pipeline is paused
                </p>
                <p className="text-[11px] text-emerald-200/80 mt-0.5 leading-relaxed">
                  {weekFillStatus.scheduledTotal}/{weekFillStatus.targetTotal} posts scheduled
                  across the next {weekFillStatus.targetDays} days. The daemon will resume
                  generating once the next slot opens up — no new ideas are being created
                  in the meantime.
                </p>
              </div>
            </div>
          )}

        {/* PIPELINE-CONT-V2: pending-approval indicator. Surfaces the
            backlog that the daemon will keep generating against until
            it's cleared (approved → scheduled, or rejected). */}
        {weekFillStatus.pendingApprovalTotal > 0 && (
          <p className="text-sm text-amber-400">
            {weekFillStatus.pendingApprovalTotal} pending approval
          </p>
        )}

        {/* Best posting times */}
        <BestTimesWidget settings={settings} />

        {/* Stage toggles */}
        <div className="pt-2 border-t border-[#c5a062]/15 space-y-2">
          <p className="label-overline">Stages</p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {[
              { key: 'pipelineAutoTag' as const, label: 'Auto-tag images', value: autoTag },
              { key: 'pipelineAutoCaption' as const, label: 'Auto-caption', value: autoCaption },
              { key: 'pipelineAutoSchedule' as const, label: 'Auto-schedule posts', value: autoSchedule },
            ].map((opt) => (
              <label
                key={opt.key}
                className="flex items-center gap-2 px-3 py-2 bg-zinc-800/40 border border-[#c5a062]/15 rounded-xl cursor-pointer hover:border-[#c5a062]/35 hover:bg-zinc-800/60 transition-all duration-200"
              >
                <input
                  type="checkbox"
                  checked={opt.value}
                  onChange={() => toggleStage(opt.key)}
                  className="w-4 h-4 accent-[#00e6ff]"
                />
                <span className="text-sm text-zinc-300">{opt.label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Carousel mode — collapses all images from one idea into a single carousel post */}
        <div className="pt-2 border-t border-[#c5a062]/15 space-y-2">
          <label className="flex items-start gap-2 px-3 py-2 bg-zinc-800/40 border border-[#c5a062]/15 rounded-xl cursor-pointer hover:border-[#c5a062]/35 hover:bg-zinc-800/60 transition-all duration-200">
            <input
              type="checkbox"
              checked={settings.pipelineCarouselMode ?? false}
              onChange={() =>
                updateSettings({ pipelineCarouselMode: !(settings.pipelineCarouselMode ?? false) })
              }
              className="mt-0.5 w-4 h-4 accent-emerald-500"
            />
            <div className="flex-1">
              <p className="text-sm text-zinc-200">Carousel mode</p>
              <p className="text-[11px] text-zinc-500 leading-snug">
                Group all ready images from an idea into one carousel post (shared caption + slot).
                Always schedules first — auto-post fires when the slot hits, never immediately after generation.
              </p>
            </div>
          </label>

          <label className="flex items-start gap-2 px-3 py-2 bg-zinc-800/40 border border-[#c5a062]/15 rounded-xl cursor-pointer hover:border-[#c5a062]/35 hover:bg-zinc-800/60 transition-all duration-200">
            <input
              type="checkbox"
              checked={settings.pipelineThemedBatches ?? false}
              onChange={() =>
                updateSettings({ pipelineThemedBatches: !(settings.pipelineThemedBatches ?? false) })
              }
              className="mt-0.5 w-4 h-4 accent-emerald-500"
            />
            <div className="flex-1">
              <p className="text-sm text-zinc-200">Themed idea batches</p>
              <p className="text-[11px] text-zinc-500 leading-snug">
                Auto-generate ideas as one shared theme + N variations instead of random unrelated ideas.
              </p>
            </div>
          </label>
        </div>

        {/* Platform picker — shown whenever scheduling is on. Auto-post
            was removed in V060-004 (every pipeline post lands as
            pending_approval, then publishes via the approval flow), so
            the picker now only depends on autoSchedule. */}
        {autoSchedule && (
          <div className="pt-2 border-t border-[#c5a062]/15 space-y-2">
            <p className="label-overline">Platforms</p>
            {availablePlatforms.length === 0 ? (
              <p className="text-[11px] text-amber-400">
                No platform credentials configured. Add Instagram or Pinterest keys in Settings.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {availablePlatforms.map((p) => {
                  const checked = platforms.includes(p);
                  const colour =
                    p === 'instagram'
                      ? 'bg-pink-600'
                      : p === 'pinterest'
                        ? 'bg-red-600'
                        : p === 'twitter'
                          ? 'bg-sky-600'
                          : 'bg-indigo-600';
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => togglePlatform(p)}
                      className={`px-2.5 py-1 text-[10px] rounded-full border transition-colors ${
                        checked
                          ? `${colour} text-white border-transparent`
                          : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:border-zinc-500'
                      }`}
                    >
                      {checked && <Check className="w-3 h-3 inline mr-1" />}
                      {p}
                    </button>
                  );
                })}
              </div>
            )}
            {availablePlatforms.length > 0 && platforms.length === 0 && (
              <p className="text-[11px] text-amber-400">
                Pick at least one platform — pipeline will skip scheduling otherwise.
              </p>
            )}
          </div>
        )}

        {/* Per-platform approval gating (V040-008) */}
        <div className="pt-2 border-t border-[#c5a062]/15 space-y-2">
          <div className="flex items-center justify-between">
            <p className="label-overline">Auto-Approve (per platform)</p>
            <span className="text-[10px] text-zinc-500">off = manual review</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {(['instagram', 'pinterest', 'twitter', 'discord'] as PipelinePlatform[]).map((p) => {
              const isAuto = isPlatformAutoApproved(p, autoApprove);
              const colour =
                p === 'instagram'
                  ? 'text-pink-300 border-pink-500/30'
                  : p === 'pinterest'
                    ? 'text-red-300 border-red-500/30'
                    : p === 'twitter'
                      ? 'text-sky-300 border-sky-500/30'
                      : 'text-indigo-300 border-indigo-500/30';
              return (
                <label
                  key={p}
                  className={`flex items-center gap-2 px-3 py-2 bg-zinc-800/40 border rounded-xl cursor-pointer hover:bg-zinc-800/60 transition-colors ${colour}`}
                >
                  <input
                    type="checkbox"
                    checked={isAuto}
                    onChange={(e) => setAutoApprove(p, e.target.checked)}
                    className="w-3.5 h-3.5 accent-[#c5a062] cursor-pointer"
                  />
                  <span className="text-[11px] capitalize flex-1">{p}</span>
                  <span className={`text-[9px] uppercase tracking-wider ${isAuto ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {isAuto ? 'auto' : 'manual'}
                  </span>
                </label>
              );
            })}
          </div>
          <p className="text-[10px] text-zinc-500">
            Pipeline-produced posts land as <span className="text-zinc-400">scheduled</span> only when
            <span className="text-emerald-400"> all</span> their platforms are set to auto. If any platform on the post
            requires manual review, the whole post enters the approval queue.
            All platforms default to <span className="text-emerald-400">auto</span> — toggle off the ones you want to review by hand.
          </p>
        </div>

        {/* Per-platform daily caps */}
        <div className="pt-2 border-t border-[#c5a062]/15 space-y-2">
          <div className="flex items-center justify-between">
            <p className="label-overline">Daily Caps (per platform)</p>
            <span className="text-[10px] text-zinc-500">empty = no cap</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {(['instagram', 'pinterest', 'twitter', 'discord'] as PipelinePlatform[]).map((p) => {
              const value = dailyCaps[p];
              const colour =
                p === 'instagram'
                  ? 'text-pink-300 border-pink-500/30'
                  : p === 'pinterest'
                    ? 'text-red-300 border-red-500/30'
                    : p === 'twitter'
                      ? 'text-sky-300 border-sky-500/30'
                      : 'text-indigo-300 border-indigo-500/30';
              return (
                <label
                  key={p}
                  className={`flex items-center gap-2 px-3 py-2 bg-zinc-800/40 border rounded-xl ${colour}`}
                >
                  <span className="text-[11px] capitalize flex-1">{p}</span>
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={value ?? ''}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setDailyCap(p, raw === '' ? null : Number(raw));
                    }}
                    placeholder="∞"
                    className="w-12 px-1.5 py-0.5 bg-zinc-900 border border-[#c5a062]/25 rounded-lg text-xs text-white text-center focus:outline-none focus:ring-2 focus:ring-[#00e6ff]/30 focus:border-[#00e6ff]/40 transition-colors"
                  />
                  <span className="text-[10px] text-zinc-500">/day</span>
                </label>
              );
            })}
          </div>
          <p className="text-[10px] text-zinc-500">
            Scheduler skips any day where a target platform is already at its cap.
            Counts <span className="text-zinc-400">scheduled</span> + <span className="text-zinc-400">pending approval</span> only — posted entries don&apos;t consume a cap.
          </p>
        </div>

        {/* Stats */}
        <div className="flex flex-wrap gap-4 pt-2 border-t border-[#c5a062]/15">
          <div className="flex items-center gap-2">
            <Lightbulb className="w-4 h-4 text-amber-400" />
            <span className="text-sm text-zinc-400">
              Pending ideas:{' '}
              <span className="text-white font-medium">{pendingIdeas.length}</span>
            </span>
          </div>
          {pipelineRunning && (
            <div className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 text-[#00e6ff] animate-spin motion-reduce:animate-none" />
              <span className="text-sm text-[#00e6ff] font-medium">Running</span>
            </div>
          )}
        </div>
      </div>

      {/* In-flight idea card */}
      {pipelineProgress && (
        <ActiveIdeaCard
          progress={pipelineProgress}
          ideas={ideas}
          images={images}
          activeStageKey={activeStageKey}
          onSkip={skipCurrentIdea}
        />
      )}

      {/* Queue */}
      <div className="card overflow-hidden">
        <button
          onClick={() => setQueueExpanded(!queueExpanded)}
          className="w-full flex items-center justify-between p-4 hover:bg-white/[0.03] transition-colors duration-200"
        >
          <span className="text-sm font-medium text-zinc-300">
            Queue ({pipelineRunning ? pipelineQueue.length : pendingIdeas.length})
          </span>
          {queueExpanded ? (
            <ChevronUp className="w-4 h-4 text-zinc-500" />
          ) : (
            <ChevronDown className="w-4 h-4 text-zinc-500" />
          )}
        </button>
        {queueExpanded && (
          <div className="border-t border-[#c5a062]/15 max-h-60 overflow-y-auto hide-scrollbar">
            {(pipelineRunning ? pipelineQueue : pendingIdeas).length === 0 ? (
              <p className="p-4 text-sm text-zinc-500 text-center">No ideas in queue</p>
            ) : (
              (pipelineRunning ? pipelineQueue : pendingIdeas).map((idea, idx) => (
                <div
                  key={idea.id}
                  className="flex items-center gap-3 px-4 py-2.5 border-b border-[#c5a062]/10 last:border-0"
                >
                  <span className="text-xs text-zinc-600 font-mono w-6">{idx + 1}</span>
                  <Lightbulb className="w-3.5 h-3.5 text-amber-500/60 shrink-0" />
                  <span className="text-sm text-zinc-300 truncate">{idea.concept}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Log */}
      <div className="card overflow-hidden">
        <div
          onClick={() => setLogExpanded(!logExpanded)}
          className="w-full flex items-center justify-between p-4 hover:bg-white/[0.03] transition-colors duration-200 cursor-pointer"
        >
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-zinc-300">
              Pipeline Log ({logErrorsOnly ? `${errorCount} error${errorCount !== 1 ? 's' : ''}` : pipelineLog.length})
            </span>
            {errorCount > 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); setLogErrorsOnly((v) => !v); }}
                className={`text-[10px] px-2 py-0.5 rounded-xl transition-colors ${
                  logErrorsOnly
                    ? 'bg-red-600/30 text-red-300 border border-red-500/40'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-red-600/20 hover:text-red-400'
                }`}
              >
                {logErrorsOnly ? 'All' : `Errors (${errorCount})`}
              </button>
            )}
            {pipelineLog.length > 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); clearPipelineLog(); setLogErrorsOnly(false); }}
                className="text-[10px] px-2 py-0.5 bg-zinc-800 text-zinc-400 rounded-xl hover:bg-red-600/20 hover:text-red-400 transition-colors"
              >
                Clear
              </button>
            )}
          </div>
          {logExpanded ? (
            <ChevronUp className="w-4 h-4 text-zinc-500" />
          ) : (
            <ChevronDown className="w-4 h-4 text-zinc-500" />
          )}
        </div>
        {logExpanded && (
          <div className="border-t border-[#c5a062]/15 max-h-80 overflow-y-auto hide-scrollbar">
            {displayLog.length === 0 ? (
              <p className="p-4 text-sm text-zinc-500 text-center">
                {logErrorsOnly ? 'No errors in log' : 'No log entries yet'}
              </p>
            ) : (
              <AnimatePresence initial={false}>
                {displayLog.map((entry) => (
                  <motion.div
                    key={`${entry.step}-${entry.timestamp.getTime()}`}
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.18, ease: 'easeOut' }}
                    className="flex items-start gap-3 px-4 py-2.5 border-b border-[#c5a062]/10 last:border-0"
                  >
                    {entry.status === 'success' ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-zinc-500">{STEP_LABELS[entry.step] ?? entry.step}</span>
                        <span className="text-xs text-zinc-500">
                          {entry.timestamp.toLocaleTimeString()}
                        </span>
                      </div>
                      <p className="text-sm text-zinc-300 truncate">{entry.message}</p>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            )}
          </div>
        )}
      </div>

      {/* Approval Queue (bulk) — V040-HOTFIX-007: pass savedImages so
          pipeline-produced images (saved with pipelinePending=true)
          can be looked up and rendered in the approval cards. The
          in-memory `images` state is populated only by the manual
          generate flow and never contains pipeline images. */}
      <ApprovalQueue
        posts={(settings.scheduledPosts || []).filter((p) => p.status === 'pending_approval')}
        images={savedImages}
        ideas={ideas}
        onApprove={approveScheduledPost}
        onReject={rejectScheduledPost}
        onBulkApprove={onBulkApproveWithAutoContinue}
        onBulkReject={onBulkRejectWithUndo}
        onUpdateCaption={updateScheduledPostsCaption}
      />

      {undoState && undoState.snapshots.length > 0 && (
        <UndoToast
          key={`${undoState.kind}-${undoState.snapshots.map((s) => s.id).join(',')}`}
          message={
            undoState.kind === 'approve'
              ? `${undoState.snapshots.length} post${undoState.snapshots.length === 1 ? '' : 's'} approved`
              : `${undoState.snapshots.length} post${undoState.snapshots.length === 1 ? '' : 's'} rejected`
          }
          durationMs={10000}
          onUndo={undoBulkAction}
          onDismiss={() => setUndoState(null)}
        />
      )}
    </div>
  );
}
