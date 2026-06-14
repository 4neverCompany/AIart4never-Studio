'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Gauge, ShieldOff } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import {
  type MinimaxQuotaUsage,
  MINIMAX_QUOTA_CHANGED_EVENT,
  checkQuota,
  formatQuota,
  loadQuotaUsage,
  setQuotaOverride,
} from '@/lib/minimax-quota';

interface MinimaxQuotaBannerProps {
  /** Monthly token allowance (resolved from the tier + custom cap). When
   *  <= 0 the banner stays hidden — tracking-only, never warns/blocks. */
  allowance: number;
}

/**
 * 4NE-21 / Story 1.5: monthly MiniMax token-quota banner.
 *
 * Sibling of `CreditBudgetBanner` (Higgsfield image credits); this one
 * meters MiniMax TEXT/agent tokens against the monthly token-plan
 * allowance. Renders nothing until the running total crosses the warn
 * threshold (90%) or the cap (100%):
 *   - 90–99%  → amber "running low" line.
 *   - 100%    → red "quota reached" line with an "Override this month"
 *               button (calls `setQuotaOverride(true)`), mirroring the
 *               credit-budget banner's per-cycle escape hatch.
 *
 * Reads + writes the quota record directly through the engine helpers and
 * re-reads on every `MINIMAX_QUOTA_CHANGED_EVENT` (fired by `recordTokens`
 * / `setQuotaOverride` / `resetQuotaCycle`), so it updates live as the
 * autonomy loop spends tokens.
 */
export function MinimaxQuotaBanner({ allowance }: MinimaxQuotaBannerProps) {
  const [usage, setUsage] = useState<MinimaxQuotaUsage | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadQuotaUsage().then((u) => {
      if (!cancelled) setUsage(u);
    });
    const handler = () => {
      void loadQuotaUsage().then((u) => {
        if (!cancelled) setUsage(u);
      });
    };
    if (typeof window !== 'undefined') {
      window.addEventListener(MINIMAX_QUOTA_CHANGED_EVENT, handler);
    }
    return () => {
      cancelled = true;
      if (typeof window !== 'undefined') {
        window.removeEventListener(MINIMAX_QUOTA_CHANGED_EVENT, handler);
      }
    };
  }, [allowance]);

  if (!(allowance > 0) || !usage) return null;

  const quota = checkQuota(allowance, usage);
  // Only surface the banner once we're at/above the warn threshold (or the
  // override is on). Below that, stay out of the way.
  if (!quota.warn && !usage.override) return null;

  const atCap = quota.reason === 'exceeded' || (usage.override && usage.tokensUsed >= allowance);
  const pct = Math.round(quota.percent * 100);

  const handleOverride = async () => {
    setBusy(true);
    try {
      const next = await setQuotaOverride(true);
      setUsage(next);
    } finally {
      setBusy(false);
    }
  };

  if (atCap) {
    return (
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          className="rounded-xl border border-red-500/30 bg-red-500/8 p-3 flex items-start gap-3"
        >
          <ShieldOff className="h-4 w-4 text-red-400 mt-0.5 shrink-0" aria-hidden={true} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-red-300">
              Monthly MiniMax quota reached
            </div>
            <p className="text-[11px] text-red-300/80 mt-0.5 leading-relaxed">
              {formatQuota(usage, allowance)}. Autonomous generation is paused until the cycle rolls
              over (start of next month) — or override for this month below.
            </p>
            {usage.override && (
              <p className="text-[11px] text-amber-300/80 mt-1 leading-relaxed">
                Override is on for this month — generation continues but the cap is not enforced.
              </p>
            )}
            {!usage.override && (
              <div className="flex items-center gap-2 mt-2.5">
                <button
                  type="button"
                  onClick={handleOverride}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium text-amber-200 hover:text-amber-100 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 transition-colors disabled:opacity-50"
                >
                  Override this month
                </button>
              </div>
            )}
          </div>
        </motion.div>
      </AnimatePresence>
    );
  }

  // 90%–99% — amber "running low" line.
  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 flex items-start gap-3"
      >
        <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" aria-hidden={true} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-amber-200">
            MiniMax token quota running low
          </div>
          <p className="text-[11px] text-amber-200/70 mt-0.5 leading-relaxed">
            <Gauge className="h-3 w-3 inline-block align-text-bottom mr-0.5" aria-hidden={true} />
            {formatQuota(usage, allowance)}.
          </p>
        </div>
        <div className="shrink-0 w-20 h-1.5 rounded-full bg-zinc-800 overflow-hidden" aria-hidden={true}>
          <div className="h-full bg-amber-400 transition-all" style={{ width: `${pct}%` }} />
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
