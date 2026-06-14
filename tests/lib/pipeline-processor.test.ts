import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processIdea, SkipIdeaSignal, type ProcessIdeaDeps } from '@/lib/pipeline-processor';
import { withPipelineRunning } from '@/lib/pipeline-runner';
import type { Idea, GeneratedImage, UserSettings, ScheduledPost, PipelineProgress } from '@/types/mashup';
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
    apiKeys: {
      instagram: { accessToken: 'tok', igAccountId: 'igid' },
    },
    defaultLeonardoModel: 'phoenix',
    pipelineAutoCaption: true,
    pipelineAutoSchedule: true,
    pipelineCarouselMode: false,
    ...overrides,
  };
}

function makeSlot() {
  return { date: '2026-04-25', time: '18:00', reason: 'IG insights — best hour 18:00' };
}

/** Build a full deps mock. Override individual fns as needed per test. */
function makeDeps(overrides?: Partial<ProcessIdeaDeps>): ProcessIdeaDeps {
  return {
    fetchTrendingContext: vi.fn().mockResolvedValue('trending: neon cyberpunk'),
    expandIdeaToPrompt: vi.fn().mockResolvedValue('Epic Batman vs Vader neon Tokyo cinematic 4K'),
    triggerImageGeneration: vi.fn().mockResolvedValue(undefined),
    getEnabledModelIds: vi.fn().mockReturnValue([]),
    waitForImages: vi.fn().mockResolvedValue([makeImage()]),
    generatePostContent: vi.fn().mockImplementation(async (img: GeneratedImage) => ({
      ...img,
      postCaption: 'When two legends clash in neon Tokyo',
      postHashtags: ['#batman', '#starwars'],
    })),
    saveImage: vi.fn(),
    updateIdeaStatus: vi.fn(),
    updateSettings: vi.fn(),
    findNextAvailableSlot: vi.fn().mockReturnValue(makeSlot()),
    addLog: vi.fn(),
    setPipelineProgress: vi.fn(),
    writeCheckpoint: vi.fn(),
    isSkipRequested: vi.fn().mockReturnValue(false),
    getScheduledPosts: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

// ─── processIdea ─────────────────────────────────────────────────────────────

describe('MODEL-PRESELECT-FIX (2026-05-21): respects getEnabledModelIds', () => {
  it('forwards the user selection to triggerImageGeneration verbatim', async () => {
    // User deselected MiniMax in Studio Mode — only nano-banana-2 and
    // gpt-image-1.5 are enabled. Pipeline must call triggerImageGeneration
    // with that exact list, not LEONARDO_MODELS.
    const userSelection = ['nano-banana-2', 'gpt-image-1.5'];
    const trigger = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      triggerImageGeneration: trigger,
      getEnabledModelIds: vi.fn().mockReturnValue(userSelection),
    });
    await processIdea(makeIdea(), 0, 1, makeEngagement(), [], makeSettings(), deps);
    expect(trigger).toHaveBeenCalledOnce();
    const passedModelIds = trigger.mock.calls[0][1];
    expect(passedModelIds).toEqual(userSelection);
    expect(passedModelIds).not.toContain('minimax-image-01');
  });

  it('falls back to "all minus nano-banana" when selection is empty (brand-new user)', async () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      triggerImageGeneration: trigger,
      getEnabledModelIds: vi.fn().mockReturnValue([]),
    });
    await processIdea(makeIdea(), 0, 1, makeEngagement(), [], makeSettings(), deps);
    const passedModelIds = trigger.mock.calls[0][1] as string[];
    expect(passedModelIds.length).toBeGreaterThan(0);
    expect(passedModelIds).not.toContain('nano-banana');
  });

  it('strips nano-banana from the user selection as defense-in-depth', async () => {
    // The Studio UI seeds defaults with LEONARDO_MODELS.map(m=>m.id) which
    // includes nano-banana — without the redundant filter, fresh users
    // would regress back to the stale model.
    const trigger = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      triggerImageGeneration: trigger,
      getEnabledModelIds: vi.fn().mockReturnValue(['nano-banana', 'nano-banana-2']),
    });
    await processIdea(makeIdea(), 0, 1, makeEngagement(), [], makeSettings(), deps);
    const passedModelIds = trigger.mock.calls[0][1] as string[];
    expect(passedModelIds).toContain('nano-banana-2');
    expect(passedModelIds).not.toContain('nano-banana');
  });

  it('throws an actionable error when the user deselected every model', async () => {
    // Only nano-banana is "selected" — after the redundant strip nothing
    // remains. Pipeline must bail with a user-actionable message rather
    // than calling triggerImageGeneration with [] and timing out later.
    const deps = makeDeps({
      getEnabledModelIds: vi.fn().mockReturnValue(['nano-banana']),
    });
    await expect(
      processIdea(makeIdea(), 0, 1, makeEngagement(), [], makeSettings(), deps),
    ).rejects.toThrow(/No image models selected/);
  });
});

describe('V1.7.0-PIPELINE-HIGGSFIELD: Higgsfield models join the generation set', () => {
  it('appends configured higgsfield:<slug> ids when higgsfieldEnabled', async () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      triggerImageGeneration: trigger,
      getEnabledModelIds: vi.fn().mockReturnValue(['phoenix']),
    });
    const settings = makeSettings({
      higgsfieldEnabled: true,
      higgsfieldImageModels: ['nano_banana_2', 'flux_2'],
    });
    await processIdea(makeIdea(), 0, 1, makeEngagement(), [], settings, deps);
    const passed = trigger.mock.calls[0][1] as string[];
    expect(passed).toContain('phoenix');
    expect(passed).toContain('higgsfield:nano_banana_2');
    expect(passed).toContain('higgsfield:flux_2');
  });

  it('does NOT add higgsfield ids when the toggle is off', async () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      triggerImageGeneration: trigger,
      getEnabledModelIds: vi.fn().mockReturnValue(['phoenix']),
    });
    const settings = makeSettings({
      higgsfieldEnabled: false,
      higgsfieldImageModels: ['nano_banana_2'],
    });
    await processIdea(makeIdea(), 0, 1, makeEngagement(), [], settings, deps);
    const passed = trigger.mock.calls[0][1] as string[];
    expect(passed.some((id) => id.startsWith('higgsfield:'))).toBe(false);
  });

  it('can run a Higgsfield-only pipeline (no Leonardo selection, toggle on)', async () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      triggerImageGeneration: trigger,
      // empty selection → leonardo fallback, but the user wants higgsfield
      getEnabledModelIds: vi.fn().mockReturnValue([]),
    });
    const settings = makeSettings({
      higgsfieldEnabled: true,
      higgsfieldImageModels: ['nano_banana_2'],
    });
    await processIdea(makeIdea(), 0, 1, makeEngagement(), [], settings, deps);
    const passed = trigger.mock.calls[0][1] as string[];
    expect(passed).toContain('higgsfield:nano_banana_2');
  });
});

describe('processIdea — happy path (single mode)', () => {
  it('calls all steps in sequence and marks idea done', async () => {
    const deps = makeDeps();
    const idea = makeIdea();

    await processIdea(idea, 0, 1, makeEngagement(), [], makeSettings(), deps);

    expect(deps.updateIdeaStatus).toHaveBeenCalledWith(idea.id, 'in-work');
    expect(deps.expandIdeaToPrompt).toHaveBeenCalledOnce();
    expect(deps.triggerImageGeneration).toHaveBeenCalledOnce();
    expect(deps.waitForImages).toHaveBeenCalledOnce();
    expect(deps.generatePostContent).toHaveBeenCalledOnce();
    expect(deps.saveImage).toHaveBeenCalled();
    expect(deps.updateSettings).toHaveBeenCalled();
    expect(deps.updateIdeaStatus).toHaveBeenCalledWith(idea.id, 'done');
  });

  it('schedules exactly one post per image in single mode', async () => {
    const images = [makeImage(), makeImage()];
    const deps = makeDeps({ waitForImages: vi.fn().mockResolvedValue(images) });
    const accumulatedPosts: ScheduledPost[] = [];

    await processIdea(makeIdea(), 0, 1, makeEngagement(), accumulatedPosts, makeSettings(), deps);

    // Two images → two updateSettings calls for scheduling
    const scheduleCalls = (deps.updateSettings as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([arg]) => typeof arg === 'function',
    );
    expect(scheduleCalls.length).toBe(2);
    expect(accumulatedPosts).toHaveLength(2);
  });

  it('uses expandedPrompt as caption when generatePostContent returns undefined (pi-down)', async () => {
    const expandedPrompt = 'Epic Batman vs Vader neon Tokyo cinematic 4K';
    const deps = makeDeps({
      expandIdeaToPrompt: vi.fn().mockResolvedValue(expandedPrompt),
      generatePostContent: vi.fn().mockResolvedValue(undefined),
    });
    const idea = makeIdea();

    await processIdea(idea, 0, 1, makeEngagement(), [], makeSettings(), deps);

    // Should log the fallback
    expect(deps.addLog).toHaveBeenCalledWith(
      'caption',
      idea.id,
      'error',
      expect.stringContaining('fallback'),
    );
    // Idea must still complete
    expect(deps.updateIdeaStatus).toHaveBeenCalledWith(idea.id, 'done');
  });

  it('uses expandedPrompt as caption when generatePostContent throws (pi-down)', async () => {
    const deps = makeDeps({
      generatePostContent: vi.fn().mockRejectedValue(new Error('pi not running')),
    });
    const idea = makeIdea();

    await processIdea(idea, 0, 1, makeEngagement(), [], makeSettings(), deps);

    expect(deps.addLog).toHaveBeenCalledWith(
      'caption',
      idea.id,
      'error',
      expect.stringContaining('fallback'),
    );
    expect(deps.updateIdeaStatus).toHaveBeenCalledWith(idea.id, 'done');
  });
});

describe('processIdea — image generation timeout', () => {
  it('logs a timeout error when waitForImages returns empty but still marks idea done', async () => {
    const deps = makeDeps({ waitForImages: vi.fn().mockResolvedValue([]) });
    const idea = makeIdea();

    await processIdea(idea, 0, 1, makeEngagement(), [], makeSettings(), deps);

    expect(deps.addLog).toHaveBeenCalledWith(
      'image-ready',
      idea.id,
      'error',
      expect.stringContaining('Timed out'),
    );
    // No caption or scheduling attempted without images
    expect(deps.generatePostContent).not.toHaveBeenCalled();
    expect(deps.findNextAvailableSlot).not.toHaveBeenCalled();
    // Idea is still marked done (pipeline keeps moving)
    expect(deps.updateIdeaStatus).toHaveBeenCalledWith(idea.id, 'done');
  });
});

describe('processIdea — skip signal', () => {
  it('throws SkipIdeaSignal when isSkipRequested is true at first checkSkip in single mode', async () => {
    const deps = makeDeps({ isSkipRequested: vi.fn().mockReturnValue(true) });

    await expect(
      processIdea(makeIdea(), 0, 1, makeEngagement(), [], makeSettings(), deps),
    ).rejects.toBeInstanceOf(SkipIdeaSignal);
  });

  it('throws SkipIdeaSignal when waitForImages throws it (skip mid-poll)', async () => {
    const deps = makeDeps({
      waitForImages: vi.fn().mockRejectedValue(new SkipIdeaSignal()),
    });

    await expect(
      processIdea(makeIdea(), 0, 1, makeEngagement(), [], makeSettings(), deps),
    ).rejects.toBeInstanceOf(SkipIdeaSignal);
  });

  it('SkipIdeaSignal is not swallowed by the carousel caption try/catch', async () => {
    const skipSignal = new SkipIdeaSignal();
    const deps = makeDeps({
      waitForImages: vi.fn().mockResolvedValue([makeImage(), makeImage()]),
      generatePostContent: vi.fn().mockRejectedValue(skipSignal),
    });
    const settings = makeSettings({ pipelineCarouselMode: true });

    await expect(
      processIdea(makeIdea(), 0, 1, makeEngagement(), [], settings, deps),
    ).rejects.toBeInstanceOf(SkipIdeaSignal);
  });
});

describe('processIdea — carousel mode', () => {
  it('captions only the first image and fans result to all images via saveImage', async () => {
    const images = [makeImage(), makeImage(), makeImage()];
    const captionedFirst = { ...images[0], postCaption: 'Shared caption', postHashtags: ['#a'] };
    const deps = makeDeps({
      waitForImages: vi.fn().mockResolvedValue(images),
      generatePostContent: vi.fn().mockResolvedValue(captionedFirst),
    });
    const settings = makeSettings({ pipelineCarouselMode: true });

    await processIdea(makeIdea(), 0, 1, makeEngagement(), [], settings, deps);

    // generatePostContent called only once (for the anchor)
    expect(deps.generatePostContent).toHaveBeenCalledTimes(1);
    expect(deps.generatePostContent).toHaveBeenCalledWith(images[0]);
    // All 3 images + the captioned anchor = at least 4 saveImage calls
    expect(deps.saveImage).toHaveBeenCalledTimes(4);
    // Single scheduled post group (one updateSettings call with carousel group)
    expect(deps.updateSettings).toHaveBeenCalledOnce();
    expect(deps.updateIdeaStatus).toHaveBeenCalledWith(expect.any(String), 'done');
  });

  it('always gates carousels through approval — even when every platform auto-approves (BUG-CRIT-001)', async () => {
    // Pre-fix: this configuration would land as `scheduled`. Post-fix:
    // pipeline output unconditionally sits in pending_approval until the
    // user reviews. CarouselGroup.status mirrors at `draft`.
    const images = [makeImage(), makeImage()];
    const deps = makeDeps({ waitForImages: vi.fn().mockResolvedValue(images) });
    const settings = makeSettings({
      pipelineCarouselMode: true,
      pipelinePlatforms: ['twitter', 'discord'],
      pipelineAutoApprove: { twitter: true, discord: true },
    });

    await processIdea(makeIdea(), 0, 1, makeEngagement(), [], settings, deps);

    const updaterCall = (deps.updateSettings as ReturnType<typeof vi.fn>).mock.calls.find(
      ([arg]) => typeof arg === 'function',
    );
    expect(updaterCall).toBeDefined();
    const patch = (updaterCall![0] as (prev: Partial<UserSettings>) => Partial<UserSettings>)({});
    expect(patch.carouselGroups).toHaveLength(1);
    expect(patch.carouselGroups![0].status).toBe('draft');
    expect(patch.scheduledPosts!.every((p) => p.status === 'pending_approval')).toBe(true);
  });

  it('sets CarouselGroup.status = draft when any platform requires manual approval (V040-HOTFIX-004)', async () => {
    const images = [makeImage(), makeImage()];
    const deps = makeDeps({ waitForImages: vi.fn().mockResolvedValue(images) });
    const settings = makeSettings({
      pipelineCarouselMode: true,
      pipelinePlatforms: ['instagram', 'twitter'],
      pipelineAutoApprove: { instagram: false, twitter: true },
    });

    await processIdea(makeIdea(), 0, 1, makeEngagement(), [], settings, deps);

    const updaterCall = (deps.updateSettings as ReturnType<typeof vi.fn>).mock.calls.find(
      ([arg]) => typeof arg === 'function',
    );
    expect(updaterCall).toBeDefined();
    const patch = (updaterCall![0] as (prev: Partial<UserSettings>) => Partial<UserSettings>)({});
    expect(patch.carouselGroups).toHaveLength(1);
    expect(patch.carouselGroups![0].status).toBe('draft');
    expect(patch.scheduledPosts!.every((p) => p.status === 'pending_approval')).toBe(true);
  });

  it('marks saved images pipelinePending=true when post will gate on manual approval (V040-HOTFIX-007)', async () => {
    const images = [makeImage(), makeImage()];
    const deps = makeDeps({ waitForImages: vi.fn().mockResolvedValue(images) });
    const settings = makeSettings({
      pipelineCarouselMode: true,
      pipelinePlatforms: ['instagram', 'twitter'],
      pipelineAutoApprove: { instagram: false, twitter: true },
    });

    await processIdea(makeIdea(), 0, 1, makeEngagement(), [], settings, deps);

    const saveCalls = (deps.saveImage as ReturnType<typeof vi.fn>).mock.calls;
    expect(saveCalls.length).toBeGreaterThan(0);
    for (const [saved] of saveCalls) {
      expect(saved.pipelinePending).toBe(true);
    }
  });

  it('always marks saved images pipelinePending=true so they stay out of Gallery until approval (BUG-CRIT-001)', async () => {
    // Pre-fix: every-platform-auto-approves left pipelinePending undefined,
    // images appeared in Gallery un-watermarked. Post-fix: pipelinePending
    // is true for every pipeline-produced image, so Gallery + watermark
    // both wait until approveScheduledPost runs.
    const images = [makeImage(), makeImage()];
    const deps = makeDeps({ waitForImages: vi.fn().mockResolvedValue(images) });
    const settings = makeSettings({
      pipelineCarouselMode: true,
      pipelinePlatforms: ['twitter', 'discord'],
      pipelineAutoApprove: { twitter: true, discord: true },
    });

    await processIdea(makeIdea(), 0, 1, makeEngagement(), [], settings, deps);

    const saveCalls = (deps.saveImage as ReturnType<typeof vi.fn>).mock.calls;
    expect(saveCalls.length).toBeGreaterThan(0);
    for (const [saved] of saveCalls) {
      expect(saved.pipelinePending).toBe(true);
    }
  });

  it('falls back to expandedPrompt when carousel generatePostContent returns undefined', async () => {
    const images = [makeImage(), makeImage()];
    const expandedPrompt = 'Epic neon battle';
    const deps = makeDeps({
      expandIdeaToPrompt: vi.fn().mockResolvedValue(expandedPrompt),
      waitForImages: vi.fn().mockResolvedValue(images),
      generatePostContent: vi.fn().mockResolvedValue(undefined),
    });
    const settings = makeSettings({ pipelineCarouselMode: true });

    await processIdea(makeIdea(), 0, 1, makeEngagement(), [], settings, deps);

    expect(deps.addLog).toHaveBeenCalledWith(
      'caption',
      expect.any(String),
      'error',
      expect.stringContaining('fallback'),
    );
    expect(deps.updateIdeaStatus).toHaveBeenCalledWith(expect.any(String), 'done');
  });
});

describe('processIdea — pipeline stage toggles', () => {
  it('skips generatePostContent when autoCaption=false', async () => {
    const deps = makeDeps();
    await processIdea(
      makeIdea(),
      0,
      1,
      makeEngagement(),
      [],
      makeSettings({ pipelineAutoCaption: false }),
      deps,
    );
    expect(deps.generatePostContent).not.toHaveBeenCalled();
    expect(deps.updateIdeaStatus).toHaveBeenCalledWith(expect.any(String), 'done');
  });

  it('skips scheduling when autoSchedule=false', async () => {
    const deps = makeDeps();
    await processIdea(
      makeIdea(),
      0,
      1,
      makeEngagement(),
      [],
      makeSettings({ pipelineAutoSchedule: false }),
      deps,
    );
    expect(deps.findNextAvailableSlot).not.toHaveBeenCalled();
    expect(deps.updateIdeaStatus).toHaveBeenCalledWith(expect.any(String), 'done');
  });

  it('still creates a pending_approval post (with empty platforms) when no platforms configured — BUG-CRIT-009', async () => {
    // BUG-CRIT-009: pre-fix, an autoSchedule run with missing creds
    // logged "No platforms" and skipped scheduling — but the image
    // had already been saved with pipelinePending=true, leaving it
    // orphaned (hidden from Gallery, no approval card to release it).
    // Post-fix: the pipeline still creates a ScheduledPost with
    // platforms=[] in pending_approval status so the approval queue
    // has an entry that can clear pipelinePending later.
    const deps = makeDeps();
    const settings = makeSettings({ apiKeys: { leonardo: undefined } });
    const idea = makeIdea();

    await processIdea(idea, 0, 1, makeEngagement(), [], settings, deps);

    const updaterCall = (deps.updateSettings as ReturnType<typeof vi.fn>).mock.calls.find(
      ([arg]) => typeof arg === 'function',
    );
    expect(updaterCall).toBeDefined();
    const patch = (updaterCall![0] as (prev: Partial<UserSettings>) => Partial<UserSettings>)({});
    expect(patch.scheduledPosts!.length).toBeGreaterThan(0);
    const post = patch.scheduledPosts![0]!;
    expect(post.status).toBe('pending_approval');
    expect(post.platforms).toEqual([]);
    expect(deps.findNextAvailableSlot).toHaveBeenCalled();
  });

  // V041-HOTFIX-IG: regression — desktop users with creds in config.json
  // (not settings.apiKeys) used to fall through to "No platforms" because
  // the inferredPlatforms filter only looked at settings.apiKeys.
  it('infers instagram from desktopCreds when settings.apiKeys.instagram is absent', async () => {
    const deps = makeDeps({
      desktopCreds: {
        hasInstagramToken: true,
        hasInstagramAccountId: true,
        hasLeonardoKey: true,
        hasZaiKey: false,
        hasTwitterCreds: false,
        hasPinterestCreds: false,
        hasDiscordCreds: false,
      },
    });
    const settings = makeSettings({ apiKeys: { leonardo: 'k' } });
    const idea = makeIdea();

    await processIdea(idea, 0, 1, makeEngagement(), [], settings, deps);

    expect(deps.findNextAvailableSlot).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Object),
      ['instagram'],
      undefined,
    );
    expect(deps.addLog).not.toHaveBeenCalledWith(
      'schedule',
      idea.id,
      'error',
      expect.stringContaining('No platforms'),
    );
  });

  it('treats { accessToken: "", igAccountId: "" } as NOT configured (post lands with empty platforms)', async () => {
    // Pre-fix bug (V041-HOTFIX-IG): naive object truthiness on
    // settings.apiKeys.instagram accepted empty-string fields as a
    // configured platform, then the scheduler would build a post
    // that the social API immediately rejected.
    // BUG-CRIT-009: we now still create the ScheduledPost (so the
    // pipelinePending image has an approval entry to release it),
    // but with platforms=[] so the auto-poster correctly skips it.
    const deps = makeDeps();
    const settings = makeSettings({
      apiKeys: { instagram: { accessToken: '', igAccountId: '' } },
    });
    const idea = makeIdea();

    await processIdea(idea, 0, 1, makeEngagement(), [], settings, deps);

    const updaterCall = (deps.updateSettings as ReturnType<typeof vi.fn>).mock.calls.find(
      ([arg]) => typeof arg === 'function',
    );
    expect(updaterCall).toBeDefined();
    const patch = (updaterCall![0] as (prev: Partial<UserSettings>) => Partial<UserSettings>)({});
    expect(patch.scheduledPosts![0]!.platforms).toEqual([]);
  });
});

describe('processIdea — recoverable errors', () => {
  it('continues without trending context when fetchTrendingContext throws', async () => {
    const deps = makeDeps({
      fetchTrendingContext: vi.fn().mockRejectedValue(new Error('network error')),
    });

    await processIdea(makeIdea(), 0, 1, makeEngagement(), [], makeSettings(), deps);

    expect(deps.addLog).toHaveBeenCalledWith(
      'trending',
      expect.any(String),
      'error',
      expect.stringContaining('Trending research failed'),
    );
    // Pipeline still completes
    expect(deps.expandIdeaToPrompt).toHaveBeenCalledWith(expect.any(Object), '');
    expect(deps.updateIdeaStatus).toHaveBeenCalledWith(expect.any(String), 'done');
  });

  it('propagates when expandIdeaToPrompt throws (fatal step)', async () => {
    const deps = makeDeps({
      expandIdeaToPrompt: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
    });

    await expect(
      processIdea(makeIdea(), 0, 1, makeEngagement(), [], makeSettings(), deps),
    ).rejects.toThrow('LLM unavailable');

    expect(deps.addLog).toHaveBeenCalledWith(
      'prompt-expand',
      expect.any(String),
      'error',
      expect.any(String),
    );
    expect(deps.updateIdeaStatus).not.toHaveBeenCalledWith(expect.any(String), 'done');
  });

  it('propagates when triggerImageGeneration throws (fatal step)', async () => {
    const deps = makeDeps({
      triggerImageGeneration: vi.fn().mockRejectedValue(new Error('Leonardo API down')),
    });

    await expect(
      processIdea(makeIdea(), 0, 1, makeEngagement(), [], makeSettings(), deps),
    ).rejects.toThrow('Leonardo API down');

    expect(deps.updateIdeaStatus).not.toHaveBeenCalledWith(expect.any(String), 'done');
  });
});

describe('processIdea — accumulatedPosts mutation', () => {
  it('appends newly scheduled posts to the accumulatedPosts array for slot collision avoidance', async () => {
    const deps = makeDeps({ waitForImages: vi.fn().mockResolvedValue([makeImage(), makeImage()]) });
    const accumulatedPosts: ScheduledPost[] = [];

    await processIdea(makeIdea(), 0, 2, makeEngagement(), accumulatedPosts, makeSettings(), deps);

    expect(accumulatedPosts).toHaveLength(2);
    expect(accumulatedPosts[0].sourceIdeaId).toBe('idea-001');
  });
});

// ─── withPipelineRunning ──────────────────────────────────────────────────────

describe('withPipelineRunning', () => {
  it('calls setRunning(true) then setRunning(false) on success', async () => {
    const setRunning = vi.fn();
    await withPipelineRunning(setRunning, async () => 'result');

    expect(setRunning).toHaveBeenCalledTimes(2);
    expect(setRunning).toHaveBeenNthCalledWith(1, true);
    expect(setRunning).toHaveBeenNthCalledWith(2, false);
  });

  it('returns the value from fn on success', async () => {
    const result = await withPipelineRunning(vi.fn(), async () => 42);
    expect(result).toBe(42);
  });

  it('calls setRunning(false) even when fn throws — fixes stuck-UI bug', async () => {
    const setRunning = vi.fn();

    await expect(
      withPipelineRunning(setRunning, async () => {
        throw new Error('unexpected pipeline error');
      }),
    ).rejects.toThrow('unexpected pipeline error');

    expect(setRunning).toHaveBeenCalledTimes(2);
    expect(setRunning).toHaveBeenNthCalledWith(1, true);
    expect(setRunning).toHaveBeenNthCalledWith(2, false);
  });

  it('calls setRunning(false) when fn throws SkipIdeaSignal', async () => {
    const setRunning = vi.fn();

    await expect(
      withPipelineRunning(setRunning, async () => {
        throw new SkipIdeaSignal();
      }),
    ).rejects.toBeInstanceOf(SkipIdeaSignal);

    expect(setRunning).toHaveBeenNthCalledWith(2, false);
  });

});

// ─── PROP-017 / OPT-001 — parallel per-model captioning ─────────────────────

describe('processIdea — parallel per-model captioning (PROP-017)', () => {
  function makeImages(n: number): GeneratedImage[] {
    return Array.from({ length: n }, (_, i) =>
      makeImage({
        id: `img-m${i + 1}`,
        modelInfo: { provider: 'leonardo', modelId: `m${i + 1}`, modelName: `Model${i + 1}` },
      }),
    );
  }

  it('runs N>1 caption calls with bounded concurrency (max 3 in flight)', async () => {
    const images = makeImages(6);
    let inFlight = 0;
    let peak = 0;
    const generatePostContent = vi.fn(async (img: GeneratedImage) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { ...img, postCaption: `cap-${img.id}` };
    });
    const deps = makeDeps({
      waitForImages: vi.fn().mockResolvedValue(images),
      generatePostContent,
    });

    await processIdea(makeIdea(), 0, 1, makeEngagement(), [], makeSettings(), deps);

    expect(generatePostContent).toHaveBeenCalledTimes(6);
    // Concurrency cap is 3 — peak in-flight must never exceed it
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThanOrEqual(2); // proves we actually parallelized
  });

  it('parallel wall-clock is much less than the sequential sum', async () => {
    const images = makeImages(6);
    const PER_CALL_MS = 40;
    const deps = makeDeps({
      waitForImages: vi.fn().mockResolvedValue(images),
      generatePostContent: vi.fn(async (img: GeneratedImage) => {
        await new Promise((r) => setTimeout(r, PER_CALL_MS));
        return { ...img, postCaption: 'ok' };
      }),
    });

    const t0 = Date.now();
    await processIdea(makeIdea(), 0, 1, makeEngagement(), [], makeSettings(), deps);
    const elapsed = Date.now() - t0;

    // Sequential would be 6 × 40 = 240ms. With pool=3 we expect ~2 batches ≈ 80–120ms.
    // Allow generous slack for CI variance — anything under sequential proves it.
    expect(elapsed).toBeLessThan(PER_CALL_MS * images.length); // < 240ms
  });

  it('a single caption rejection does not abort sibling captions (allSettled)', async () => {
    const images = makeImages(4);
    const deps = makeDeps({
      waitForImages: vi.fn().mockResolvedValue(images),
      generatePostContent: vi.fn(async (img: GeneratedImage) => {
        if (img.id === 'img-m2') throw new Error('pi.dev 503');
        return { ...img, postCaption: `cap-${img.id}` };
      }),
    });

    await processIdea(makeIdea(), 0, 1, makeEngagement(), [], makeSettings(), deps);

    // All 4 attempted, all 4 scheduled (one with prompt fallback)
    expect(deps.generatePostContent).toHaveBeenCalledTimes(4);
    const errLogs = (deps.addLog as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'caption' && c[2] === 'error' && /img-m2|Model2/i.test(c[3]),
    );
    expect(errLogs.length).toBeGreaterThanOrEqual(1);
    // 4 schedule calls — failure path still produces a ScheduledPost
    const scheduleCalls = (deps.updateSettings as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => typeof c[0] === 'function',
    );
    expect(scheduleCalls.length).toBe(4);
  });

  it('single-image path stays sequential (no concurrency-pool checkpoint label)', async () => {
    const images = makeImages(1);
    const deps = makeDeps({
      waitForImages: vi.fn().mockResolvedValue(images),
    });

    await processIdea(makeIdea(), 0, 1, makeEngagement(), [], makeSettings(), deps);

    const ckpts = (deps.writeCheckpoint as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(ckpts.some((s: string) => s.includes('parallel'))).toBe(false);
    expect(ckpts.some((s: string) => s.includes('Captioning Model1'))).toBe(true);
  });

  it('autoCaption=false skips caption phase entirely (no generatePostContent calls)', async () => {
    const images = makeImages(4);
    const deps = makeDeps({
      waitForImages: vi.fn().mockResolvedValue(images),
    });

    await processIdea(
      makeIdea(),
      0, 1, makeEngagement(), [], makeSettings({ pipelineAutoCaption: false }), deps,
    );

    expect(deps.generatePostContent).not.toHaveBeenCalled();
    // Still scheduled all 4
    const scheduleCalls = (deps.updateSettings as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => typeof c[0] === 'function',
    );
    expect(scheduleCalls.length).toBe(4);
  });
});

describe('PROP-017 follow-up — withPipelineRunning unaffected', () => {
  it('setRunning(false) is called before the error propagates to the caller', async () => {
    const order: string[] = [];
    const setRunning = vi.fn((v: boolean) => order.push(`running=${v}`));

    try {
      await withPipelineRunning(setRunning, async () => {
        order.push('fn-threw');
        throw new Error('boom');
      });
    } catch {
      order.push('caller-caught');
    }

    expect(order).toEqual(['running=true', 'fn-threw', 'running=false', 'caller-caught']);
  });
});
