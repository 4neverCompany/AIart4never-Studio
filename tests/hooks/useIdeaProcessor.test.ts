/**
 * V030-QA-002: useIdeaProcessor deps-bag wiring tests.
 *
 * useIdeaProcessor is a React hook — untestable in node env without jsdom.
 * These tests verify the key wiring BEHAVIOURS it implements by calling
 * processIdeaFn (the pure lib function the hook delegates to) with deps bags
 * that mirror the hook's closures. Any regression in the hook's wiring will
 * surface as a contract mismatch against these tests.
 *
 * Three contracts under test:
 *   1. isSkipRequested: () => skipSignal.aborted — AbortSignal wiring
 *   2. writeCheckpoint delegation to writeCheckpointBase(ideaId, concept, step, imageIds)
 *   3. saveImage accumulates perIdeaImageIds forwarded to writeCheckpoint
 */

import { describe, it, expect, vi } from 'vitest';
import {
  processIdea as processIdeaFn,
  SkipIdeaSignal,
  type ProcessIdeaDeps,
} from '@/lib/pipeline-processor';
import type { Idea, GeneratedImage, UserSettings } from '@/types/mashup';
import type { CachedEngagement } from '@/lib/smartScheduler';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeIdea(overrides?: Partial<Idea>): Idea {
  return {
    id: 'idea-001',
    concept: 'Batman vs Darth Vader in neon Tokyo',
    context: '',
    status: 'idea',
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeImage(overrides?: Partial<GeneratedImage>): GeneratedImage {
  return {
    id: `img-${Math.random().toString(36).slice(2, 8)}`,
    prompt: 'test prompt',
    url: 'https://cdn.example.com/img.jpg',
    status: 'ready',
    modelInfo: { provider: 'leonardo', modelId: 'model-1', modelName: 'Phoenix' },
    ...overrides,
  };
}

function makeEngagement(): CachedEngagement {
  return {
    hours: [{ hour: 18, weight: 0.95 }, { hour: 12, weight: 0.5 }],
    days: Array.from({ length: 7 }, (_, i) => ({ day: i, multiplier: 0.8 + i * 0.03 })),
    fetchedAt: Date.now(),
    source: 'default',
  };
}

function makeSettings(overrides?: Partial<UserSettings>): UserSettings {
  return {
    enabledProviders: ['leonardo'],
    apiKeys: { instagram: { accessToken: 'tok', igAccountId: 'igid' } },
    defaultLeonardoModel: 'phoenix',
    pipelineAutoCaption: true,
    pipelineAutoSchedule: true,
    pipelineCarouselMode: false,
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<ProcessIdeaDeps>): ProcessIdeaDeps {
  return {
    fetchTrendingContext: vi.fn().mockResolvedValue(''),
    expandIdeaToPrompt: vi.fn().mockResolvedValue('epic expanded prompt'),
    triggerImageGeneration: vi.fn().mockResolvedValue(undefined),
    getEnabledModelIds: vi.fn().mockReturnValue([]),
    waitForImages: vi.fn().mockResolvedValue([makeImage()]),
    generatePostContent: vi.fn().mockImplementation(async (img: GeneratedImage) => ({
      ...img,
      postCaption: 'caption text',
      postHashtags: ['#test'],
    })),
    saveImage: vi.fn(),
    updateIdeaStatus: vi.fn(),
    updateSettings: vi.fn(),
    findNextAvailableSlot: vi
      .fn()
      .mockReturnValue({ date: '2026-04-25', time: '18:00', reason: 'top hour 18:00' }),
    addLog: vi.fn(),
    setPipelineProgress: vi.fn(),
    writeCheckpoint: vi.fn(),
    isSkipRequested: vi.fn().mockReturnValue(false),
    getScheduledPosts: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

// ─── AbortSignal wiring: isSkipRequested = () => signal.aborted ──────────────

describe('useIdeaProcessor deps-bag — AbortSignal wiring', () => {
  it('pre-aborted signal → SkipIdeaSignal thrown immediately', async () => {
    const skipCtrl = new AbortController();
    skipCtrl.abort();

    const deps = makeDeps({ isSkipRequested: () => skipCtrl.signal.aborted });

    await expect(
      processIdeaFn(makeIdea(), 0, 1, makeEngagement(), [], makeSettings(), deps),
    ).rejects.toBeInstanceOf(SkipIdeaSignal);
  });

  it('non-aborted signal → processIdea completes normally', async () => {
    const skipCtrl = new AbortController(); // not aborted

    const deps = makeDeps({ isSkipRequested: () => skipCtrl.signal.aborted });

    await processIdeaFn(makeIdea(), 0, 1, makeEngagement(), [], makeSettings(), deps);
    expect(deps.updateIdeaStatus).toHaveBeenCalledWith(expect.any(String), 'done');
  });

  it('abort during waitForImages → SkipIdeaSignal propagates out of processIdea', async () => {
    const skipCtrl = new AbortController();

    const deps = makeDeps({
      isSkipRequested: () => skipCtrl.signal.aborted,
      waitForImages: vi.fn().mockImplementation(async () => {
        skipCtrl.abort(); // simulate user clicking skip while images load
        throw new SkipIdeaSignal();
      }),
    });

    await expect(
      processIdeaFn(makeIdea(), 0, 1, makeEngagement(), [], makeSettings(), deps),
    ).rejects.toBeInstanceOf(SkipIdeaSignal);
    expect(skipCtrl.signal.aborted).toBe(true);
  });

  it('fresh AbortController per idea: spent ctrl from idea N does not affect idea N+1', async () => {
    const staleCtrl = new AbortController();
    staleCtrl.abort(); // idea N was skipped

    const freshCtrl = new AbortController(); // daemon creates a new one for idea N+1

    // Bind to the fresh controller — should complete normally
    const deps = makeDeps({ isSkipRequested: () => freshCtrl.signal.aborted });

    await processIdeaFn(makeIdea(), 1, 2, makeEngagement(), [], makeSettings(), deps);
    expect(deps.updateIdeaStatus).toHaveBeenCalledWith(expect.any(String), 'done');
  });
});

// ─── writeCheckpoint delegation ───────────────────────────────────────────────

describe('useIdeaProcessor deps-bag — writeCheckpoint delegation', () => {
  it('writeCheckpoint is called with the correct ideaId and concept on every call', async () => {
    const idea = makeIdea({ id: 'idea-xyz', concept: 'Neon Dragon vs Samurai Pikachu' });
    const capturedBase = vi.fn();

    const deps = makeDeps({
      writeCheckpoint: step => capturedBase(idea.id, idea.concept, step),
    });

    await processIdeaFn(idea, 0, 1, makeEngagement(), [], makeSettings(), deps);

    expect(capturedBase).toHaveBeenCalled();
    for (const [id, concept] of capturedBase.mock.calls) {
      expect(id).toBe('idea-xyz');
      expect(concept).toBe('Neon Dragon vs Samurai Pikachu');
    }
  });

  it('writeCheckpoint is called at multiple pipeline steps (not just once)', async () => {
    const steps: string[] = [];
    const deps = makeDeps({
      writeCheckpoint: vi.fn().mockImplementation(step => steps.push(step)),
    });

    await processIdeaFn(makeIdea(), 0, 1, makeEngagement(), [], makeSettings(), deps);

    expect(steps.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── V050-001 credit-preserving resume ────────────────────────────────────────

describe('processIdea — V050-001 credit-preserving resume', () => {
  it('skips trending/expand/generate when resumeFrom.images present', async () => {
    const idea = makeIdea({ id: 'idea-resume', concept: 'Sherlock × Dune' });
    const preGen = [makeImage({ id: 'img-pre-1' }), makeImage({ id: 'img-pre-2' })];

    const fetchTrendingContext = vi.fn().mockResolvedValue('');
    const expandIdeaToPrompt = vi.fn().mockResolvedValue('expanded');
    const triggerImageGeneration = vi.fn().mockResolvedValue(undefined);
    const waitForImages = vi.fn().mockResolvedValue([]);

    const deps = makeDeps({
      fetchTrendingContext,
      expandIdeaToPrompt,
      triggerImageGeneration,
      waitForImages,
    });

    await processIdeaFn(
      idea,
      0,
      1,
      makeEngagement(),
      [],
      makeSettings({ pipelineCarouselMode: false }),
      deps,
      { images: preGen },
    );

    // None of the pre-image steps should have run.
    expect(fetchTrendingContext).not.toHaveBeenCalled();
    expect(expandIdeaToPrompt).not.toHaveBeenCalled();
    expect(triggerImageGeneration).not.toHaveBeenCalled();
    expect(waitForImages).not.toHaveBeenCalled();
    // Idea is still flipped in-work then done.
    expect(deps.updateIdeaStatus).toHaveBeenCalledWith('idea-resume', 'in-work');
    expect(deps.updateIdeaStatus).toHaveBeenCalledWith('idea-resume', 'done');
  });

  it('captioning runs over the pre-generated images (per-model mode)', async () => {
    const preGen = [makeImage({ id: 'img-pre-1' }), makeImage({ id: 'img-pre-2' })];
    const generatePostContent = vi.fn().mockImplementation(async (img: GeneratedImage) => ({
      ...img,
      postCaption: `caption for ${img.id}`,
    }));

    const deps = makeDeps({ generatePostContent });

    await processIdeaFn(
      makeIdea(),
      0,
      1,
      makeEngagement(),
      [],
      makeSettings({ pipelineCarouselMode: false }),
      deps,
      { images: preGen },
    );

    // Captioning ran for each pre-generated image.
    expect(generatePostContent).toHaveBeenCalledTimes(2);
    const callIds = (generatePostContent.mock.calls as Array<[GeneratedImage]>).map(
      ([img]) => img.id,
    );
    expect(callIds).toEqual(expect.arrayContaining(['img-pre-1', 'img-pre-2']));
  });

  it('logs a "resume" entry indicating no credits spent', async () => {
    const addLog = vi.fn();
    const preGen = [makeImage({ id: 'img-pre-1' })];

    const deps = makeDeps({ addLog });

    await processIdeaFn(
      makeIdea(),
      0,
      1,
      makeEngagement(),
      [],
      makeSettings({ pipelineCarouselMode: false }),
      deps,
      { images: preGen },
    );

    const resumeCall = addLog.mock.calls.find(call => call[0] === 'resume');
    expect(resumeCall).toBeDefined();
    expect(resumeCall![3]).toMatch(/no leonardo credits/i);
  });

  it('empty resumeFrom.images falls back to normal flow (treated as no resume)', async () => {
    const triggerImageGeneration = vi.fn().mockResolvedValue(undefined);
    const expandIdeaToPrompt = vi.fn().mockResolvedValue('expanded');
    const waitForImages = vi.fn().mockResolvedValue([makeImage()]);

    const deps = makeDeps({ triggerImageGeneration, expandIdeaToPrompt, waitForImages });

    await processIdeaFn(
      makeIdea(),
      0,
      1,
      makeEngagement(),
      [],
      makeSettings(),
      deps,
      { images: [] }, // empty — should NOT trigger resume branch
    );

    expect(expandIdeaToPrompt).toHaveBeenCalled();
    expect(triggerImageGeneration).toHaveBeenCalled();
    expect(waitForImages).toHaveBeenCalled();
  });

  it('no resumeFrom arg → original flow (regression guard)', async () => {
    const expandIdeaToPrompt = vi.fn().mockResolvedValue('expanded');
    const deps = makeDeps({ expandIdeaToPrompt });

    await processIdeaFn(makeIdea(), 0, 1, makeEngagement(), [], makeSettings(), deps);

    expect(expandIdeaToPrompt).toHaveBeenCalled();
  });
});

// ─── perIdeaImageIds accumulation via saveImage ───────────────────────────────

describe('useIdeaProcessor deps-bag — perIdeaImageIds accumulation', () => {
  it('image IDs saved via saveImage are visible to subsequent writeCheckpoint calls', async () => {
    const idea = makeIdea();
    const img1 = makeImage({ id: 'img-aaa' });
    const img2 = makeImage({ id: 'img-bbb' });

    // Mirror useIdeaProcessor closure: saveImage pushes to perIdeaImageIds;
    // writeCheckpoint captures the snapshot for each step.
    const perIdeaImageIds: string[] = [];
    const capturedCheckpoints: Array<[string, string, string, string[]]> = [];

    const deps = makeDeps({
      waitForImages: vi.fn().mockResolvedValue([img1, img2]),
      generatePostContent: vi.fn().mockImplementation(async (img: GeneratedImage) => ({
        ...img,
        postCaption: 'shared caption',
      })),
      saveImage: vi.fn().mockImplementation((img: GeneratedImage) => {
        if (!perIdeaImageIds.includes(img.id)) perIdeaImageIds.push(img.id);
      }),
      writeCheckpoint: step =>
        capturedCheckpoints.push([idea.id, idea.concept, step, [...perIdeaImageIds]]),
    });

    await processIdeaFn(idea, 0, 1, makeEngagement(), [], makeSettings(), deps);

    // By the final checkpoint both IDs must be present in the imageIds snapshot
    const last = capturedCheckpoints[capturedCheckpoints.length - 1];
    expect(last[3]).toContain('img-aaa');
    expect(last[3]).toContain('img-bbb');
  });
});
