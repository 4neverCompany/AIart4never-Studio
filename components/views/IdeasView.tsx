'use client';

// V050-002 Phase 1: extraction of the Ideas tab kanban from
// MainContent (was lines 1911-2071). The component is presentational —
// every handler/state field comes in via props from the parent so we
// don't reach back into MashupContext from here. That keeps the surface
// explicit and makes future testing trivial (mock the props bag).

import { Lightbulb, Trash2, Loader2, Zap, CheckCircle2 } from 'lucide-react';
import { DailyDigest } from '../ideas/DailyDigest';
import type { Idea, ViewType } from '@/types/mashup';

export interface IdeasViewProps {
  ideas: Idea[];
  isPushing: boolean;
  setView: (v: ViewType) => void;
  clearIdeas: () => void;
  updateIdeaStatus: (id: string, status: Idea['status']) => void;
  deleteIdea: (id: string) => void;
  handlePushIdeaToCompare: (concept: string) => void;
}

const STATUS_CONFIG = {
  'idea': {
    icon: Lightbulb,
    label: 'Idea',
    iconColor: 'text-amber-400',
    iconBg: 'bg-amber-600/20 border-amber-500/30',
    hoverBorder: 'hover:border-amber-500/30',
  },
  'in-work': {
    icon: Zap,
    label: 'In Work',
    iconColor: 'text-emerald-400',
    iconBg: 'bg-emerald-600/20 border-emerald-500/30',
    hoverBorder: 'hover:border-emerald-500/30',
  },
  'done': {
    icon: CheckCircle2,
    label: 'Done',
    iconColor: 'text-zinc-300',
    iconBg: 'bg-zinc-800/80 border-zinc-700/60',
    hoverBorder: 'hover:border-zinc-500/30',
  },
} as const;

export function IdeasView({
  ideas,
  isPushing,
  setView,
  clearIdeas,
  updateIdeaStatus,
  deleteIdea,
  handlePushIdeaToCompare,
}: IdeasViewProps) {
  return (
    <div className="space-y-6 h-full flex flex-col">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="icon-box-gold">
            <Lightbulb className="w-5 h-5 text-[#c5a062]" />
          </div>
          <div>
            <h2 className="type-title">Ideas Board</h2>
            <p className="type-muted">Review, approve, and push brainstormed ideas to the Studio</p>
          </div>
        </div>
        <button
          onClick={clearIdeas}
          className="px-3 py-1.5 text-xs bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 rounded-xl font-medium transition-colors flex items-center gap-1.5"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Clear All
        </button>
      </div>

      <DailyDigest setView={setView} />

      <div className="flex flex-col md:flex-row gap-6 flex-1 min-h-[500px]">
        {(['idea', 'in-work', 'done'] as const).map((status) => {
          const statusCfg = STATUS_CONFIG[status];
          const StatusIcon = statusCfg.icon;
          return (
            <div
              key={status}
              className="flex-1 card p-4 flex flex-col gap-4"
              onDragOver={(e) => {
                e.preventDefault();
                // STORY-132: explicit move effect — without this Chromium
                // shows a no-entry cursor and refuses the drop.
                e.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(e) => {
                e.preventDefault();
                // STORY-132 followup: WebView2 strips non-MIME keys, so
                // we set 'text/plain' with a prefix and fall back to the
                // legacy 'ideaId' for any cached old build.
                const raw =
                  e.dataTransfer.getData('text/plain') ||
                  e.dataTransfer.getData('ideaId');
                const ideaId = raw.startsWith('idea:') ? raw.slice(5) : raw;
                if (ideaId) updateIdeaStatus(ideaId, status);
              }}
            >
              <h3 className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <span className={`w-7 h-7 rounded-lg border flex items-center justify-center ${statusCfg.iconBg}`}>
                    <StatusIcon className={`w-3.5 h-3.5 ${statusCfg.iconColor}`} />
                  </span>
                  <span className="text-sm font-semibold text-white">{statusCfg.label}</span>
                </span>
                <span className="bg-zinc-800/80 text-zinc-400 rounded-full px-2 py-0.5 text-[10px]">
                  {ideas.filter((i) => i.status === status).length}
                </span>
              </h3>
              <div className="flex flex-col gap-3 overflow-y-auto hide-scrollbar flex-1">
                {ideas.filter((i) => i.status === status).length === 0 && (
                  <div className="flex-1 flex flex-col items-center justify-center py-10 border-2 border-dashed border-zinc-800/60 rounded-xl text-zinc-600 text-xs gap-2 select-none">
                    <StatusIcon className={`w-6 h-6 ${statusCfg.iconColor} opacity-30`} />
                    {status === 'idea' ? 'No ideas yet — generate some in the sidebar' : `Drag cards here`}
                  </div>
                )}
                {ideas.filter((i) => i.status === status).map((idea) => (
                  <div
                    key={idea.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', `idea:${idea.id}`);
                      e.dataTransfer.setData('ideaId', idea.id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    className={`card p-4 flex flex-col gap-3 cursor-grab active:cursor-grabbing transition-all duration-200 ${statusCfg.hoverBorder}`}
                  >
                    {idea.context && <h4 className="text-sm font-bold text-amber-400">{idea.context}</h4>}
                    <p className="text-xs text-zinc-300 line-clamp-4">{idea.concept}</p>
                    <div className="flex items-center justify-between mt-auto pt-3 border-t border-[#c5a062]/15">
                      <span className="text-[10px] text-zinc-500">
                        {new Date(idea.createdAt).toLocaleDateString()}
                      </span>
                      <div className="flex gap-1">
                        {status === 'idea' && (
                          <button
                            onClick={() => updateIdeaStatus(idea.id, 'in-work')}
                            className="btn-blue-sm text-[10px] py-1 px-2 rounded-lg"
                          >
                            Approve
                          </button>
                        )}
                        {status === 'in-work' && (
                          <>
                            <button
                              onClick={() => handlePushIdeaToCompare(idea.concept)}
                              disabled={isPushing}
                              className="btn-blue-sm text-[10px] py-1 px-2 rounded-lg gap-1"
                            >
                              {isPushing ? <Loader2 className="w-2 h-2 animate-spin" /> : <Zap className="w-2 h-2" />}
                              To Studio
                            </button>
                            <button
                              onClick={() => updateIdeaStatus(idea.id, 'done')}
                              className="btn-blue-sm text-[10px] py-1 px-2 rounded-lg"
                            >
                              Done
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => deleteIdea(idea.id)}
                          className="text-[10px] bg-zinc-800 hover:bg-zinc-700 text-zinc-400 px-2 py-1 rounded-lg"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
