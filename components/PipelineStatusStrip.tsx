'use client';

/**
 * V040-004 — compact header pill showing pipeline state on every tab.
 * Running dot (pulsing when active), queue count, and a live countdown
 * to the next idea when the daemon is mid-sleep in continuous mode.
 *
 * Countdown source: the daemon's only signal about "next cycle at" is
 * its own progress string "Next cycle in N min" (set right before the
 * sleep-slice loop in usePipelineDaemon). Rather than add a separate
 * `pipelineNextRunAt` through the hook/context/types stack, we parse
 * that string when it first appears, lock in a local deadline, and
 * tick 1s until progress flips to something else or the pipeline stops.
 */

import React, { useEffect, useState } from 'react';
import { Zap, CheckCircle2 } from 'lucide-react';
import { useMashup, type ViewType } from './MashupContext';

interface Props {
  setView: (v: ViewType) => void;
}

const SLEEP_MSG_RE = /Next cycle in (\d+) min/;

const formatCountdown = (ms: number): string => {
  if (ms <= 0) return '0s';
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
};

export const PipelineStatusStrip: React.FC<Props> = ({ setView }) => {
  const {
    pipelineEnabled,
    pipelineRunning,
    pipelineQueue,
    pipelineProgress,
    pipelineContinuous,
    pipelineLog,
    weekFillStatus,
  } = useMashup();

  const [now, setNow] = useState<number | null>(null);
  // V105.1-REACT-19: was deadlineRef + lastSleepMsgRef with mutation during
  // render, which React 19's react-hooks/refs and react-hooks/purity rules
  // flag. Moved both to state so the component re-renders when the deadline
  // changes (the old code relied on the interval tick to re-render, which
  // worked but was a hidden coupling).
  const [deadline, setDeadline] = useState<number | null>(null);
  const [lastSleepMsg, setLastSleepMsg] = useState<string | null>(null);

  const sleepMsg = pipelineProgress?.currentStep ?? '';
  const sleepMatch = sleepMsg.match(SLEEP_MSG_RE);

  // Sync deadline with the daemon's progress string. The daemon emits
  // "Next cycle in N min" right before its sleep-slice loop; we parse
  // it once per new message and lock in a deadline.
  //
  // V105.1-REACT-19: setState calls are deferred via queueMicrotask (project
  // convention from HiggsfieldConnection.tsx) so the effect body only
  // synchronizes against the external "daemon progress" source — not local
  // component state. The microtask runs after the effect's commit phase so
  // it doesn't trigger cascading renders.
  useEffect(() => {
    queueMicrotask(() => {
      if (sleepMatch) {
        if (lastSleepMsg !== sleepMsg) {
          const minutes = Number(sleepMatch[1]);
          setDeadline(Date.now() + minutes * 60 * 1000);
          setLastSleepMsg(sleepMsg);
        }
      } else {
        setDeadline(null);
        setLastSleepMsg(null);
      }
    });
  }, [sleepMsg, sleepMatch, lastSleepMsg]);

  // Tick once a second while a deadline is set. Re-runs whenever the
  // deadline changes (including the null transitions), so the interval
  // is torn down cleanly when the daemon stops sleeping.
  //
  // V105.1-REACT-19: setState is deferred via queueMicrotask (project
  // convention) so the effect body only manages the interval (the
  // "external system"), not local state.
  useEffect(() => {
    if (!deadline) return;
    queueMicrotask(() => setNow(Date.now()));
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [deadline]);

  const queueCount = pipelineQueue.length;
  const dotClass = pipelineRunning
    ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)] animate-pulse'
    : pipelineEnabled
      ? 'bg-amber-400/80'
      : 'bg-zinc-600';
  const label = pipelineRunning ? 'Running' : pipelineEnabled ? 'Armed' : 'Idle';

  // V082-WEEK-FULL-INDICATOR: when continuous mode is armed but the
  // week's quota is met (no pending_approval needed), show a
  // "Paused — week full" pill in the timer slot. Replaces the vague
  // "Ready" state that was previously shown in this condition, which
  // was indistinguishable from "armed and about to start a cycle".
  // Tells the user at a glance that nothing is happening and why.
  const weekFull =
    weekFillStatus &&
    weekFillStatus.scheduledTotal + weekFillStatus.pendingApprovalTotal >=
      weekFillStatus.targetTotal &&
    weekFillStatus.pendingApprovalTotal === 0;

  let timerText: string | null = null;
  if (deadline && now !== null && pipelineRunning && pipelineContinuous) {
    timerText = `Next in ${formatCountdown(deadline - now)}`;
  } else if (pipelineRunning && pipelineProgress?.currentIdea) {
    timerText = pipelineProgress.currentIdea.length > 24
      ? `${pipelineProgress.currentIdea.slice(0, 24)}…`
      : pipelineProgress.currentIdea;
  } else if (
    pipelineEnabled &&
    pipelineContinuous &&
    !pipelineRunning &&
    weekFull
  ) {
    timerText = 'Paused — week full';
  } else if (pipelineEnabled && pipelineContinuous && !pipelineRunning) {
    timerText = 'Ready';
  }

  // PIPELINE-CONT-V2 (V091-QA-FOLLOWUP §4): success banner for the
  // confirmed-fill event. The daemon emits a `pipeline-week-confirmed`
  // log entry only when the horizon is fully scheduled AND no posts
  // are awaiting approval — the only "true done" state for continuous
  // mode. Surfacing it on the strip means the user gets the same
  // confirmation on every tab, not just the pipeline view.
  //
  // Auto-dismiss: the banner is bound to the most-recent log entry, so
  // it disappears the moment the daemon emits any newer event (next
  // cycle's `pipeline-cycle`, `daemon`, etc.) — no timer needed.
  const latestLog = pipelineLog && pipelineLog.length > 0
    ? pipelineLog[pipelineLog.length - 1]
    : null;
  const showWeekConfirmedBanner = latestLog?.step === 'pipeline-week-confirmed';

  return (
    <button
      type="button"
      onClick={() => setView('pipeline')}
      title="Open Pipeline"
      aria-label={`Pipeline ${label}, queue ${queueCount}${timerText ? `, ${timerText}` : ''}. Open pipeline tab.`}
      className="hidden lg:flex items-center gap-3 px-3 py-1.5 rounded-xl border border-[#c5a062]/20 bg-zinc-900/50 hover:bg-zinc-800/70 hover:border-[#00e6ff]/40 transition-colors shrink-0 text-xs text-zinc-300"
    >
      <span className="flex items-center gap-1.5">
        <span className={`w-2 h-2 rounded-full ${dotClass}`} aria-hidden="true" />
        <Zap className="w-3.5 h-3.5 text-[#c5a062]" aria-hidden="true" />
        <span className="font-medium text-zinc-200">{label}</span>
      </span>
      <span className="h-3 w-px bg-zinc-700" aria-hidden="true" />
      <span className="flex items-center gap-1.5 tabular-nums">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">Queue</span>
        <span className={queueCount > 0 ? 'text-[#00e6ff] font-medium' : 'text-zinc-400'}>{queueCount}</span>
      </span>
      {timerText && (
        <>
          <span className="h-3 w-px bg-zinc-700" aria-hidden="true" />
          <span className="text-zinc-400 tabular-nums max-w-[140px] truncate">{timerText}</span>
        </>
      )}
      {showWeekConfirmedBanner && (
        <>
          <span className="h-3 w-px bg-zinc-700" aria-hidden="true" />
          <span
            data-testid="pipeline-week-confirmed-banner"
            className="flex items-center gap-1 px-2 py-0.5 bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 rounded-full text-[10px] font-medium"
          >
            <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
            Week confirmed
          </span>
        </>
      )}
    </button>
  );
};
