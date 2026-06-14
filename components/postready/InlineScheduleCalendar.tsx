'use client';

/**
 * V060-001 — Inline schedule calendar embedded in a Post Ready card.
 *
 * Two-step flow:
 *   1. 14-day grid (heatmap ON by default) — pick a day
 *   2. Time picker for that day (best 3 hours highlighted) — pick a time
 *
 * Plus an Auto-Schedule shortcut that runs `findBestSlot` against the
 * full `scheduledPosts` list and confirms in one click.
 */

import { useMemo, useState } from 'react';
import { Sparkles, X, Calendar as CalendarIcon, Star } from 'lucide-react';
import {
  computeWeekScores,
  findBestSlot,
  loadEngagementData,
  type SlotScoreBreakdown,
} from '@/lib/smartScheduler';
import { HeatmapTint, HeatmapToggleButton } from '../WeekHeatmap';
import type { ScheduledPost, PostPlatform } from '@/types/mashup';

export interface InlineScheduleCalendarProps {
  scheduledPosts: ScheduledPost[];
  selectedPlatforms: PostPlatform[];
  onConfirm: (date: string, time: string) => void;
  onClose: () => void;
}

const toYMD = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const HOURS = Array.from({ length: 18 }, (_, i) => i + 6); // 06..23

export function InlineScheduleCalendar({
  scheduledPosts,
  selectedPlatforms,
  onConfirm,
  onClose,
}: InlineScheduleCalendarProps) {
  // Heatmap ON by default per V060-001 acceptance criterion 6.
  const [heatmapEnabled, setHeatmapEnabled] = useState(true);
  const [pickedDate, setPickedDate] = useState<string | null>(null);

  const engagement = useMemo(() => loadEngagementData(), []);

  // 14-day window starting tomorrow — same horizon as findBestSlot.
  const days = useMemo(() => {
    const out: Date[] = [];
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() + 1);
    for (let i = 0; i < 14; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      out.push(d);
    }
    return out;
  }, []);

  const weekScores = useMemo(
    () => computeWeekScores(days, engagement),
    [days, engagement],
  );

  const taken = useMemo(
    () => new Set(scheduledPosts.map((p) => `${p.date}T${p.time}`)),
    [scheduledPosts],
  );

  // Per-day average score → drives day-cell tint and ranking for the
  // top-3 stars on the day grid.
  const dayMeta = useMemo(() => {
    return days.map((d) => {
      const dateStr = toYMD(d);
      let sum = 0;
      let n = 0;
      for (const h of HOURS) {
        const sb = weekScores.get(`${dateStr}:${h}`);
        if (sb) {
          sum += sb.score;
          n += 1;
        }
      }
      return {
        date: d,
        dateStr,
        avgScore: n > 0 ? sum / n : 0,
      };
    });
  }, [days, weekScores]);

  // Top-3 days by score → gold star marker on the day cell.
  const topDayRanks = useMemo(() => {
    const sorted = [...dayMeta].sort((a, b) => b.avgScore - a.avgScore);
    const map = new Map<string, number>();
    for (let i = 0; i < Math.min(3, sorted.length); i++) {
      map.set(sorted[i].dateStr, i + 1);
    }
    return map;
  }, [dayMeta]);

  // For the picked day: rank hours by score → top-3 highlighted.
  const hourMeta = useMemo(() => {
    if (!pickedDate) return [];
    const rows: { hour: number; score: number; sb?: SlotScoreBreakdown }[] = [];
    for (const h of HOURS) {
      const sb = weekScores.get(`${pickedDate}:${h}`);
      rows.push({ hour: h, score: sb?.score ?? 0, sb });
    }
    return rows;
  }, [pickedDate, weekScores]);

  const topHourSet = useMemo(() => {
    const sorted = [...hourMeta].sort((a, b) => b.score - a.score);
    return new Set(sorted.slice(0, 3).map((h) => h.hour));
  }, [hourMeta]);

  const handleAutoSchedule = () => {
    const slot = findBestSlot(scheduledPosts, engagement, {
      platforms: selectedPlatforms,
    });
    onConfirm(slot.date, slot.time);
  };

  const formatDayLabel = (d: Date): { weekday: string; dayNum: string; month: string } => ({
    weekday: d.toLocaleDateString(undefined, { weekday: 'short' }),
    dayNum: String(d.getDate()),
    month: d.toLocaleDateString(undefined, { month: 'short' }),
  });

  return (
    <div
      className="border-t border-[#c5a062]/20 bg-zinc-950/60 p-3 space-y-3"
      role="region"
      aria-label="Schedule calendar"
    >
      {/* Header — auto-schedule + heatmap toggle + close */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={handleAutoSchedule}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-[#c5a062]/15 hover:bg-[#c5a062]/25 text-[#c5a062] border border-[#c5a062]/40 rounded-full transition-colors"
        >
          <Sparkles className="w-3.5 h-3.5" />
          Auto-Schedule
        </button>
        <div className="flex items-center gap-2">
          <HeatmapToggleButton
            heatmapEnabled={heatmapEnabled}
            onToggle={() => setHeatmapEnabled((v) => !v)}
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close calendar"
            className="inline-flex items-center justify-center w-6 h-6 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-full transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Step 1 — day grid */}
      {!pickedDate && (
        <>
          <div
            className="grid grid-cols-7 gap-1.5"
            role="grid"
            aria-label="Pick a day"
          >
            {dayMeta.map(({ date, dateStr, avgScore }) => {
              const rank = topDayRanks.get(dateStr);
              const dayLabel = formatDayLabel(date);
              const isToday = dateStr === toYMD(new Date());
              return (
                <button
                  key={dateStr}
                  type="button"
                  role="gridcell"
                  onClick={() => setPickedDate(dateStr)}
                  className="relative flex flex-col items-center justify-center py-2 px-1 rounded-lg border border-zinc-800 hover:border-[#c5a062]/50 bg-zinc-900/60 transition-colors overflow-hidden"
                  title={`Score ${avgScore.toFixed(2)}`}
                >
                  <HeatmapTint score={avgScore} enabled={heatmapEnabled} />
                  {rank && (
                    <Star
                      className="absolute top-0.5 right-0.5 w-2.5 h-2.5 text-[#c5a062] fill-[#c5a062]/50 z-10"
                      aria-label={`Top day #${rank}`}
                    />
                  )}
                  <span className="relative z-[1] text-[9px] uppercase tracking-wider text-zinc-500">
                    {dayLabel.weekday}
                  </span>
                  <span className="relative z-[1] text-sm font-bold text-zinc-100 tabular-nums">
                    {dayLabel.dayNum}
                  </span>
                  <span className="relative z-[1] text-[9px] text-zinc-500">
                    {isToday ? 'today' : dayLabel.month}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-[10px] text-zinc-500 flex items-center gap-1">
            <CalendarIcon className="w-3 h-3" />
            Tap a day to pick a time. Gold stars mark the best 3 days.
          </p>
        </>
      )}

      {/* Step 2 — time picker for the picked day */}
      {pickedDate && (
        <>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setPickedDate(null)}
              className="text-[10px] text-zinc-400 hover:text-zinc-100 underline-offset-2 hover:underline"
            >
              ← Back to days
            </button>
            <span className="text-[11px] font-semibold text-zinc-200">
              {new Date(pickedDate).toLocaleDateString(undefined, {
                weekday: 'long',
                month: 'short',
                day: 'numeric',
              })}
            </span>
          </div>
          <div
            className="grid grid-cols-6 gap-1.5"
            role="grid"
            aria-label="Pick a time"
          >
            {hourMeta.map(({ hour, score }) => {
              const time = `${String(hour).padStart(2, '0')}:00`;
              const isTaken = taken.has(`${pickedDate}T${time}`);
              const isTop = topHourSet.has(hour);
              return (
                <button
                  key={hour}
                  type="button"
                  role="gridcell"
                  disabled={isTaken}
                  onClick={() => onConfirm(pickedDate, time)}
                  className={`relative py-1.5 px-1 rounded-md text-xs tabular-nums border transition-colors overflow-hidden ${
                    isTaken
                      ? 'border-zinc-800 bg-zinc-900/40 text-zinc-600 cursor-not-allowed line-through'
                      : isTop
                        ? 'border-[#c5a062]/60 bg-[#c5a062]/15 text-[#c5a062] hover:bg-[#c5a062]/25'
                        : 'border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:border-[#c5a062]/40 hover:text-zinc-100'
                  }`}
                  title={isTaken ? 'Already scheduled' : `Score ${score.toFixed(2)}`}
                >
                  <HeatmapTint score={score} enabled={heatmapEnabled && !isTaken} />
                  <span className="relative z-[1]">{time}</span>
                </button>
              );
            })}
          </div>
          <p className="text-[10px] text-zinc-500">
            Gold-tinted slots are your best-engagement hours. Struck-through
            slots are already booked.
          </p>
        </>
      )}
    </div>
  );
}
