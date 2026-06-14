'use client';

import { motion } from 'motion/react';
import { Bookmark, Lightbulb, Zap, Sparkles, ArrowRight } from 'lucide-react';
import type { ViewType } from '@/types/mashup';

export interface EmptyGalleryStateProps {
  /** True when the user has zero generated images, zero ideas, AND
   *  zero scheduled posts — i.e. a fresh install with no signal of
   *  prior activity. Drives the multi-step "get started" pitch. */
  firstRun: boolean;
  /** Number of pending pipeline ideas — when > 0, the CTA shifts to
   *  "Run Pipeline" because the user already has fuel to burn. */
  ideaCount: number;
  setView: (v: ViewType) => void;
}

const ctaPrimary =
  'inline-flex items-center gap-2 px-4 py-2.5 bg-[#00e6ff] hover:bg-[#00d4ec] text-zinc-950 text-sm font-semibold rounded-xl transition-colors shadow-md';
const ctaSecondary =
  'inline-flex items-center gap-2 px-4 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-sm font-medium rounded-xl border border-zinc-700/60 transition-colors';

/**
 * V040-010: gallery empty state with a Run Pipeline CTA.
 *
 * Three states, picked by the props:
 * 1. **first-run** (no ideas, no posts, no images anywhere) — shows a
 *    two-step welcome: Add Ideas → Run Pipeline. The pipeline can't
 *    do anything without ideas to consume, so the CTA chain reflects
 *    that ordering.
 * 2. **has-ideas** — fresh gallery but the user already has ideas
 *    queued. Skip the welcome; pitch the pipeline button directly.
 * 3. **default-empty** — user has produced posts before but the
 *    gallery is currently empty. Lighter pitch.
 */
export function EmptyGalleryState({ firstRun, ideaCount, setView }: EmptyGalleryStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4 }}
      className="h-full flex flex-col items-center justify-center text-zinc-500 py-20 px-4"
    >
      <div className="w-24 h-24 mb-6 rounded-full bg-zinc-900/50 border border-zinc-800/60 flex items-center justify-center">
        {firstRun ? (
          <Sparkles className="w-10 h-10 text-[#c5a062]" />
        ) : (
          <Bookmark className="w-10 h-10 text-zinc-700" />
        )}
      </div>
      <h2 className="text-xl font-medium text-zinc-300 mb-2 text-center">
        {firstRun ? 'Welcome to MashupForge' : 'Your Gallery is Empty'}
      </h2>
      <p className="text-sm max-w-md text-center text-zinc-500 mb-6">
        {firstRun
          ? 'Drop in a few crossover ideas and let the pipeline turn them into post-ready images, captions, and a schedule — automatically.'
          : ideaCount > 0
            ? `You have ${ideaCount} pending ${ideaCount === 1 ? 'idea' : 'ideas'} ready for the pipeline. Or save favorites from the Studio to build the gallery manually.`
            : 'Save your favorite mashups from the Studio to build your collection — or kick off the pipeline to fill it automatically.'}
      </p>

      <div className="flex flex-wrap items-center justify-center gap-3">
        {firstRun && ideaCount === 0 ? (
          <>
            <button
              type="button"
              onClick={() => setView('ideas')}
              className={ctaPrimary}
              aria-label="Step 1: Add ideas"
            >
              <Lightbulb className="w-4 h-4" />
              Add Ideas
              <ArrowRight className="w-3.5 h-3.5 opacity-70" />
            </button>
            <span className="text-zinc-700 text-xs uppercase tracking-wider">then</span>
            <button
              type="button"
              onClick={() => setView('pipeline')}
              className={ctaSecondary}
              aria-label="Step 2: Run the pipeline"
            >
              <Zap className="w-4 h-4 text-[#00e6ff]" />
              Run Pipeline
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setView('pipeline')}
              className={ctaPrimary}
            >
              <Zap className="w-4 h-4" />
              Run Pipeline
            </button>
            <button
              type="button"
              onClick={() => setView(ideaCount > 0 ? 'ideas' : 'compare')}
              className={ctaSecondary}
            >
              {ideaCount > 0 ? (
                <>
                  <Lightbulb className="w-4 h-4" />
                  Manage Ideas
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Open Studio
                </>
              )}
            </button>
          </>
        )}
      </div>
    </motion.div>
  );
}
