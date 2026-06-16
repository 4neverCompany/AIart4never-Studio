'use client';

/**
 * AGENTIC-CORE / PHASE 2 — topbar budget readout.
 *
 * The compact, always-visible companion to {@link CreditBudgetBanner}: a mono /
 * orange "used (/cap)" credit figure for the Cyberforge command bar. It reads
 * the SAME real credit-usage record the banner does (`loadCreditUsage`) and
 * re-reads on the shared `CREDIT_USAGE_CHANGED_EVENT`, and the optional monthly
 * cap from `settings.higgsfieldMonthlyCreditCap`. No mock figures — when nothing
 * has been spent yet it shows `0`, and when a cap is set it shows `used / cap`.
 */

import { useEffect, useState } from 'react';
import { Coins } from 'lucide-react';
import {
  type CreditUsage,
  CREDIT_USAGE_CHANGED_EVENT,
  loadCreditUsage,
} from '@/lib/credit-budget';
import { useSettings } from '@/hooks/useSettings';

export function StudioBudgetReadout() {
  const { settings } = useSettings();
  const [usage, setUsage] = useState<CreditUsage | null>(null);

  useEffect(() => {
    let cancelled = false;
    const read = () => {
      void loadCreditUsage().then((u) => {
        if (!cancelled) setUsage(u);
      });
    };
    read();
    if (typeof window !== 'undefined') {
      window.addEventListener(CREDIT_USAGE_CHANGED_EVENT, read);
    }
    return () => {
      cancelled = true;
      if (typeof window !== 'undefined') {
        window.removeEventListener(CREDIT_USAGE_CHANGED_EVENT, read);
      }
    };
  }, []);

  const used = usage?.used ?? 0;
  const cap = settings.higgsfieldMonthlyCreditCap;
  const atCap = typeof cap === 'number' && cap > 0 && used >= cap;

  return (
    <span
      data-testid="budget-readout"
      title="Higgsfield credits used this cycle"
      className={`flex items-center gap-1 text-[11px] ${
        atCap ? 'text-red-400' : 'text-[#ff9d4d]'
      }`}
      style={{ fontFamily: 'var(--font-mono)' }}
    >
      <Coins className="w-3 h-3" aria-hidden />
      {used}
      {typeof cap === 'number' && cap > 0 ? (
        <span className="text-[#8a97a6]">/{cap}</span>
      ) : null}
    </span>
  );
}
