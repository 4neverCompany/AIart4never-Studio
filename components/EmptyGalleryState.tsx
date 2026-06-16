'use client';

import { motion } from 'motion/react';
import { Bookmark, Zap, Sparkles, ArrowRight } from 'lucide-react';
import type { ViewType } from '@/types/mashup';

export interface EmptyGalleryStateProps {
  /** True when the user has zero generated images, zero ideas, AND
   *  zero scheduled posts — i.e. a fresh install with no signal of
   *  prior activity. Drives the "get started" pitch. */
  firstRun: boolean;
  /** Legacy: number of pending ideas. The pipeline GUI has been
   *  removed, so this no longer drives a CTA — kept on the interface
   *  so existing callers compile unchanged. */
  ideaCount?: number;
  setView: (v: ViewType) => void;
}

const ctaPrimary =
  'inline-flex items-center gap-2 px-4 py-2.5 bg-[#00e6ff] hover:bg-[#00d4ec] text-zinc-950 text-sm font-semibold rounded-xl transition-colors shadow-md';
const ctaSecondary =
  'inline-flex items-center gap-2 px-4 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-sm font-medium rounded-xl border border-zinc-700/60 transition-colors';

/**
 * Gallery empty state. The MashupForge content pipeline GUI has been
 * removed, so the CTAs now point at the live surfaces — Compare (the
 * generate-and-pick flow) and the Gallery itself — instead of the
 * dead 'ideas' / 'pipeline' views.
 *
 * Two states, picked by `firstRun`:
 * 1. **first-run** — fresh install: welcome pitch + Open Compare.
 * 2. **default-empty** — produced posts before but gallery is empty.
 */
export function EmptyGalleryState({ firstRun, setView }: EmptyGalleryStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4 }}
      className="h-full flex flex-col items-center justify-center text-zinc-500 py-20 px-4"
    >
      <div className="w-24 h-24 mb-6 rounded-full bg-zinc-900/50 border border-zinc-800/60 flex items-center justify-center">
        {firstRun ? (
          <Sparkles className="w-10 h-10 text-[#ff7a18]" />
        ) : (
          <Bookmark className="w-10 h-10 text-zinc-700" />
        )}
      </div>
      <h2 className="text-xl font-medium text-zinc-300 mb-2 text-center">
        {firstRun ? 'Welcome to AIart4never Studio' : 'Your Gallery is Empty'}
      </h2>
      <p className="text-sm max-w-md text-center text-zinc-500 mb-6">
        {firstRun
          ? 'Generate post-ready Master4never images in the Studio, then compare model variants side by side to pick the best one.'
          : 'Save your favorite beats from the Studio to build your collection — or open Compare to generate and pick variants.'}
      </p>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => setView('compare')}
          className={ctaPrimary}
          aria-label="Open Compare"
        >
          <Sparkles className="w-4 h-4" />
          Open Compare
          <ArrowRight className="w-3.5 h-3.5 opacity-70" />
        </button>
        <button
          type="button"
          onClick={() => setView('gallery')}
          className={ctaSecondary}
          aria-label="Go to Gallery"
        >
          <Zap className="w-4 h-4 text-[#00e6ff]" />
          View Gallery
        </button>
      </div>
    </motion.div>
  );
}
