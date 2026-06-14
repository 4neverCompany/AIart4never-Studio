'use client';

import { useState, useEffect } from 'react';
import { TrendingUp, X, Check } from 'lucide-react';
import { formatTimeShort } from './TimePicker24';
import type { PostPlatform } from '@/types/mashup';
import type { SlotScore } from '@/lib/smartScheduler';
import type { SmartSchedulerForm } from '@/hooks/useSmartScheduler';

// ── helpers ────────────────────────────────────────────────────────────────

function platformBadgeClass(p: PostPlatform): string {
  if (p === 'instagram') return 'bg-pink-600/90';
  if (p === 'pinterest') return 'bg-red-600/90';
  if (p === 'twitter')   return 'bg-sky-600/90';
  return 'bg-indigo-600/90';
}

// ── types ──────────────────────────────────────────────────────────────────

export interface SmartScheduleModalProps {
  slots: SlotScore[];
  source: string;
  form: SmartSchedulerForm;
  /** All platforms that have credentials configured. */
  available: PostPlatform[];
  postCount: number;
  onFormChange: (patch: Partial<SmartSchedulerForm>) => void;
  onConfirm: () => void;
  onClose: () => void;
}

// ── component ──────────────────────────────────────────────────────────────

export function SmartScheduleModal({
  slots,
  source,
  form,
  available,
  postCount,
  onFormChange,
  onConfirm,
  onClose,
}: SmartScheduleModalProps) {
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!confirmed) return;
    const t = setTimeout(onClose, 1400);
    return () => clearTimeout(t);
  }, [confirmed, onClose]);

  const confirmLabel = slots.length > 0
    ? `Scheduled for ${DAY_NAMES[new Date(slots[0].date).getDay()]} ${formatTimeShort(slots[0].time)} ✓`
    : `${postCount} post${postCount !== 1 ? 's' : ''} scheduled ✓`;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900/90 backdrop-blur-xl border-0 sm:border border-zinc-800/60 rounded-none sm:rounded-xl w-full sm:max-w-lg p-5 space-y-4 h-full sm:h-auto max-h-[100dvh] sm:max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="type-title flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-[#c5a062]" />
            Smart Schedule ({postCount} posts)
          </h3>
          <button type="button" onClick={onClose} className="p-1 text-zinc-400 hover:text-white" aria-label="Close smart schedule dialog">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Engagement source badge */}
        {source && (
          <div className="flex items-center gap-2 px-3 py-2 bg-indigo-500/10 border border-indigo-500/30 rounded-lg">
            <TrendingUp className="w-3.5 h-3.5 text-indigo-400" />
            <span className="text-[11px] text-indigo-300">
              Data source: <strong>{source}</strong>
            </span>
          </div>
        )}

        {/* Optimal slots preview */}
        {slots.length > 0 && (
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
              Recommended Slots (score = engagement likelihood)
            </label>
            <div className="space-y-1">
              {slots.slice(0, Math.max(postCount, 5)).map((slot, i) => {
                const slotDate = new Date(slot.date);
                const dayLabel = DAY_NAMES[slotDate.getDay()];
                const pct = Math.round(slot.score * 100);
                return (
                  <div
                    key={i}
                    className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800/50 border border-zinc-700/50 rounded-lg"
                  >
                    <span className="text-[10px] text-zinc-500 w-5">#{i + 1}</span>
                    <span className="text-xs font-mono text-white">{slot.date}</span>
                    <span className="text-xs font-mono text-[#c5a062]">{formatTimeShort(slot.time)}</span>
                    <span className="text-[10px] text-zinc-600">{dayLabel}</span>
                    <div className="flex-1" />
                    <div className="w-20 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                      <div className="h-full bg-[#00e6ff] rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-[10px] text-zinc-400 w-8 text-right">{pct}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Platform picker */}
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Platforms</label>
          <div className="flex flex-wrap gap-1.5">
            {available.map((p) => {
              const checked = form.platforms.includes(p);
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() =>
                    onFormChange({
                      platforms: checked
                        ? form.platforms.filter((x) => x !== p)
                        : [...form.platforms, p],
                    })
                  }
                  className={`px-2.5 py-1 text-[10px] rounded-full border transition-colors ${
                    checked
                      ? `${platformBadgeClass(p)} text-white border-transparent`
                      : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:border-zinc-500'
                  }`}
                >
                  {checked && <Check className="w-3 h-3 inline mr-1" />}
                  {p}
                </button>
              );
            })}
          </div>
        </div>

        <p className="text-[11px] text-zinc-500">
          {slots.length > 0
            ? `Each post gets its own optimal slot — distributed across ${slots.length} best times.`
            : 'All posts will be scheduled for the same time.'}
        </p>

        {/* Actions */}
        {confirmed ? (
          <div className="flex items-center justify-center gap-2 px-4 py-2.5 bg-[#c5a062]/10 border border-[#c5a062]/30 rounded-xl text-[#c5a062] text-xs font-semibold">
            <Check className="w-4 h-4 shrink-0" />
            {confirmLabel}
          </div>
        ) : (
          <div className="flex gap-2 justify-end">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg"
            >
              Cancel
            </button>
            <button
              disabled={form.platforms.length === 0}
              onClick={() => { onConfirm(); setConfirmed(true); }}
              className="px-3 py-1.5 text-xs bg-[#00e6ff] hover:bg-[#33eaff] disabled:opacity-40 text-[#050505] font-semibold rounded-lg flex items-center gap-1.5"
            >
              <TrendingUp className="w-3.5 h-3.5" /> Smart Schedule {postCount} Posts
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
