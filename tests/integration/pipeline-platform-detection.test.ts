// V050-006: end-to-end integration test for the V041-HOTFIX-IG fix.
// Bug 3 in v0.4.2 was that processIdea derived `inferredPlatforms` from
// settings.apiKeys only, ignoring desktop config.json creds. Desktop
// users with creds saved in the Desktop tab silently got "No platforms
// configured — skipped" forever.
//
// The existing tests/lib/pipeline-processor.test.ts has 2 unit tests
// covering the inference call site. This integration test goes one
// layer further: it asserts the *output ScheduledPost* — what actually
// lands in accumulatedPosts and gets persisted to settings — has the
// correct `platforms` array. That's the user-visible contract; if a
// future refactor moved the inferredPlatforms call but stopped wiring
// it into the post, the unit tests would still pass and this one
// would catch it.

import { describe, it, expect, vi } from 'vitest';
import { processIdea, type ProcessIdeaDeps } from '@/lib/pipeline-processor';
import type {
  Idea,
  GeneratedImage,
  UserSettings,
  ScheduledPost,
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
  apiKeys: {},
  defaultLeonardoModel: 'phoenix',
  pipelineAutoCaption: true,
  pipelineAutoSchedule: true,
  pipelineCarouselMode: false,
  ...overrides,
});

const mkDeps = (overrides: Partial<ProcessIdeaDeps> = {}): ProcessIdeaDeps => ({
  fetchTrendingContext: vi.fn().mockResolvedValue(''),
  expandIdeaToPrompt: vi.fn().mockResolvedValue('expanded prompt'),
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

describe('pipeline platform detection — end-to-end ScheduledPost shape', () => {
  it('writes platforms:["instagram"] when only desktopCreds advertise IG', async () => {
    const deps = mkDeps({
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
    const accumulated: ScheduledPost[] = [];

    await processIdea(
      mkIdea(),
      0,
      1,
      mkEngagement(),
      accumulated,
      mkSettings({ apiKeys: { leonardo: 'k' } }),
      deps,
    );

    expect(accumulated).toHaveLength(1);
    expect(accumulated[0]!.platforms).toEqual(['instagram']);
  });

  it('respects an explicit settings.pipelinePlatforms override over inference', async () => {
    const deps = mkDeps({
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
    const accumulated: ScheduledPost[] = [];

    await processIdea(
      mkIdea(),
      0,
      1,
      mkEngagement(),
      accumulated,
      mkSettings({
        apiKeys: { leonardo: 'k' },
        pipelinePlatforms: ['pinterest'],
      }),
      deps,
    );

    // Even though inference would have produced ['instagram'], the
    // explicit override wins.
    expect(accumulated[0]!.platforms).toEqual(['pinterest']);
  });

  it('still creates a pending_approval post with platforms:[] when no creds are configured (BUG-CRIT-009)', async () => {
    // Post BUG-CRIT-009: instead of skipping with a "No platforms" log
    // (which orphaned the pipelinePending image with no approval entry
    // to release it), the pipeline now lands a ScheduledPost with
    // platforms=[] in pending_approval status. The auto-poster
    // correctly skips empty-platforms posts; the user can either fix
    // platforms then approve, or reject from the queue.
    const deps = mkDeps();
    const accumulated: ScheduledPost[] = [];

    await processIdea(
      mkIdea(),
      0,
      1,
      mkEngagement(),
      accumulated,
      mkSettings({ apiKeys: { leonardo: 'k' } }),
      deps,
    );

    expect(accumulated).toHaveLength(1);
    expect(accumulated[0]!.platforms).toEqual([]);
    expect(accumulated[0]!.status).toBe('pending_approval');
  });

  it('treats settings.apiKeys.instagram = { accessToken: "", igAccountId: "" } as not configured (post lands with platforms:[])', async () => {
    // Pre-fix bug: the naive Object.entries filter accepted empty-string
    // fields as configured. Post BUG-CRIT-009: post still lands so the
    // approval queue can release pipelinePending, but with platforms=[]
    // so the auto-poster won't try to publish to a dead channel.
    const deps = mkDeps();
    const accumulated: ScheduledPost[] = [];

    await processIdea(
      mkIdea(),
      0,
      1,
      mkEngagement(),
      accumulated,
      mkSettings({
        apiKeys: { instagram: { accessToken: '', igAccountId: '' } },
      }),
      deps,
    );

    expect(accumulated).toHaveLength(1);
    expect(accumulated[0]!.platforms).toEqual([]);
  });
});
