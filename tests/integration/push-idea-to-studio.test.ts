// V050-006: wiring test for the V041-HOTFIX-3BUGS Bug 1 regression.
// "Push to Studio" used to call a hand-rolled prompt-enhance instead of
// suggestParametersAI. This test asserts that pushIdeaToStudio:
//   1. calls the injected `suggest` fn with the idea's prompt + the
//      Leonardo model surface (not a hand-rolled enhance)
//   2. fans the resulting suggestion into the right state setters
//   3. flips the pushing flag back off in finally on both happy + error
//      paths
//
// Lives in tests/integration because it exercises the orchestrator
// across mocked dependencies — the bug it catches was structural
// (wrong call), not arithmetic.

import { describe, it, expect, vi } from 'vitest';
import { pushIdeaToStudio, type PushIdeaToStudioDeps } from '@/lib/push-idea-to-studio';
import type { ParamSuggestion } from '@/lib/param-suggest';

const fakeSuggestion = (overrides: Partial<ParamSuggestion> = {}): ParamSuggestion => ({
  modelIds: ['flux-precision', 'phoenix-1-0'],
  perModel: {},
  aspectRatio: '2:3',
  imageSize: '2K',
  style: 'cinematic',
  negativePrompt: 'blur',
  quality: 'HIGH',
  promptEnhance: 'ON',
  reasons: {
    models: 'r-models',
    aspectRatio: 'r-ar',
    imageSize: 'r-size',
  },
  priorMatchCount: 0,
  source: 'rules',
  ...overrides,
});

const makeDeps = (overrides: Partial<PushIdeaToStudioDeps> = {}): PushIdeaToStudioDeps => ({
  setIsPushing: vi.fn(),
  setView: vi.fn(),
  setComparisonPrompt: vi.fn(),
  setComparisonModels: vi.fn(),
  setComparisonOptions: vi.fn(),
  setParamSuggestion: vi.fn(),
  armCarouselWatcher: vi.fn(),
  suggest: vi.fn().mockResolvedValue(fakeSuggestion()),
  availableModels: [{ id: 'flux-precision', name: 'Flux' }] as never[],
  modelGuides: { 'flux-precision': 'guide-text' },
  availableStyles: [{ name: 'cinematic', uuid: 'u1' }],
  savedImages: [],
  ...overrides,
});

describe('pushIdeaToStudio — wiring', () => {
  it('routes through the suggest fn with the prompt + model surface', async () => {
    const suggest = vi.fn().mockResolvedValue(fakeSuggestion());
    const deps = makeDeps({ suggest });

    await pushIdeaToStudio('a vampire chess match', deps);

    expect(suggest).toHaveBeenCalledTimes(1);
    expect(suggest).toHaveBeenCalledWith({
      prompt: 'a vampire chess match',
      availableModels: deps.availableModels,
      modelGuides: deps.modelGuides,
      availableStyles: deps.availableStyles,
      savedImages: deps.savedImages,
    });
  });

  it('immediately switches the view to compare and arms the carousel watcher', async () => {
    const deps = makeDeps();
    await pushIdeaToStudio('p', deps);
    expect(deps.setView).toHaveBeenCalledWith('compare');
    expect(deps.armCarouselWatcher).toHaveBeenCalledTimes(1);
    expect(deps.setComparisonPrompt).toHaveBeenCalledWith('p');
  });

  it('writes the suggestion into the comparison state setters', async () => {
    const suggestion = fakeSuggestion({
      modelIds: ['m1', 'm2', 'm3'],
      aspectRatio: '9:16',
      imageSize: '1K',
      negativePrompt: 'low-quality',
      style: 'oil-painting',
      quality: 'MEDIUM',
      promptEnhance: 'OFF',
    });
    const deps = makeDeps({ suggest: vi.fn().mockResolvedValue(suggestion) });

    await pushIdeaToStudio('p', deps);

    expect(deps.setComparisonModels).toHaveBeenCalledWith(['m1', 'm2', 'm3']);
    expect(deps.setParamSuggestion).toHaveBeenCalledWith(suggestion);

    // setComparisonOptions is called with an updater fn — invoke it
    // against a known prev to assert the merge shape.
    const setOptsCall = (deps.setComparisonOptions as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(typeof setOptsCall).toBe('function');
    const merged = setOptsCall({ aspectRatio: '1:1', imageSize: '2K', negativePrompt: 'old' });
    expect(merged).toMatchObject({
      aspectRatio: '9:16',
      imageSize: '1K',
      negativePrompt: 'low-quality',
      style: 'oil-painting',
      quality: 'MEDIUM',
      promptEnhance: 'OFF',
    });
  });

  it('falls back to prev.negativePrompt when the suggestion omits one', async () => {
    const suggestion = fakeSuggestion({ negativePrompt: undefined });
    const deps = makeDeps({ suggest: vi.fn().mockResolvedValue(suggestion) });

    await pushIdeaToStudio('p', deps);

    const setOptsCall = (deps.setComparisonOptions as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const merged = setOptsCall({ negativePrompt: 'KEEP-ME' });
    expect(merged.negativePrompt).toBe('KEEP-ME');
  });

  it('clears the pushing flag in finally on the happy path', async () => {
    const deps = makeDeps();
    await pushIdeaToStudio('p', deps);
    expect(deps.setIsPushing).toHaveBeenNthCalledWith(1, true);
    expect(deps.setIsPushing).toHaveBeenLastCalledWith(false);
  });

  it('clears the pushing flag and swallows when suggest rejects', async () => {
    const suggest = vi.fn().mockRejectedValue(new Error('pi unreachable'));
    const deps = makeDeps({ suggest });

    await expect(pushIdeaToStudio('p', deps)).resolves.toBeUndefined();
    expect(deps.setIsPushing).toHaveBeenNthCalledWith(1, true);
    expect(deps.setIsPushing).toHaveBeenLastCalledWith(false);
    // Don't write partial state on failure.
    expect(deps.setComparisonModels).not.toHaveBeenCalled();
    expect(deps.setParamSuggestion).not.toHaveBeenCalled();
  });
});
