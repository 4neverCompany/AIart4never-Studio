'use client';

/**
 * V040-005 — Daily digest card shown above the Ideas board kanban.
 *
 * Morning briefing surface: greet the user, show what shipped
 * yesterday, the current week fill, what's pending approval, and
 * whether the pipeline is alive. All four metric tiles + the footer
 * derive from existing MashupContext fields — zero new context
 * methods, zero schema changes.
 *
 * Spec: docs/bmad/stories/V040-DES-002.md §B.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Sunrise,
  Sun,
  Sunset,
  Moon,
  X,
  ChevronDown,
  Clock,
} from 'lucide-react';
import { useMashup, type ViewType } from '../MashupContext';
import { DigestTile } from './DigestTile';
import { useDesktopConfig } from '@/hooks/useDesktopConfig';
import { isPlatformConfigured } from '@/lib/platform-credentials';

interface Props {
  setView: (v: ViewType) => void;
}

const HIDE_KEY = 'mashup.ideas.digestHidden';

const pad2 = (n: number) => n.toString().padStart(2, '0');
const formatDateKey = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const getGreeting = (hour: number): { icon: React.ElementType; label: string } => {
  if (hour >= 5 && hour < 11) return { icon: Sunrise, label: 'Good morning' };
  if (hour >= 11 && hour < 17) return { icon: Sun, label: 'Good afternoon' };
  if (hour >= 17 && hour < 22) return { icon: Sunset, label: 'Good evening' };
  return { icon: Moon, label: 'Still up?' };
};

const PLATFORM_CODES: Array<{
  key: 'instagram' | 'pinterest' | 'twitter' | 'discord';
  code: string;
  label: string;
}> = [
  { key: 'instagram', code: 'IG', label: 'Instagram' },
  { key: 'pinterest', code: 'PN', label: 'Pinterest' },
  { key: 'twitter', code: 'TW', label: 'Twitter' },
  { key: 'discord', code: 'DC', label: 'Discord' },
];

const formatNextPostWhen = (date: string, time: string): string => {
  const d = new Date(`${date}T${time}:00`);
  if (Number.isNaN(d.getTime())) return `${date} ${time}`;
  const now = new Date();
  const todayKey = formatDateKey(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const tomorrowKey = formatDateKey(tomorrow);
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (date === todayKey) return `Today · ${timeStr}`;
  if (date === tomorrowKey) return `Tomorrow · ${timeStr}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · ${timeStr}`;
};

const formatRelativeAgo = (ts: number): string => {
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return 'just now';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
};

export const DailyDigest: React.FC<Props> = ({ setView }) => {
  const {
    settings,
    weekFillStatus,
    pipelineEnabled,
    pipelineRunning,
    pipelineQueue,
    pipelineLog,
  } = useMashup();

  const [hidden, setHidden] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(HIDE_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(HIDE_KEY, hidden ? '1' : '0');
    } catch {
      /* quota / private mode — silently drop */
    }
  }, [hidden]);

  const greeting = useMemo(() => getGreeting(new Date().getHours()), []);
  const dateLabel = useMemo(
    () =>
      new Date().toLocaleDateString([], {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      }),
    [],
  );

  const metrics = useMemo(() => {
    const posts = settings.scheduledPosts ?? [];
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const dayBefore = new Date(now);
    dayBefore.setDate(now.getDate() - 2);
    const yKey = formatDateKey(yesterday);
    const dbKey = formatDateKey(dayBefore);

    let shippedYesterday = 0;
    let shippedDayBefore = 0;
    let pendingApproval = 0;
    let nextPost: { date: string; time: string; platforms: string[]; ts: number } | null = null;
    const nowMs = now.getTime();

    for (const p of posts) {
      if (p.status === 'posted' && p.date === yKey) shippedYesterday++;
      if (p.status === 'posted' && p.date === dbKey) shippedDayBefore++;
      if (p.status === 'pending_approval') pendingApproval++;
      if (p.status === 'scheduled') {
        const ts = new Date(`${p.date}T${p.time}:00`).getTime();
        if (Number.isFinite(ts) && ts >= nowMs) {
          if (!nextPost || ts < nextPost.ts) {
            nextPost = { date: p.date, time: p.time, platforms: p.platforms ?? [], ts };
          }
        }
      }
    }

    const trend = shippedYesterday - shippedDayBefore;
    return { shippedYesterday, pendingApproval, nextPost, trend };
  }, [settings.scheduledPosts]);

  const lastEventTs = pipelineLog[0]?.timestamp?.getTime() ?? null;

  // Shared vocabulary with PipelineStatusStrip ('Running' / 'Armed' /
  // 'Idle') so the header pill, digest pill, and the empty-state copy
  // below never disagree on what the pipeline is doing.
  const pipelineState: { label: string; pillClass: string; dotClass: string } = pipelineRunning
    ? {
        label: 'Running',
        pillClass: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
        dotClass: 'bg-emerald-400 animate-pulse',
      }
    : pipelineEnabled
      ? {
          label: 'Armed',
          pillClass: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
          dotClass: 'bg-amber-400',
        }
      : {
          label: 'Idle',
          pillClass: 'bg-zinc-900 text-zinc-500 border-zinc-800',
          dotClass: 'bg-zinc-600',
        };

  const weekFillBarColor =
    weekFillStatus.percent >= 100
      ? 'bg-emerald-500'
      : weekFillStatus.percent >= 70
        ? 'bg-amber-500'
        : 'bg-[#c5a062]';

  // Single source of truth: lib/platform-credentials.isPlatformConfigured.
  // Without consulting desktopCreds, IG configured via the desktop settings
  // panel reads as unconfigured (BUG-UI-008).
  const { credentials: desktopCreds } = useDesktopConfig();
  const platformHealth = PLATFORM_CODES.map((p) => {
    const configured = isPlatformConfigured(p.key, settings, desktopCreds);
    return { ...p, configured };
  });

  const GreetingIcon = greeting.icon;

  if (hidden) {
    return (
      <button
        type="button"
        onClick={() => setHidden(false)}
        aria-expanded={false}
        aria-controls="daily-digest-region"
        className="self-start text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1 transition-colors"
      >
        Show digest <ChevronDown className="w-3 h-3" />
      </button>
    );
  }

  return (
    <section
      id="daily-digest-region"
      role="region"
      aria-label="Daily digest"
      className="bg-zinc-900/40 border border-[#c5a062]/20 rounded-2xl p-5 space-y-4"
    >
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GreetingIcon className="w-4 h-4 text-[#c5a062]" aria-hidden="true" />
          <span className="text-base font-semibold text-white">{greeting.label}</span>
          <span className="text-zinc-500">·</span>
          <span className="text-sm text-zinc-400">{dateLabel}</span>
        </div>
        <button
          type="button"
          onClick={() => setHidden(true)}
          aria-expanded={true}
          aria-controls="daily-digest-region"
          className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1 transition-colors"
        >
          Hide digest <X className="w-3 h-3" />
        </button>
      </div>

      {/* 4-tile grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        <DigestTile
          label="Yesterday"
          primary={
            metrics.shippedYesterday === 0 ? (
              <div className="text-sm text-zinc-500 py-1.5">
                0 posts · pipeline {pipelineState.label.toLowerCase()}
              </div>
            ) : (
              <div>
                <div className="text-2xl font-semibold">{metrics.shippedYesterday}</div>
                <div className="text-[11px] text-zinc-500 -mt-0.5">
                  {metrics.shippedYesterday === 1 ? 'post shipped' : 'posts shipped'}
                </div>
              </div>
            )
          }
          secondary={
            metrics.shippedYesterday === 0 ? undefined : (
              <span
                className={
                  metrics.trend > 0
                    ? 'text-emerald-400'
                    : metrics.trend < 0
                      ? 'text-red-400'
                      : 'text-zinc-400'
                }
              >
                {metrics.trend > 0 ? '+' : ''}
                {metrics.trend} from day before
              </span>
            )
          }
        />

        <DigestTile
          label="Week fill"
          primary={
            <div>
              <div className="text-2xl font-semibold tabular-nums">
                {weekFillStatus.scheduledTotal} / {weekFillStatus.targetTotal}
              </div>
              <div className="text-[11px] text-zinc-500 -mt-0.5">slots</div>
            </div>
          }
          secondary={
            <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden mt-1.5">
              <div
                className={`h-full ${weekFillBarColor} transition-all`}
                style={{ width: `${Math.min(100, weekFillStatus.percent)}%` }}
                aria-hidden="true"
              />
            </div>
          }
        />

        <DigestTile
          label="Pending"
          primary={
            metrics.pendingApproval === 0 ? (
              <div className="text-sm text-emerald-400/80 py-1.5">All clear</div>
            ) : (
              <div>
                <div className="text-2xl font-semibold">{metrics.pendingApproval}</div>
                <div className="text-[11px] text-zinc-500 -mt-0.5">
                  {metrics.pendingApproval === 1 ? 'waiting approval' : 'waiting approval'}
                </div>
              </div>
            )
          }
          secondary={
            metrics.pendingApproval > 0 ? (
              <button
                type="button"
                onClick={() => setView('pipeline')}
                className="text-[11px] text-[#00e6ff] hover:text-[#00e6ff]/80 transition-colors"
              >
                Review ▸
              </button>
            ) : undefined
          }
        />

        <DigestTile
          label="Pipeline"
          primary={
            <button
              type="button"
              onClick={() => setView('pipeline')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium ${pipelineState.pillClass} hover:brightness-110 transition-all`}
              aria-label={`Pipeline ${pipelineState.label}, open pipeline`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${pipelineState.dotClass}`} aria-hidden="true" />
              {pipelineState.label}
            </button>
          }
          secondary={
            lastEventTs ? (
              <span className="text-[11px] text-zinc-500">last: {formatRelativeAgo(lastEventTs)}</span>
            ) : pipelineQueue.length > 0 ? (
              <span className="text-[11px] text-zinc-500">queue: {pipelineQueue.length}</span>
            ) : undefined
          }
        />
      </div>

      {/* Footer: next post + platform health */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 pt-2 border-t border-zinc-800/60">
        <div className="flex items-center gap-2 text-xs">
          <Clock className="w-3.5 h-3.5 text-zinc-500" aria-hidden="true" />
          {metrics.nextPost ? (
            <>
              <span className="text-zinc-400">Next post</span>
              <span className="text-zinc-500">·</span>
              <span className="text-zinc-200">
                {formatNextPostWhen(metrics.nextPost.date, metrics.nextPost.time)}
              </span>
              {metrics.nextPost.platforms.length > 0 && (
                <>
                  <span className="text-zinc-500">·</span>
                  <span className="text-zinc-400 capitalize">
                    {metrics.nextPost.platforms.join(' + ')}
                  </span>
                </>
              )}
            </>
          ) : (
            <span className="text-zinc-500">No posts scheduled</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">Platforms</span>
          {platformHealth.map((p) => (
            <span
              key={p.key}
              title={`${p.label} · ${p.configured ? 'Configured' : 'Not configured'}`}
              className="inline-flex items-center gap-1"
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${p.configured ? 'bg-emerald-500' : 'bg-zinc-600/70'}`}
                aria-hidden="true"
              />
              <span className="text-[10px] font-semibold text-zinc-400">{p.code}</span>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
};
