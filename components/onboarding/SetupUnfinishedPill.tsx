'use client';

import { useState } from 'react';
import { X } from 'lucide-react';

interface SetupUnfinishedPillProps {
  /** Last completed step (0–3). 3 means done; pill should not render. */
  lastCompletedStep: number;
  onResume: () => void;
  onDismissForever: () => void;
}

/**
 * Tiny amber pill mounted near the top-right of the app. Visible
 * whenever the user skipped onboarding without completing all 3 steps.
 * Click to resume; the X dismisses with a confirmation.
 */
export function SetupUnfinishedPill({ lastCompletedStep, onResume, onDismissForever }: SetupUnfinishedPillProps) {
  const [confirming, setConfirming] = useState(false);

  if (lastCompletedStep >= 3) return null;

  return (
    <div className="fixed top-4 right-4 z-[80] flex items-center gap-2">
      <button
        type="button"
        onClick={onResume}
        className="bg-amber-500/15 text-amber-200 border border-amber-500/30 rounded-full pl-3 pr-3 py-1 text-xs flex items-center gap-2 hover:bg-amber-500/25 transition-colors"
      >
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75 animate-ping" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-400" />
        </span>
        Finish setup ({lastCompletedStep} of 3) →
      </button>
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label="Dismiss setup pill"
          className="text-amber-300/70 hover:text-amber-200 transition-colors p-1"
        >
          <X className="w-3 h-3" />
        </button>
      ) : (
        <div className="flex items-center gap-1 bg-zinc-950 border border-amber-500/30 rounded-full px-2 py-0.5">
          <span className="text-[10px] text-zinc-300">Hide forever?</span>
          <button onClick={onDismissForever} className="text-[10px] text-red-300 hover:text-red-200 px-1">Yes</button>
          <button onClick={() => setConfirming(false)} className="text-[10px] text-zinc-400 hover:text-zinc-200 px-1">No</button>
        </div>
      )}
    </div>
  );
}
