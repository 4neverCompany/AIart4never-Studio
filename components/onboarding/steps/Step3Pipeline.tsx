'use client';

import { useState } from 'react';
import { Sparkles, MessageSquare, Check, Loader2, Circle, X as XIcon } from 'lucide-react';
import { useMashup } from '../../MashupContext';
import { pickStarterIdeas, type StarterIdea } from '../../../lib/onboarding-starter-ideas';

interface Step3Props {
  universes: string[];
  genres: string[];
  /** Live progress state owned by the wizard so the footer can react. */
  progress: PipelineOnceProgress;
  setProgress: (p: PipelineOnceProgress) => void;
}

export type PipelineOnceProgress =
  | { kind: 'idle' }
  | { kind: 'running'; selectedIdea: string; steps: StepState }
  | { kind: 'done'; selectedIdea: string }
  | { kind: 'error'; selectedIdea: string; failedAt: keyof StepState; message: string };

export interface StepState {
  ideaSelected: 'pending' | 'running' | 'done' | 'failed';
  imageGenerated: 'pending' | 'running' | 'done' | 'failed';
  captioned: 'pending' | 'running' | 'done' | 'failed';
  scheduled: 'pending' | 'running' | 'done' | 'failed';
}

/**
 * Step 3 — pick a starter idea (or jump to brainstorm sidebar) and
 * watch the pipeline-once progress. Real pipeline invocation is a
 * follow-up PROP (touches pipeline orchestration); this step simulates
 * progress visually and seeds the user's first Idea via addIdea so
 * the regular pipeline picks it up.
 */
export function Step3Pipeline({ universes, genres, progress, setProgress }: Step3Props) {
  const { addIdea, setIsSidebarOpen } = useMashup();
  const [pickedTitle, setPickedTitle] = useState<string | null>(null);

  const ideas = pickStarterIdeas(universes, genres, 5);
  const isRunning = progress.kind === 'running' || progress.kind === 'done';

  function handlePickIdea(idea: StarterIdea) {
    setPickedTitle(idea.title);
    addIdea(idea.concept);
    runSimulation(idea);
  }

  function handleBrainstorm() {
    setIsSidebarOpen(true);
  }

  function runSimulation(idea: StarterIdea) {
    // Visual-only stepper — flips each line through running → done with
    // a small stagger. The real generation runs in the background once
    // the wizard closes (idea is in addIdea queue; pipeline handles it).
    const initial: StepState = {
      ideaSelected: 'done',
      imageGenerated: 'running',
      captioned: 'pending',
      scheduled: 'pending',
    };
    setProgress({ kind: 'running', selectedIdea: idea.title, steps: initial });

    setTimeout(() => {
      setProgress({
        kind: 'running', selectedIdea: idea.title,
        steps: { ideaSelected: 'done', imageGenerated: 'done', captioned: 'running', scheduled: 'pending' },
      });
    }, 1200);
    setTimeout(() => {
      setProgress({
        kind: 'running', selectedIdea: idea.title,
        steps: { ideaSelected: 'done', imageGenerated: 'done', captioned: 'done', scheduled: 'running' },
      });
    }, 2200);
    setTimeout(() => {
      setProgress({ kind: 'done', selectedIdea: idea.title });
    }, 3000);
  }

  if (isRunning) {
    return <RunningView progress={progress} pickedTitle={pickedTitle} />;
  }

  if (progress.kind === 'error') {
    return <ErrorView progress={progress} onRetry={() => {
      const found = ideas.find((i) => i.title === pickedTitle);
      if (found) runSimulation(found);
    }} onSkip={() => setProgress({ kind: 'idle' })} />;
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 id="onboarding-title" className="text-xl font-bold text-white">Make your first post</h3>
        <p className="text-sm text-zinc-400 mt-1">
          Pick or brainstorm an idea. We&rsquo;ll generate the image and caption right now.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#c5a062]" />
            <h4 className="text-sm font-bold text-white">Use a starter idea</h4>
          </div>
          <p className="text-xs text-zinc-500">Curated ideas based on your niches:</p>
          <div className="space-y-1.5">
            {ideas.map((idea) => (
              <button
                key={idea.title}
                type="button"
                onClick={() => handlePickIdea(idea)}
                className="w-full text-left px-3 py-2 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-[#c5a062]/40 rounded-lg text-xs text-zinc-200 transition-colors"
              >
                {idea.title}
              </button>
            ))}
          </div>
        </div>

        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-[#c5a062]" />
              <h4 className="text-sm font-bold text-white">Brainstorm with AI</h4>
            </div>
            <p className="text-xs text-zinc-500 mt-2">
              Open the chat sidebar pre-filled with your niches.
            </p>
          </div>
          <button
            type="button"
            onClick={handleBrainstorm}
            className="px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 rounded-lg transition-colors w-full mt-3"
          >
            Open sidebar
          </button>
        </div>
      </div>
    </div>
  );
}

function RunningView({ progress, pickedTitle }: { progress: PipelineOnceProgress; pickedTitle: string | null }) {
  const steps = progress.kind === 'running' ? progress.steps : {
    ideaSelected: 'done', imageGenerated: 'done', captioned: 'done', scheduled: 'done',
  } as StepState;

  return (
    <div className="space-y-5">
      <div>
        <h3 id="onboarding-title" className="text-xl font-bold text-white">Generating your first post</h3>
        <p className="text-sm text-zinc-400 mt-1">
          The pipeline is taking it from here.
        </p>
      </div>

      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-2.5">
        <ProgressLine state={steps.ideaSelected} label={pickedTitle ? `Idea selected — “${pickedTitle}”` : 'Idea selected'} />
        <ProgressLine state={steps.imageGenerated} label="Image generated" />
        <ProgressLine state={steps.captioned} label="Captioning…" />
        <ProgressLine state={steps.scheduled} label="Scheduling" />
      </div>
    </div>
  );
}

function ErrorView({ progress, onRetry, onSkip }: { progress: PipelineOnceProgress & { kind: 'error' }; onRetry: () => void; onSkip: () => void }) {
  return (
    <div className="space-y-4">
      <div>
        <h3 id="onboarding-title" className="text-xl font-bold text-red-300">Something failed</h3>
        <p className="text-sm text-zinc-400 mt-1">{progress.message}</p>
      </div>
      <div className="flex gap-2">
        <button onClick={onRetry} className="px-3 py-1.5 text-xs bg-[#c5a062] text-zinc-950 font-medium rounded-lg">
          Retry
        </button>
        <button onClick={onSkip} className="px-3 py-1.5 text-xs bg-zinc-800 text-zinc-200 rounded-lg">Skip and continue</button>
      </div>
    </div>
  );
}

function ProgressLine({ state, label }: { state: StepState[keyof StepState]; label: string }) {
  return (
    <div className="flex items-center gap-2.5 text-sm">
      {state === 'pending' && <Circle className="w-4 h-4 text-zinc-600" />}
      {state === 'running' && <Loader2 className="w-4 h-4 text-[#c5a062] animate-spin" />}
      {state === 'done' && <Check className="w-4 h-4 text-emerald-500" />}
      {state === 'failed' && <XIcon className="w-4 h-4 text-red-500" />}
      <span className={state === 'done' ? 'text-zinc-200' : state === 'pending' ? 'text-zinc-500' : 'text-zinc-300'}>
        {label}
      </span>
    </div>
  );
}
