'use client';

import { useState } from 'react';
import { TrendingUp } from 'lucide-react';
import type { UserSettings } from '@/types/mashup';

interface BestTimesData {
  success: boolean;
  source: 'instagram' | 'default' | 'partial' | 'error';
  postCount?: number;
  bestTimes?: Array<{ hour: number; weight: number }>;
  bestDays?: Array<{ day: string; multiplier: number }>;
}

export function BestTimesWidget({ settings }: { settings: UserSettings }) {
  const [insights, setInsights] = useState<BestTimesData | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchInsights = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/social/best-times', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: settings.apiKeys?.instagram?.accessToken,
          igAccountId: settings.apiKeys?.instagram?.igAccountId,
        }),
      });
      const data = await res.json() as BestTimesData;
      setInsights(data);
    } catch {
      setInsights({ success: false, source: 'error' });
    }
    setLoading(false);
  };

  return (
    <div className="pt-2 border-t border-[#c5a062]/15">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-[#c5a062]/60" />
          <span className="label-overline">Best Posting Times</span>
        </div>
        <button
          onClick={fetchInsights}
          disabled={loading}
          aria-busy={loading}
          aria-label={loading ? 'Analysing best posting times…' : insights ? 'Refresh best posting times' : 'Analyse best posting times'}
          className="text-[11px] px-2 py-1 bg-[#00e6ff]/10 text-[#00e6ff] rounded-xl hover:bg-[#00e6ff]/20 transition-colors disabled:opacity-50"
        >
          {loading ? 'Analyzing...' : insights ? 'Refresh' : 'Analyze'}
        </button>
      </div>

      {insights?.success && (
        <div className="space-y-1.5">
          <p className="text-[10px] text-zinc-400">
            {insights.source === 'instagram'
              ? `Based on ${insights.postCount} Instagram posts`
              : insights.source === 'default'
                ? 'Research-backed defaults (DACH/EU)'
                : 'Research-backed + partial data'}
          </p>
          <div className="grid grid-cols-5 gap-1 sm:gap-1.5">
            {insights.bestTimes?.map((t, i) => (
              <div
                key={i}
                className="flex flex-col items-center px-1.5 sm:px-2 py-1 sm:py-1.5 bg-zinc-800/50 border border-[#c5a062]/15 rounded-lg"
              >
                <span className="text-[11px] sm:text-xs font-mono text-white">{String(t.hour).padStart(2, '0')}:00</span>
                <div
                  className="w-full h-1 bg-zinc-800/80 rounded-full mt-1 overflow-hidden"
                  role="progressbar"
                  aria-valuenow={Math.round((t.weight || 0) * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`Engagement weight ${String(t.hour).padStart(2, '0')}:00`}
                >
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[#00b8cc] to-[#00e6ff] shadow-[0_0_6px_rgba(0,230,255,0.45)] transition-[width] duration-700 ease-out motion-reduce:transition-none"
                    style={{ width: `${Math.round((t.weight || 0) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
          {insights.bestDays && insights.bestDays.length > 0 && (
            <div className="flex gap-1.5 mt-1">
              {insights.bestDays.map((d, i) => (
                <span key={i} className="text-[10px] px-1.5 py-0.5 bg-emerald-500/10 text-emerald-400 rounded">
                  {d.day} ({Math.round((d.multiplier || 0) * 100)}%)
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {insights && !insights.success && (
        <p className="text-[10px] text-zinc-400">Could not load insights. Using defaults.</p>
      )}
    </div>
  );
}
