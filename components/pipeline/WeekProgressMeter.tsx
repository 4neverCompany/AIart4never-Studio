'use client';

import { CalendarCheck } from 'lucide-react';
import { useMashup } from '../MashupContext';

export function WeekProgressMeter() {
  const { weekFillStatus } = useMashup();
  const { days, scheduledTotal, targetTotal, percent, filled, targetDays, postsPerDay } =
    weekFillStatus;

  // Guard against the edge case of targetDays=0 — the meter would render
  // empty but we still want the user to see the numbers.
  const hasDays = days.length > 0;

  return (
    <div className="pt-2 border-t border-[#c5a062]/15">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <CalendarCheck className="w-4 h-4 text-[#c5a062]/60" />
          <span className="label-overline">Week Progress</span>
        </div>
        <span
          className={`text-[11px] font-mono ${
            filled ? 'text-emerald-400' : 'text-zinc-400'
          }`}
          aria-label={`${scheduledTotal} of ${targetTotal} posts scheduled`}
        >
          {scheduledTotal}/{targetTotal} · {percent}%
        </span>
      </div>

      {/* V081-PIPELINE-POLISH / STORY-011 — thin animated aggregate bar.
          Uses an Electric Blue gradient with a subtle inner glow to match
          the .progress-fill token aesthetic, with a slower 700ms ease so
          the fill visibly catches up after a scheduling tick. */}
      <div
        className="progress-track mb-2"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Week fill progress"
      >
        <div
          className="progress-fill"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>

      {hasDays && (
        <>
          <div
            role="list"
            aria-label={`Next ${targetDays} days — ${postsPerDay} posts/day target`}
            className="grid gap-0.5 sm:gap-1"
            style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
          >
            {days.map((d, i) => {
              const ratio = d.target === 0 ? 1 : Math.min(1, d.scheduledCount / d.target);
              const barColor =
                ratio >= 1
                  ? 'bg-emerald-500'
                  : ratio >= 0.5
                    ? 'bg-[#c5a062]'
                    : ratio > 0
                      ? 'bg-[#c5a062]/50'
                      : 'bg-zinc-800';
              return (
                <div
                  key={d.date}
                  role="listitem"
                  className="flex flex-col items-center gap-0.5 sm:gap-1 min-w-0"
                  title={`${d.dayLabel} ${d.date} — ${d.scheduledCount}/${d.target}${
                    d.gap > 0 ? ` (${d.gap} gap)` : ''
                  }`}
                >
                  <div
                    className={`w-full h-5 sm:h-6 rounded-sm transition-[background-color] duration-300 ease-out ${barColor}`}
                    aria-hidden="true"
                  />
                  <span
                    className={`text-[9px] font-mono uppercase tracking-wider truncate ${
                      i === 0 ? 'text-[#c5a062]' : 'text-zinc-600'
                    }`}
                  >
                    {d.dayLabel}
                  </span>
                  <span className="text-[9px] font-mono text-zinc-500 tabular-nums">
                    {d.scheduledCount}/{d.target}
                  </span>
                </div>
              );
            })}
          </div>

          {filled ? (
            <p className="mt-2 text-[10px] text-emerald-400/80">
              Week filled — pipeline will sleep until the first slot ticks over.
            </p>
          ) : (
            <p className="mt-2 text-[10px] text-zinc-500">
              {targetTotal - scheduledTotal} more post
              {targetTotal - scheduledTotal === 1 ? '' : 's'} to fill the next {targetDays} day
              {targetDays === 1 ? '' : 's'}.
            </p>
          )}
        </>
      )}
    </div>
  );
}
