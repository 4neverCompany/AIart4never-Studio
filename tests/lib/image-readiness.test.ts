// V030-006: awaitImagesOrSkip races the generator's returned Promise
// against an AbortSignal that represents a user skip request. These tests
// cover the three termination paths (resolve, skip-abort, underlying
// rejection) plus the pre-aborted fast-path.

import { describe, it, expect } from 'vitest';
import { awaitImagesOrSkip } from '@/lib/image-readiness';
import { SkipIdeaSignal } from '@/lib/pipeline-processor';
import type { GeneratedImage } from '@/types/mashup';

function makeImage(id: string): GeneratedImage {
  return {
    id,
    prompt: 'p',
    url: `https://cdn/${id}.jpg`,
    status: 'ready',
    modelInfo: { provider: 'leonardo', modelId: 'phoenix', modelName: 'Phoenix' },
  };
}

describe('awaitImagesOrSkip', () => {
  it('resolves with the images when the promise settles before abort', async () => {
    const images = [makeImage('a'), makeImage('b')];
    const ctrl = new AbortController();
    const result = await awaitImagesOrSkip(Promise.resolve(images), ctrl.signal);
    expect(result).toEqual(images);
  });

  it('rejects with SkipIdeaSignal if signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    // Promise deliberately never settles — should fail fast via the pre-check.
    const neverSettle = new Promise<GeneratedImage[]>(() => {});
    await expect(awaitImagesOrSkip(neverSettle, ctrl.signal)).rejects.toBeInstanceOf(
      SkipIdeaSignal,
    );
  });

  it('rejects with SkipIdeaSignal when signal aborts mid-wait', async () => {
    const ctrl = new AbortController();
    let resolver: ((v: GeneratedImage[]) => void) | null = null;
    const gated = new Promise<GeneratedImage[]>(res => {
      resolver = res;
    });
    const pending = awaitImagesOrSkip(gated, ctrl.signal);
    // Abort before resolving — skip should win the race.
    ctrl.abort();
    await expect(pending).rejects.toBeInstanceOf(SkipIdeaSignal);
    // Resolving after the skip should be a no-op (no unhandled rejection).
    resolver!([makeImage('late')]);
  });

  it('propagates a rejection from the underlying promise', async () => {
    const ctrl = new AbortController();
    const err = new Error('generator exploded');
    await expect(awaitImagesOrSkip(Promise.reject(err), ctrl.signal)).rejects.toBe(err);
  });

  it('resolves with an empty array if the generator returned nothing', async () => {
    const ctrl = new AbortController();
    const result = await awaitImagesOrSkip(Promise.resolve([]), ctrl.signal);
    expect(result).toEqual([]);
  });

  it('does not settle twice when abort fires after resolve', async () => {
    const ctrl = new AbortController();
    const images = [makeImage('a')];
    const result = await awaitImagesOrSkip(Promise.resolve(images), ctrl.signal);
    expect(result).toEqual(images);
    // Aborting post-settle must not throw.
    ctrl.abort();
  });
});
