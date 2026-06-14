'use client';

import { useEffect, useState } from 'react';
import { Gauge, RefreshCw } from 'lucide-react';
import {
  type MinimaxQuotaUsage,
  type MinimaxTier,
  MINIMAX_QUOTA_CHANGED_EVENT,
  MINIMAX_TIER_ALLOWANCE,
  formatQuota,
  formatTokenCount,
  loadQuotaUsage,
  resetQuotaCycle,
  resolveAllowance,
} from '@/lib/minimax-quota';

interface MinimaxQuotaSettingsProps {
  /** Current tier from UserSettings (defaults to 'plus' upstream). */
  tier: MinimaxTier | undefined;
  /** Custom monthly token cap, used only when tier === 'custom'. */
  customCap: number | undefined;
  /** Called when the tier changes. */
  onTierChange: (next: MinimaxTier) => void;
  /** Called when the custom cap changes (undefined = no cap). */
  onCustomCapChange: (next: number | undefined) => void;
}

const TIER_OPTIONS: { value: MinimaxTier; label: string }[] = [
  { value: 'plus', label: `Plus (~${formatTokenCount(MINIMAX_TIER_ALLOWANCE.plus)} tokens/mo)` },
  { value: 'max', label: `Max (~${formatTokenCount(MINIMAX_TIER_ALLOWANCE.max)} tokens/mo)` },
  { value: 'ultra', label: `Ultra (~${formatTokenCount(MINIMAX_TIER_ALLOWANCE.ultra)} tokens/mo)` },
  { value: 'custom', label: 'Custom (set your own cap)' },
];

/**
 * 4NE-21 / Story 1.5: Settings UI for the monthly MiniMax token-plan tier.
 *
 * - Tier `<select>` bound to `UserSettings.minimaxTier`.
 * - Custom cap number input (shown only for the 'custom' tier) bound to
 *   `UserSettings.minimaxCustomTokenCap`.
 * - "Reset cycle" button to zero the running token counter and clear the
 *   override (the auto-rollover handles month boundaries; this is a manual
 *   override for testing / mid-month plan changes).
 * - Live readout of the current cycle's token usage.
 *
 * The cap/tier are owned by the parent (UserSettings → useSettings
 * debounce); this component owns only its own `usage` read, mirroring
 * CreditBudgetSettings.
 */
export function MinimaxQuotaSettings({
  tier,
  customCap,
  onTierChange,
  onCustomCapChange,
}: MinimaxQuotaSettingsProps) {
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
  }, [tier, customCap]);

  const effectiveTier: MinimaxTier = tier ?? 'plus';
  const allowance = resolveAllowance(effectiveTier, customCap);

  const commitCap = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      onCustomCapChange(undefined);
      return;
    }
    const n = Number.parseInt(trimmed, 10);
    if (Number.isFinite(n) && n > 0) onCustomCapChange(n);
  };

  const handleReset = async () => {
    setBusy(true);
    try {
      const next = await resetQuotaCycle();
      setUsage(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-zinc-950/50 p-4 rounded-xl border border-zinc-800/60 space-y-3">
      <div>
        <label htmlFor="minimax-tier" className="block text-sm text-zinc-300">
          Token-plan tier
        </label>
        <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
          Sets the monthly token allowance the autonomy loop checks before each generation cycle.
          Plus / Max are estimates — switch to Custom to match your exact plan.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Gauge
            className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500 z-10"
            aria-hidden={true}
          />
          <select
            id="minimax-tier"
            value={effectiveTier}
            onChange={(e) => onTierChange(e.target.value as MinimaxTier)}
            className="w-full bg-zinc-900 border border-zinc-800/60 rounded-xl pl-9 pr-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30"
          >
            {TIER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
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

      {effectiveTier === 'custom' && (
        <input
          id="minimax-custom-cap"
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          key={customCap}
          defaultValue={customCap !== undefined ? String(customCap) : ''}
          placeholder="Monthly token cap, e.g. 2000000000"
          onBlur={(e) => commitCap(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          className="w-full bg-zinc-900 border border-zinc-800/60 rounded-xl px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30"
        />
      )}

      <div className="text-[11px] text-zinc-500 flex items-center justify-between gap-3">
        <span>{usage ? formatQuota(usage, allowance) : 'Loading…'}</span>
        {usage?.override ? (
          <span className="text-amber-300/80">override on</span>
        ) : null}
      </div>
    </div>
  );
}
