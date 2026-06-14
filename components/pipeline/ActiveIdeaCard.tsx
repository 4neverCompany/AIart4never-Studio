'use client';

import { Loader2, XCircle, SkipForward } from 'lucide-react';
import type { GeneratedImage, Idea, PipelineProgress } from '@/types/mashup';
import { STAGES } from './stages';

export function ActiveIdeaCard({
  progress,
  ideas,
  images,
  activeStageKey,
  onSkip,
}: {
  progress: PipelineProgress;
  ideas: Idea[];
  images: GeneratedImage[];
  activeStageKey: string | null;
  onSkip: () => void;
}) {
  const idea: Pick<Idea, 'concept' | 'context'> | undefined = progress.currentIdeaId
    ? ideas.find((i) => i.id === progress.currentIdeaId)
    : undefined;
  const concept = idea?.concept || progress.currentIdea || '—';
  const context = idea?.context;

  const liveImages = images.filter((img) => img.modelInfo?.modelId);
  const total = progress.total || 1;
  const pct = Math.round((progress.current / total) * 100);

  return (
    <div className="card p-3 sm:p-5 space-y-3 sm:space-y-4 border-[#00e6ff]/25 shadow-[0_0_24px_rgba(0,230,255,0.06)]">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <Loader2 className="w-3.5 h-3.5 text-[#00e6ff] animate-spin motion-reduce:animate-none shrink-0" />
            <span className="text-sm font-medium text-white">
              Processing idea {progress.current} of {progress.total}
            </span>
            <span className="text-xs text-zinc-500">· {pct}%</span>
          </div>
          <p className="text-sm text-[#00e6ff] truncate" title={concept}>{concept}</p>
          {context && (
            <p className="text-[11px] text-zinc-500 truncate" title={context}>{context}</p>
          )}
        </div>
        <button
          onClick={onSkip}
          className="shrink-0 flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 bg-amber-600/20 hover:bg-amber-600/40 border border-amber-500/40 text-amber-300 text-xs rounded-xl transition-colors"
          title="Skip this idea — keep the pipeline running"
          aria-label="Skip this idea"
        >
          <SkipForward className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Skip Idea</span>
          <span className="sm:hidden">Skip</span>
        </button>
      </div>

      {/* Per-idea progress bar */}
      <div className="progress-track">
        <div
          className="progress-fill"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Current step */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500 shrink-0">Current step</span>
        <span className="text-xs text-zinc-300 break-words min-w-0">{progress.currentStep}</span>
      </div>

      {/* Stage chips */}
      <div className="flex flex-wrap gap-1.5">
        {STAGES.map((stage) => {
          const isActive = activeStageKey === stage.key;
          const isCompleted =
            activeStageKey != null &&
            STAGES.findIndex((s) => s.key === stage.key) <
              STAGES.findIndex((s) => s.key === activeStageKey);
          const Icon = stage.icon;
          return (
            <span
              key={stage.key}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] border transition-colors ${
                isActive
                  ? 'bg-[#00e6ff]/15 text-[#00e6ff] border-[#00e6ff]/40'
                  : isCompleted
                    ? 'bg-[#00e6ff]/8 text-[#00e6ff]/80 border-[#00e6ff]/25'
                    : 'bg-[#050505]/80 text-zinc-500 border-[#c5a062]/15'
              }`}
            >
              <Icon className="w-2.5 h-2.5" />
              {stage.label}
            </span>
          );
        })}
      </div>

      {/* Live thumbnails */}
      {liveImages.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-[#c5a062]/15">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-zinc-500">
              Generating ({liveImages.length})
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {liveImages.map((img) => {
              const isReady = img.status === 'ready' && (img.url || img.base64);
              const isError = img.status === 'error';
              return (
                <div
                  key={img.id}
                  className="relative aspect-square rounded-xl overflow-hidden bg-zinc-900 border border-[#c5a062]/15 hover:border-[#c5a062]/35 transition-colors"
                  title={img.modelInfo?.modelName || img.modelInfo?.modelId}
                >
                  {isReady ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={img.url || `data:image/png;base64,${img.base64}`}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center gap-1">
                      {isError ? (
                        <XCircle className="w-4 h-4 text-red-500" />
                      ) : (
                        <Loader2 className="w-4 h-4 text-[#00e6ff] animate-spin motion-reduce:animate-none" />
                      )}
                      <span className="text-[9px] text-zinc-500 px-1 text-center line-clamp-1">
                        {img.modelInfo?.modelName || 'model'}
                      </span>
                    </div>
                  )}
                  {isReady && (
                    <div className="absolute bottom-0 left-0 right-0 px-1.5 py-0.5 bg-black/60 backdrop-blur-sm flex items-center justify-between gap-1">
                      <p className="text-[9px] text-white truncate">
                        {img.modelInfo?.modelName}
                      </p>
                      {img.style && (
                        <span
                          className="shrink-0 px-1 py-0.5 text-[8px] font-medium bg-[#c5a062]/25 text-[#c5a062] border border-[#c5a062]/40 rounded-full max-w-[70px] truncate"
                          title={`Style: ${img.style}`}
                        >
                          {img.style}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
