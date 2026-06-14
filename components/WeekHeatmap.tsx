'use client';

/**
 * V040-001 — Engagement heatmap overlay for the week view.
 *
 * Five components per V030-DES-002:
 *   - HeatmapTint        absolute z-0 gold tint inside each slot cell
 *   - TopSlotStar        gold star marker (top-3 ranked slots)
 *   - HeatmapToggleButton  header pill (aria-pressed, persists to settings)
 *   - HeatmapLegend      bottom-right gradient legend
 *   - HeatmapTooltip     portal hover popover with score breakdown
 *
 * Plus pure helpers:
 *   - classifyTint(score)              tint Tailwind class
 *   - computeDisplayedStars(...)       confidence-weighted 0-5 stars
 *   - formatUpdatedAgo(ms)             "4h ago" / "yesterday" / "6 days ago"
 *   - sourceLabelFor(source, samples)  tooltip source line
 */

import React from 'react';
import { createPortal } from 'react-dom';
import { Star, Thermometer } from 'lucide-react';
import type { CachedEngagement } from '@/lib/smartScheduler';

// ── Tint classification ──────────────────────────────────────────────

export function classifyTint(score: number): string | null {
  if (score < 0.3) return null;
  if (score < 0.5) return 'bg-[#c5a062]/5';
  if (score < 0.7) return 'bg-[#c5a062]/10';
  if (score < 0.85) return 'bg-[#c5a062]/[0.18]';
  return 'bg-[#c5a062]/[0.28]';
}

// ── Confidence-star formula (spec §2.7) ──────────────────────────────

export function computeDisplayedStars(
  rawScore: number,
  source: 'instagram' | 'default',
  samples: number,
): number {
  const confidence =
    source === 'default' ? 0.6 :
    samples >= 30 ? 1.0 :
    samples >= 10 ? 0.85 :
    0.7;
  const stars = Math.round(rawScore * 5 * confidence);
  return Math.max(0, Math.min(5, stars));
}

// ── "updated ago" formatter (no date-fns) ────────────────────────────

export function formatUpdatedAgo(fetchedAt: number, now: number = Date.now()): string {
  const deltaMs = Math.max(0, now - fetchedAt);
  const mins = Math.floor(deltaMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1 month ago' : `${months} months ago`;
}

// ── Source label (spec §2.6 table) ───────────────────────────────────

export function sourceLabelFor(
  source: 'instagram' | 'default',
  samples: number,
): { label: string; colorClass: string } {
  if (source === 'default') {
    return {
      label: 'Research baseline (no IG data yet)',
      colorClass: 'text-zinc-500',
    };
  }
  if (samples >= 30) {
    return {
      label: 'Instagram Insights (high confidence)',
      colorClass: 'text-emerald-400',
    };
  }
  if (samples >= 10) {
    return {
      label: 'Instagram Insights (moderate)',
      colorClass: 'text-emerald-400/80',
    };
  }
  return {
    label: 'Instagram Insights (early signal)',
    colorClass: 'text-amber-400',
  };
}

// ── <HeatmapTint> ────────────────────────────────────────────────────

interface HeatmapTintProps {
  score: number;
  enabled: boolean;
}

export function HeatmapTint({ score, enabled }: HeatmapTintProps) {
  if (!enabled) return null;
  const tint = classifyTint(score);
  if (!tint) return null;
  return (
    <div
      aria-hidden="true"
      className={`absolute inset-0 pointer-events-none transition-opacity duration-200 ${tint}`}
    />
  );
}

// ── <TopSlotStar> ────────────────────────────────────────────────────

interface TopSlotStarProps {
  rank: 1 | 2 | 3;
}

export function TopSlotStar({ rank }: TopSlotStarProps) {
  const glow = rank === 1
    ? 'drop-shadow-[0_0_4px_rgba(197,160,98,0.5)]'
    : '';
  return (
    <Star
      className={`absolute top-1 right-1 w-3 h-3 text-[#c5a062] fill-[#c5a062]/30 z-10 pointer-events-none heatmap-star-pulse ${glow}`}
      style={{ animation: 'heatmap-star-pulse 2s ease-in-out infinite' }}
      aria-label={`Top slot #${rank}`}
    />
  );
}

// ── <HeatmapToggleButton> ────────────────────────────────────────────

interface HeatmapToggleButtonProps {
  heatmapEnabled: boolean;
  onToggle: () => void;
}

export function HeatmapToggleButton({ heatmapEnabled, onToggle }: HeatmapToggleButtonProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={heatmapEnabled}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] rounded-full border transition-colors ${
        heatmapEnabled
          ? 'bg-[#c5a062]/20 text-[#c5a062] border-[#c5a062]/40'
          : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:border-zinc-500'
      }`}
      title={heatmapEnabled ? 'Hide engagement heatmap' : 'Show engagement heatmap'}
    >
      <Thermometer className="w-3 h-3" />
      Heatmap
    </button>
  );
}

// ── <HeatmapLegend> ──────────────────────────────────────────────────

interface HeatmapLegendProps {
  heatmapEnabled: boolean;
}

export function HeatmapLegend({ heatmapEnabled }: HeatmapLegendProps) {
  if (!heatmapEnabled) return null;
  return (
    <div
      aria-label="Engagement heatmap legend"
      className="absolute bottom-3 right-3 z-20 w-[200px] bg-zinc-950/85 backdrop-blur border border-[#c5a062]/25 rounded-lg p-2 shadow-lg shadow-black/40 pointer-events-none"
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
          Engagement
        </span>
      </div>
      <div className="mt-1.5 flex h-2 overflow-hidden rounded-sm">
        <div className="flex-1 bg-[#c5a062]/5" />
        <div className="flex-1 bg-[#c5a062]/10" />
        <div className="flex-1 bg-[#c5a062]/[0.18]" />
        <div className="flex-1 bg-[#c5a062]/[0.28]" />
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] text-zinc-500">
        <span>low</span>
        <span>high</span>
      </div>
    </div>
  );
}

// ── <HeatmapTooltip> ─────────────────────────────────────────────────

export interface HeatmapTooltipAnchor {
  rect: DOMRect;
  date: Date;
  hour: number;
}

interface HeatmapTooltipProps {
  anchor: HeatmapTooltipAnchor;
  score: number;
  dayMult: number;
  hourWeight: number;
  weekendBonus: number;
  engagement: CachedEngagement;
  isAvailable: boolean;
  onScheduleClick?: () => void;
  onDismiss?: () => void;
}

export function HeatmapTooltip({
  anchor,
  score,
  dayMult,
  hourWeight,
  weekendBonus,
  engagement,
  isAvailable,
  onScheduleClick,
}: HeatmapTooltipProps) {
  const [mounted, setMounted] = React.useState(false);
  // V105.1-REACT-19: setState deferred via queueMicrotask (project
  // convention) so the effect body only triggers the SSR-skip mount
  // signal, not local state in the body itself.
  React.useEffect(() => {
    queueMicrotask(() => setMounted(true));
  }, []);
  if (!mounted || typeof document === 'undefined') return null;

  const samples = engagement.samples ?? 0;
  const stars = computeDisplayedStars(score, engagement.source, samples);
  const { label: sourceLabel, colorClass: sourceColor } = sourceLabelFor(
    engagement.source,
    samples,
  );
  const updatedAgo = formatUpdatedAgo(engagement.fetchedAt);

  const dayFullName = anchor.date.toLocaleDateString(undefined, { weekday: 'long' });
  const dayShortName = anchor.date.toLocaleDateString(undefined, { weekday: 'short' });
  const dayNum = anchor.date.getDate();
  const timeStr = `${String(anchor.hour).padStart(2, '0')}:00`;

  // Position: below-right of anchor, flip above when within 140px of bottom.
  const TOOLTIP_W = 240;
  const TOOLTIP_H_EST = 220;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const flipUp = anchor.rect.bottom + TOOLTIP_H_EST + 16 > vh;
  const top = flipUp
    ? Math.max(8, anchor.rect.top - TOOLTIP_H_EST - 8)
    : anchor.rect.bottom + 8;
  const left = Math.min(
    Math.max(8, anchor.rect.right + 8),
    vw - TOOLTIP_W - 8,
  );

  return createPortal(
    <div
      role="tooltip"
      style={{
        position: 'fixed',
        top,
        left,
        width: TOOLTIP_W,
        animation: 'heatmap-tooltip-in 120ms ease-out',
      }}
      className="heatmap-tooltip-anim z-[100] bg-zinc-900/95 backdrop-blur-md border border-[#c5a062]/30 rounded-xl shadow-2xl shadow-black/60 p-3 pointer-events-none"
    >
      <div className="text-[11px] font-semibold text-zinc-200">
        {dayFullName} {dayNum} · {timeStr}
      </div>

      <div className="mt-2 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Score</span>
          <span className="text-xs font-bold text-[#c5a062]">{score.toFixed(2)}</span>
        </div>
        <div className="flex items-center gap-0.5">
          {[1, 2, 3, 4, 5].map((i) => (
            <Star
              key={i}
              className={`w-3 h-3 ${
                i <= stars
                  ? 'text-[#c5a062] fill-[#c5a062]'
                  : 'text-zinc-700'
              }`}
            />
          ))}
          <span className="ml-1.5 text-[10px] text-zinc-400">
            {stars} of 5
          </span>
        </div>
      </div>

      <div className="mt-3 space-y-1 text-[10px] leading-snug">
        <div className="flex justify-between text-zinc-400">
          <span>Day weight</span>
          <span className="font-mono text-zinc-200">
            {dayMult.toFixed(2)}× <span className="text-zinc-500">({dayShortName})</span>
          </span>
        </div>
        <div className="flex justify-between text-zinc-400">
          <span>Hour weight</span>
          <span className="font-mono text-zinc-200">{hourWeight.toFixed(2)}</span>
        </div>
        {weekendBonus > 0 && (
          <div className="flex justify-between text-zinc-400">
            <span>Weekend evening</span>
            <span className="font-mono text-emerald-400">+{weekendBonus.toFixed(2)}</span>
          </div>
        )}
      </div>

      <div className="mt-3 pt-2 border-t border-zinc-800 space-y-0.5">
        <div className="text-[10px] text-zinc-500">
          Source: <span className={sourceColor}>{sourceLabel}</span>
        </div>
        {engagement.source === 'instagram' && (
          <div className="text-[10px] text-zinc-500">
            Based on {samples} past post{samples === 1 ? '' : 's'} · updated {updatedAgo}
          </div>
        )}
        {engagement.source === 'default' && (
          <div className="text-[10px] text-zinc-500">
            Connect Instagram in Settings to learn from your audience.
          </div>
        )}
      </div>

      {isAvailable && onScheduleClick && (
        <button
          type="button"
          onClick={onScheduleClick}
          className="mt-3 w-full px-2.5 py-1.5 text-[10px] font-medium bg-[#00e6ff]/15 hover:bg-[#00e6ff]/25 text-[#00e6ff] border border-[#00e6ff]/30 rounded-lg transition-colors pointer-events-auto"
        >
          Schedule a post here →
        </button>
      )}
    </div>,
    document.body,
  );
}
