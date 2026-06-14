// SHOULDFIX-001 / V030-001: applyResumeCheckpoint captures the side-effect
// flow of usePipeline.acceptResume. Tests spy on the deps bag with vi.fn
// to verify order, values, and conditional branches (no cp, idea not
// in-work, etc).
//
// V030-001: refs were dropped from the deps bag — the daemon reads live
// values via functional setState peek, and getIdeas() replaces ideasRef.

import { describe, it, expect, vi } from 'vitest';
import { applyResumeCheckpoint } from '@/lib/resume-checkpoint';
import type { PipelineCheckpoint } from '@/lib/pipeline-checkpoint';
import type { Idea, GeneratedImage } from '@/types/mashup';
import type { ApplyResumeDeps } from '@/lib/resume-checkpoint';

function makeImage(id: string): GeneratedImage {
  return {
    id,
    prompt: 'test prompt',
    url: `https://cdn.example.com/${id}.jpg`,
    status: 'ready',
    modelInfo: { provider: 'leonardo', modelId: 'm', modelName: 'M' },
  };
}

function makeCheckpoint(over: Partial<PipelineCheckpoint> = {}): PipelineCheckpoint {
  return {
    ideaId: 'idea-7',
    step: 'Captioning',
    concept: 'Dune crossover',
    ts: '2026-04-18T12:00:00Z',
    settings: { delay: 45, continuous: true, interval: 90, targetDays: 14 },
    imageIds: ['img-a'],
    ...over,
  };
}

function makeDeps(ideas: Idea[] = []): { deps: ApplyResumeDeps } {
  const deps: ApplyResumeDeps = {
    setPipelineDelayState: vi.fn(),
    setPipelineContinuous: vi.fn(),
    setPipelineIntervalState: vi.fn(),
    setPipelineTargetDaysState: vi.fn(),
    getIdeas: () => ideas,
    updateIdeaStatus: vi.fn(),
    setPendingResume: vi.fn(),
    startPipeline: vi.fn(),
  };
  return { deps };
}

describe('applyResumeCheckpoint', () => {
  it('no-ops when checkpoint is null', () => {
    const { deps } = makeDeps();
    applyResumeCheckpoint(null, deps);
    expect(deps.setPipelineDelayState).not.toHaveBeenCalled();
    expect(deps.setPendingResume).not.toHaveBeenCalled();
    expect(deps.startPipeline).not.toHaveBeenCalled();
    expect(deps.updateIdeaStatus).not.toHaveBeenCalled();
  });

  it('applies all four settings via setters', () => {
    const cp = makeCheckpoint();
    const { deps } = makeDeps();
    applyResumeCheckpoint(cp, deps);

    expect(deps.setPipelineDelayState).toHaveBeenCalledWith(45);
    expect(deps.setPipelineContinuous).toHaveBeenCalledWith(true);
    expect(deps.setPipelineIntervalState).toHaveBeenCalledWith(90);
    expect(deps.setPipelineTargetDaysState).toHaveBeenCalledWith(14);
  });

  it('flips in-work idea back to idea status', () => {
    const cp = makeCheckpoint({ ideaId: 'idea-7' });
    const ideas: Idea[] = [
      { id: 'idea-7', concept: 'x', context: '', status: 'in-work', createdAt: 0 },
    ];
    const { deps } = makeDeps(ideas);
    applyResumeCheckpoint(cp, deps);
    expect(deps.updateIdeaStatus).toHaveBeenCalledWith('idea-7', 'idea');
  });

  it('does NOT flip status if idea is already done', () => {
    const cp = makeCheckpoint({ ideaId: 'idea-7' });
    const ideas: Idea[] = [
      { id: 'idea-7', concept: 'x', context: '', status: 'done', createdAt: 0 },
    ];
    const { deps } = makeDeps(ideas);
    applyResumeCheckpoint(cp, deps);
    expect(deps.updateIdeaStatus).not.toHaveBeenCalled();
  });

  it('does NOT flip status if idea is missing from the list', () => {
    const cp = makeCheckpoint({ ideaId: 'ghost' });
    const { deps } = makeDeps([]);
    applyResumeCheckpoint(cp, deps);
    expect(deps.updateIdeaStatus).not.toHaveBeenCalled();
  });

  it('clears pendingResume before calling startPipeline', () => {
    const cp = makeCheckpoint();
    const { deps } = makeDeps();
    const callOrder: string[] = [];
    (deps.setPendingResume as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('setPendingResume');
    });
    (deps.startPipeline as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('startPipeline');
    });
    applyResumeCheckpoint(cp, deps);
    expect(callOrder).toEqual(['setPendingResume', 'startPipeline']);
  });

  it('handles an idea in "idea" (not in-work) status — no flip needed', () => {
    const cp = makeCheckpoint({ ideaId: 'idea-7' });
    const ideas: Idea[] = [
      { id: 'idea-7', concept: 'x', context: '', status: 'idea', createdAt: 0 },
    ];
    const { deps } = makeDeps(ideas);
    applyResumeCheckpoint(cp, deps);
    expect(deps.updateIdeaStatus).not.toHaveBeenCalled();
    expect(deps.startPipeline).toHaveBeenCalled();
  });
});

// V050-001: credit-preserving resume — applyResumeCheckpoint hydrates the
// resume hint from saved gallery images and forwards it to startPipeline.
describe('applyResumeCheckpoint — V050-001 credit-preserving resume hint', () => {
  it('passes hint with images to startPipeline when checkpoint imageIds exist in saved gallery', () => {
    const cp = makeCheckpoint({ ideaId: 'idea-7', imageIds: ['img-a', 'img-b'] });
    const saved = [makeImage('img-a'), makeImage('img-b'), makeImage('img-c')];
    const { deps } = makeDeps();
    deps.getSavedImages = () => saved;

    applyResumeCheckpoint(cp, deps);

    const sp = deps.startPipeline as ReturnType<typeof vi.fn>;
    expect(sp).toHaveBeenCalledTimes(1);
    const hint = sp.mock.calls[0][0];
    expect(hint).toBeDefined();
    expect(hint.ideaId).toBe('idea-7');
    expect(hint.images.map((i: GeneratedImage) => i.id)).toEqual(['img-a', 'img-b']);
  });

  it('partial hit: only existing images are forwarded; missing ids are dropped', () => {
    const cp = makeCheckpoint({ imageIds: ['img-a', 'img-missing', 'img-b'] });
    const saved = [makeImage('img-a'), makeImage('img-b')];
    const { deps } = makeDeps();
    deps.getSavedImages = () => saved;

    applyResumeCheckpoint(cp, deps);

    const sp = deps.startPipeline as ReturnType<typeof vi.fn>;
    const hint = sp.mock.calls[0][0];
    expect(hint.images).toHaveLength(2);
    expect(hint.images.map((i: GeneratedImage) => i.id)).toEqual(['img-a', 'img-b']);
  });

  it('no hint passed when imageIds are present but none match saved gallery (full restart)', () => {
    const cp = makeCheckpoint({ imageIds: ['img-gone-1', 'img-gone-2'] });
    const { deps } = makeDeps();
    deps.getSavedImages = () => [makeImage('img-other')];

    applyResumeCheckpoint(cp, deps);

    const sp = deps.startPipeline as ReturnType<typeof vi.fn>;
    expect(sp).toHaveBeenCalledTimes(1);
    expect(sp.mock.calls[0][0]).toBeUndefined();
  });

  it('no hint passed when checkpoint has empty imageIds (pre-V050 checkpoint)', () => {
    const cp = makeCheckpoint({ imageIds: [] });
    const { deps } = makeDeps();
    deps.getSavedImages = () => [makeImage('img-a')];

    applyResumeCheckpoint(cp, deps);

    const sp = deps.startPipeline as ReturnType<typeof vi.fn>;
    expect(sp.mock.calls[0][0]).toBeUndefined();
  });

  it('no hint passed when getSavedImages dep is omitted (back-compat)', () => {
    const cp = makeCheckpoint({ imageIds: ['img-a'] });
    const { deps } = makeDeps();
    // deliberately do NOT set getSavedImages

    applyResumeCheckpoint(cp, deps);

    const sp = deps.startPipeline as ReturnType<typeof vi.fn>;
    expect(sp.mock.calls[0][0]).toBeUndefined();
  });
});
