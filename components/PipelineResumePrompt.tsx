'use client';

// FEAT-006: shown on app launch when usePipeline finds a checkpoint from
// a previous run that didn't exit cleanly (auto-update mid-flight, crash,
// OS kill). Sits inside MashupProvider; renders nothing when there's
// nothing to resume.
//
// V050-001: credit-preserving resume. When the checkpoint recorded image
// ids that still exist in the saved gallery, the resumed run skips
// trending/expand/generate and picks up at captioning — no Leonardo
// credits are spent. We surface that distinction in the copy so the user
// knows whether resuming is free or costly.

import { Play, X, RotateCw, AlertTriangle, Sparkles } from 'lucide-react';
import { useMashup } from './MashupContext';

export function PipelineResumePrompt() {
  const { pendingResume, acceptResume, dismissResume, savedImages } = useMashup();

  if (!pendingResume) return null;

  const when = (() => {
    try { return new Date(pendingResume.ts).toLocaleString(); }
    catch { return pendingResume.ts; }
  })();

  // V050-001: count the checkpoint's images that we can still find in the
  // saved gallery. >0 → credit-preserving resume; 0 → fall back to full
  // re-run with Leonardo credits.
  const recoverableImages = (() => {
    if (pendingResume.imageIds.length === 0) return 0;
    const ids = new Set(savedImages.map(i => i.id));
    return pendingResume.imageIds.filter(id => ids.has(id)).length;
  })();
  const creditPreserving = recoverableImages > 0;

  return (
    <div
      role="dialog"
      aria-labelledby="pipeline-resume-title"
      className="fixed bottom-4 left-4 z-[100] max-w-sm w-[calc(100%-2rem)] sm:w-96"
    >
      <div className="rounded-xl border border-[#c5a062]/40 bg-[#050505]/95 backdrop-blur-md shadow-2xl p-4 space-y-3">
        <div className="flex items-start gap-2">
          <RotateCw className="w-4 h-4 text-[#c5a062] mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p id="pipeline-resume-title" className="text-xs font-semibold text-white">
              Resume interrupted pipeline?
            </p>
            <p className="text-[11px] text-zinc-400 mt-1">
              Last run stopped at <span className="font-mono text-[#c5a062]">{pendingResume.step}</span> on
              {' '}&ldquo;{pendingResume.concept.slice(0, 60)}{pendingResume.concept.length > 60 ? '\u2026' : ''}&rdquo;
            </p>
            <p className="text-[10px] text-zinc-600 mt-1">
              Paused at {when}
            </p>
          </div>
          <button
            type="button"
            onClick={dismissResume}
            aria-label="Dismiss resume prompt"
            className="text-zinc-500 hover:text-zinc-300 transition-colors -mt-0.5 -mr-0.5"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {creditPreserving ? (
          <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-2">
            <Sparkles className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />
            <p className="text-[10px] leading-snug text-emerald-200/90">
              Credit-preserving resume: {recoverableImages} pre-generated image
              {recoverableImages === 1 ? '' : 's'} found in your gallery. We&apos;ll
              skip Leonardo and pick up at captioning &mdash; no credits will be spent.
            </p>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
            <p className="text-[10px] leading-snug text-amber-200/90">
              No pre-generated images recoverable for this idea &mdash; resuming will
              re-run Leonardo from scratch and spend credits. Pick &ldquo;No,
              discard&rdquo; to skip this idea and save credits.
            </p>
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={acceptResume}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-semibold bg-[#00e6ff] hover:bg-[#33eaff] active:bg-[#00b8cc] text-[#050505] transition-colors"
          >
            <Play className="w-3 h-3" />
            {creditPreserving ? 'Yes, resume (no credits)' : 'Yes, restart (uses credits)'}
          </button>
          <button
            type="button"
            onClick={dismissResume}
            className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors px-2 py-1.5"
          >
            No, discard
          </button>
        </div>
      </div>
    </div>
  );
}
