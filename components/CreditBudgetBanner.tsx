'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Coins, RefreshCw, ShieldOff } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import {
  type CreditUsage,
  CREDIT_USAGE_CHANGED_EVENT,
  loadCreditUsage,
  resetCycle,
  setOverride,
} from '@/lib/credit-budget';

interface CreditBudgetBannerProps {
  /** Optional cap; when undefined, the banner stays hidden. */
  cap: number | undefined;
  /** Refresh tick — parent can bump this to force a re-read after
   *  a generation completes (so the running total updates). */
  refreshTick?: number;
}

/**
 * V1.0.7-PROMPT-ENG-D: low-credit + cap-reached banner.
 *
 * Renders nothing when no cap is set or when usage is below 80%.
 * Shows a yellow "running low" banner at 80–99% of the cap.
 * Shows a red "cap reached" banner at 100% — with an inline
 * "Override for this cycle" button so the user can unblock
 * themselves without leaving the workflow.
 *
 * Reads + writes the credit record directly through the helper
 * module so the parent doesn't need to thread state through.
 */
export function CreditBudgetBanner({ cap, refreshTick = 0 }: CreditBudgetBannerProps) {
  const [usage, setUsage] = useState<CreditUsage | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadCreditUsage().then((u) => {
      if (!cancelled) setUsage(u);
    });
    // Re-read on every mutation event so the banner reflects
    // a successful generation without needing a page reload.
    const handler = () => {
      void loadCreditUsage().then((u) => {
        if (!cancelled) setUsage(u);
      });
    };
    if (typeof window !== 'undefined') {
      window.addEventListener(CREDIT_USAGE_CHANGED_EVENT, handler);
    }
    return () => {
      cancelled = true;
      if (typeof window !== 'undefined') {
        window.removeEventListener(CREDIT_USAGE_CHANGED_EVENT, handler);
      }
    };
  }, [refreshTick]);

  if (cap === undefined || cap <= 0 || !usage) return null;

  const percent = Math.min(1, usage.used / cap);
  const remaining = Math.max(0, cap - usage.used);
  const atCap = usage.used >= cap;

  // Hide banner entirely when usage is comfortably under cap AND
  // no override is active.
  if (percent < 0.8 && !usage.override) return null;

  const handleReset = async () => {
    setBusy(true);
    try {
      const next = await resetCycle();
      setUsage(next);
    } finally {
      setBusy(false);
    }
  };

  const handleOverride = async () => {
    setBusy(true);
    try {
      const next = await setOverride(true);
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
              Higgsfield credit cap reached
            </div>
            <p className="text-[11px] text-red-300/80 mt-0.5 leading-relaxed">
              {usage.used} of {cap} credits used. New generations are blocked until you reset the
              cycle or override the cap below.
            </p>
            {usage.override && (
              <p className="text-[11px] text-amber-300/80 mt-1 leading-relaxed">
                Override is on for this cycle — generations are allowed but the cap is not enforced.
              </p>
            )}
            <div className="flex items-center gap-2 mt-2.5">
              <button
                type="button"
                onClick={handleReset}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium text-white bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 transition-colors disabled:opacity-50"
              >
                <RefreshCw className="h-3 w-3" aria-hidden={true} />
                Reset cycle
              </button>
              {!usage.override && (
                <button
                  type="button"
                  onClick={handleOverride}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium text-amber-200 hover:text-amber-100 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 transition-colors disabled:opacity-50"
                >
                  Override for this cycle
                </button>
              )}
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    );
  }

  // 80%–99% — yellow "running low" banner
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
            Higgsfield credits running low
          </div>
          <p className="text-[11px] text-amber-200/70 mt-0.5 leading-relaxed">
            <Coins className="h-3 w-3 inline-block align-text-bottom mr-0.5" aria-hidden={true} />
            {remaining} credit{remaining === 1 ? '' : 's'} left this cycle
            {' '}({Math.round(percent * 100)}% of {cap} used).
          </p>
        </div>
        {/* Mini progress bar */}
        <div className="shrink-0 w-20 h-1.5 rounded-full bg-zinc-800 overflow-hidden" aria-hidden={true}>
          <div
            className="h-full bg-amber-400 transition-all"
            style={{ width: `${Math.round(percent * 100)}%` }}
          />
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
