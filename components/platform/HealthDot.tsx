'use client';

/**
 * V040-007 — single platform-health dot + hover tooltip.
 * Atomic UI only — state classification + data derivation happen in
 * HealthStrip, which hands each instance a pre-computed HealthState.
 *
 * Click fires a window-level `mashup:open-settings` CustomEvent that
 * MainContent listens for (see MainContent's effect). This avoids
 * lifting `showSettings` into context for a pure routine add.
 */

import React from 'react';
import { AlertTriangle } from 'lucide-react';

export type HealthState = 'healthy' | 'stale' | 'broken' | 'unused';

export interface HealthDotProps {
  code: 'IG' | 'PN' | 'TW' | 'DC';
  platformLabel: string;
  state: HealthState;
  detail: string;
  compact?: boolean;
}

const STATE_STYLES: Record<HealthState, { dot: string; label: string }> = {
  healthy: {
    dot: 'bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.6)]',
    label: 'Healthy',
  },
  stale: { dot: 'bg-amber-400', label: 'Stale' },
  broken: { dot: 'bg-red-500 motion-safe:animate-pulse', label: 'Broken' },
  unused: { dot: 'bg-zinc-600/70', label: 'Unused' },
};

export const HealthDot: React.FC<HealthDotProps> = ({
  code,
  platformLabel,
  state,
  detail,
  compact = false,
}) => {
  const style = STATE_STYLES[state];
  const ariaLabel = `${platformLabel} · ${style.label} · ${detail} · click for settings`;

  const openSettings = () => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('mashup:open-settings'));
  };

  return (
    <button
      type="button"
      onClick={openSettings}
      aria-label={ariaLabel}
      title={`${platformLabel} · ${style.label}\n${detail}`}
      className={`group relative inline-flex items-center gap-1.5 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e6ff]/40 ${
        compact ? 'p-1 hover:bg-zinc-800/60' : 'px-2 py-1 hover:bg-zinc-800/60'
      }`}
    >
      <span className="relative inline-flex items-center justify-center">
        <span className={`w-2 h-2 rounded-full ${style.dot}`} aria-hidden="true" />
        {state === 'broken' && (
          <AlertTriangle
            className="w-2 h-2 text-red-100 absolute motion-reduce:block hidden"
            aria-hidden="true"
          />
        )}
      </span>
      {!compact && (
        <span className="text-[10px] font-semibold text-zinc-400">{code}</span>
      )}
    </button>
  );
};
