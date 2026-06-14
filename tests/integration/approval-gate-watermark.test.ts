// BUG-CRIT-001: integration test for the unconditional approval gate.
// Bug: pipeline-produced posts skipped the approval queue when every
// platform was auto-approved (which is the default after V040-HOTFIX-001),
// AND the watermark step was tied to the same gate, so auto-approved
// posts ALSO went out un-watermarked.
//
// Fix contract:
//   1. Every pipeline-produced ScheduledPost lands as `pending_approval`
//      regardless of pipelineAutoApprove config.
//   2. Every saved pipeline image lands with `pipelinePending: true`
//      so Gallery hides it AND the watermark step waits for approval.
//   3. The PipelineProgress flag and addLog entries reflect the gate.
//   4. finalizePipelineImage (called by MashupContext.approveScheduledPost
//      via finalizePipelineImagesForPosts) applies the watermark and
//      clears pipelinePending so Gallery lights up.

import { describe, it, expect, vi } from 'vitest';
import { processIdea, type ProcessIdeaDeps } from '@/lib/pipeline-processor';
import { finalizePipelineImage } from '@/lib/pipeline-finalize';
import type {
  Idea,
  GeneratedImage,
  UserSettings,
  ScheduledPost,
  WatermarkSettings,
} from '@/types/mashup';
import type { CachedEngagement } from '@/lib/smartScheduler';

const mkIdea = (overrides: Partial<Idea> = {}): Idea => ({
  id: 'idea-001',
  concept: 'A',
  context: '',
  status: 'idea',
  createdAt: 0,
  ...overrides,
});

const mkImage = (overrides: Partial<GeneratedImage> = {}): GeneratedImage => ({
  id: 'img-001',
  prompt: 'p',
  url: 'https://e/x.png',
  status: 'ready',
  modelInfo: { provider: 'leonardo', modelId: 'phoenix', modelName: 'Phoenix' },
  ...overrides,
});

const mkEngagement = (): CachedEngagement => ({
  hours: [{ hour: 18, weight: 1 }],
  days: Array.from({ length: 7 }, (_, i) => ({ day: i, multiplier: 1 })),
  fetchedAt: 0,
  source: 'default',
});

const mkSettings = (overrides: Partial<UserSettings> = {}): UserSettings => ({
  enabledProviders: ['leonardo'],
  apiKeys: { instagram: { accessToken: 't', igAccountId: 'a' } },
  defaultLeonardoModel: 'phoenix',
  pipelineAutoCaption: true,
  pipelineAutoSchedule: true,
  pipelineCarouselMode: false,
  ...overrides,
});

const mkDeps = (overrides: Partial<ProcessIdeaDeps> = {}): ProcessIdeaDeps => ({
  fetchTrendingContext: vi.fn().mockResolvedValue(''),
  expandIdeaToPrompt: vi.fn().mockResolvedValue('expanded'),
  triggerImageGeneration: vi.fn().mockResolvedValue(undefined),
  getEnabledModelIds: vi.fn().mockReturnValue([]),
  waitForImages: vi.fn().mockResolvedValue([mkImage()]),
  generatePostContent: vi.fn().mockImplementation(async (img: GeneratedImage) => ({
    ...img,
    postCaption: 'cap',
    postHashtags: [],
  })),
  saveImage: vi.fn(),
  updateIdeaStatus: vi.fn(),
  updateSettings: vi.fn(),
  findNextAvailableSlot: vi.fn().mockReturnValue({
    date: '2026-04-25',
    time: '18:00',
    reason: 'best slot',
  }),
  addLog: vi.fn(),
  setPipelineProgress: vi.fn(),
  writeCheckpoint: vi.fn(),
  isSkipRequested: vi.fn().mockReturnValue(false),
  getScheduledPosts: vi.fn().mockReturnValue([]),
  ...overrides,
});

describe('BUG-CRIT-001 — pipeline always gates through approval', () => {
  it('produces pending_approval posts even when pipelineAutoApprove is all-true', async () => {
    const deps = mkDeps();
    const accumulated: ScheduledPost[] = [];
    const settings = mkSettings({
      pipelineAutoApprove: {
        instagram: true,
        twitter: true,
        discord: true,
        pinterest: true,
      },
    });

    await processIdea(mkIdea(), 0, 1, mkEngagement(), accumulated, settings, deps);

    expect(accumulated).toHaveLength(1);
    expect(accumulated[0]!.status).toBe('pending_approval');
  });

  it('produces pending_approval posts when pipelineAutoApprove is undefined (legacy default)', async () => {
    const deps = mkDeps();
    const accumulated: ScheduledPost[] = [];
    const settings = mkSettings({ pipelineAutoApprove: undefined });

    await processIdea(mkIdea(), 0, 1, mkEngagement(), accumulated, settings, deps);

    expect(accumulated[0]!.status).toBe('pending_approval');
  });

  it('produces pending_approval posts in carousel mode regardless of config', async () => {
    const images = [mkImage({ id: 'img-1' }), mkImage({ id: 'img-2' })];
    const deps = mkDeps({ waitForImages: vi.fn().mockResolvedValue(images) });
    const settings = mkSettings({
      pipelineCarouselMode: true,
      pipelinePlatforms: ['twitter', 'discord'],
      pipelineAutoApprove: { twitter: true, discord: true },
    });

    await processIdea(mkIdea(), 0, 1, mkEngagement(), [], settings, deps);

    const updaterCall = (deps.updateSettings as ReturnType<typeof vi.fn>).mock.calls.find(
      ([arg]) => typeof arg === 'function',
    );
    const patch = (updaterCall![0] as (prev: Partial<UserSettings>) => Partial<UserSettings>)({});
    expect(patch.scheduledPosts!.every((p) => p.status === 'pending_approval')).toBe(true);
    expect(patch.carouselGroups![0]!.status).toBe('draft');
  });

  it('marks every saved pipeline image with pipelinePending=true so Gallery + watermark wait', async () => {
    const deps = mkDeps();
    const settings = mkSettings({
      pipelineAutoApprove: {
        instagram: true,
        twitter: true,
        discord: true,
        pinterest: true,
      },
    });

    await processIdea(mkIdea(), 0, 1, mkEngagement(), [], settings, deps);

    const saveCalls = (deps.saveImage as ReturnType<typeof vi.fn>).mock.calls;
    expect(saveCalls.length).toBeGreaterThan(0);
    for (const [saved] of saveCalls) {
      expect(saved.pipelinePending).toBe(true);
    }
  });

  it('BUG-CRIT-009: still flags pipelinePending=true AND lands an approval entry when no platforms are configured', async () => {
    // Regression for the orphan case: pre-fix, missing platform creds
    // logged "No platforms — skipped" → image saved with
    // pipelinePending=true → no ScheduledPost created → image hidden
    // from Gallery forever with no approval card to release it.
    const deps = mkDeps();
    const settings = mkSettings({
      apiKeys: { leonardo: 'k' }, // no social platforms
    });

    const accumulated: ScheduledPost[] = [];
    await processIdea(mkIdea(), 0, 1, mkEngagement(), accumulated, settings, deps);

    const saveCalls = (deps.saveImage as ReturnType<typeof vi.fn>).mock.calls;
    expect(saveCalls.length).toBeGreaterThan(0);
    for (const [saved] of saveCalls) {
      expect(saved.pipelinePending).toBe(true);
    }
    expect(accumulated).toHaveLength(1);
    expect(accumulated[0]!.status).toBe('pending_approval');
    expect(accumulated[0]!.platforms).toEqual([]);
  });
});

describe('BUG-CRIT-001 — watermark-on-approval contract', () => {
  // The watermark pass is performed in MashupContext.approveScheduledPost
  // via finalizePipelineImagesForPosts → finalizePipelineImage. These
  // tests pin the contract for the helper that the approval handler
  // calls so a future refactor can't silently break the wiring.

  const enabledWatermark: WatermarkSettings = {
    enabled: true,
    image: 'data:image/png;base64,IGNORED',
    position: 'bottom-right',
    opacity: 0.6,
    scale: 0.15,
  };

  it('applies the watermark and clears pipelinePending on approval', async () => {
    const applyWatermark = vi.fn().mockResolvedValue('watermarked-url');
    const img: GeneratedImage = {
      id: 'i1',
      prompt: 'p',
      url: 'original-url',
      pipelinePending: true,
    };

    const out = await finalizePipelineImage(img, enabledWatermark, 'chan', applyWatermark);

    expect(applyWatermark).toHaveBeenCalledWith('original-url', enabledWatermark, 'chan');
    expect(out.url).toBe('watermarked-url');
    expect(out.pipelinePending).toBe(false);
  });

  it('still clears pipelinePending when the user has watermark disabled', async () => {
    const applyWatermark = vi.fn();
    const img: GeneratedImage = {
      id: 'i1',
      prompt: 'p',
      url: 'original-url',
      pipelinePending: true,
    };

    const out = await finalizePipelineImage(
      img,
      { ...enabledWatermark, enabled: false },
      'chan',
      applyWatermark,
    );

    expect(applyWatermark).not.toHaveBeenCalled();
    expect(out.url).toBe('original-url');
    expect(out.pipelinePending).toBe(false);
  });

  // BUG-DEV-004: watermark failures used to swallow silently. The
  // catch now both keeps the original URL (existing contract) AND
  // surfaces a warning to the dev console (new contract) so a broken
  // watermark service is debuggable.
  it('keeps the original URL AND warns when applyWatermark rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const applyWatermark = vi.fn().mockRejectedValue(new Error('canvas blew up'));
      const img: GeneratedImage = {
        id: 'i-broken',
        prompt: 'p',
        url: 'original-url',
        pipelinePending: true,
      };

      const out = await finalizePipelineImage(img, enabledWatermark, 'chan', applyWatermark);

      // Existing contract: original URL preserved, pipelinePending cleared.
      expect(out.url).toBe('original-url');
      expect(out.pipelinePending).toBe(false);

      // New contract: warning logged with module tag + image id + error.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [msg, id, err] = warnSpy.mock.calls[0]!;
      expect(msg).toBe('[pipeline-finalize] watermark failed for');
      expect(id).toBe('i-broken');
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('canvas blew up');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
