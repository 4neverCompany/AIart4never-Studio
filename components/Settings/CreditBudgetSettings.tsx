'use client';

import { useEffect, useState } from 'react';
import { Coins, RefreshCw } from 'lucide-react';
import {
  type CreditUsage,
  CREDIT_USAGE_CHANGED_EVENT,
  formatUsage,
  loadCreditUsage,
  resetCycle,
} from '@/lib/credit-budget';

interface CreditBudgetSettingsProps {
  /** Current cap from UserSettings (undefined = gate disabled). */
  cap: number | undefined;
  /** Called when the user changes the cap. */
  onChange: (next: number | undefined) => void;
}

/**
 * V1.0.7-PROMPT-ENG-D: Settings UI for the Higgsfield credit cap.
 *
 * - Number input bound to `UserSettings.higgsfieldMonthlyCreditCap`.
 * - "Reset cycle" button to zero the running counter and start a
 *   new cycle (also clears the override).
 * - Live readout of the current cycle usage underneath the input.
 *
 * The input is uncontrolled (defaultValue) so the user can type
 * freely without the controlled-input churn; the parent's `cap`
 * is the source of truth and is committed on blur / Enter.
 *
 * The component owns its own `usage` state — it reads from
 * persistence on mount and after a successful reset. The cap
 * itself is owned by the parent (UserSettings) so the
 * `useSettings` debounce handles persistence.
 */
export function CreditBudgetSettings({ cap, onChange }: CreditBudgetSettingsProps) {
  const [usage, setUsage] = useState<CreditUsage | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadCreditUsage().then((u) => {
      if (!cancelled) setUsage(u);
    });
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
  }, [cap]);

  const commitDraft = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      onChange(undefined);
      return;
    }
    const n = Number.parseInt(trimmed, 10);
    if (Number.isFinite(n) && n > 0) onChange(n);
  };

  const handleReset = async () => {
    setBusy(true);
    try {
      const next = await resetCycle();
      setUsage(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-zinc-950/50 p-4 rounded-xl border border-zinc-800/60 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <label
            htmlFor="higgsfield-credit-cap"
            className="block text-sm text-zinc-300"
          >
            Monthly credit cap
          </label>
          <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
            Block new Higgsfield generations once you hit this many credits in the current cycle.
            Leave blank to disable the gate.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Coins
            className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500 z-10"
            aria-hidden={true}
          />
          <input
            id="higgsfield-credit-cap"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            key={cap}
            defaultValue={cap !== undefined ? String(cap) : ''}
            placeholder="e.g. 1000"
            onBlur={(e) => commitDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              }
            }}
            className="w-full bg-zinc-900 border border-zinc-800/60 rounded-xl pl-9 pr-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30"
          />
        </div>
        <button
          type="button"
          onClick={handleReset}
          disabled={busy}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[11px] font-medium text-zinc-300 hover:text-white bg-zinc-900 hover:bg-zinc-800 border border-zinc-800/60 transition-colors disabled:opacity-50"
        >
          <RefreshCw className="h-3 w-3" aria-hidden={true} />
          Reset cycle
        </button>
      </div>

      <div className="text-[11px] text-zinc-500 flex items-center justify-between gap-3">
        <span>
          {usage
            ? formatUsage(usage, cap)
            : 'Loading…'}
        </span>
        {usage?.cycleStartMs ? (
          <span className="text-zinc-600">
            cycle started {new Date(usage.cycleStartMs).toLocaleDateString()}
          </span>
        ) : null}
      </div>

      {usage?.override && (
        <p className="text-[11px] text-amber-300/80 leading-relaxed">
          Override is on for this cycle — cap is bypassed until you reset.
        </p>
      )}
    </div>
  );
}
