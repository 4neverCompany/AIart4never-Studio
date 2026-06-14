'use client';

/**
 * V040-005 — reusable presentational tile for the Daily Digest card.
 * Four instances live inside DailyDigest (Yesterday · Week fill ·
 * Pending · Pipeline). Structure only — each tile's caller supplies
 * `primary` (a ReactNode, so we can render big numbers, pills, or
 * buttons identically) and `secondary`.
 */

import React from 'react';

interface Props {
  label: string;
  primary: React.ReactNode;
  secondary?: React.ReactNode;
}

export const DigestTile: React.FC<Props> = ({ label, primary, secondary }) => (
  <div className="bg-zinc-950/60 rounded-xl p-3 space-y-1 text-center border border-zinc-800/60">
    <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
    <div className="text-white">{primary}</div>
    {secondary !== undefined && (
      <div className="text-xs text-zinc-400">{secondary}</div>
    )}
  </div>
);
