import type { GeneratedImage } from '@/types/mashup';
import { SkipIdeaSignal } from './pipeline-processor';

/**
 * Resolve with the images produced by `imagesPromise` — unless `skipSignal`
 * aborts first, in which case reject with `SkipIdeaSignal`. Replaces the
 * 90-attempt × 3s poll in useIdeaProcessor.waitForImages so an idea resolves
 * as soon as the generator actually returns.
 *
 * Either settlement detaches the abort listener; double-settle is guarded.
 */
export async function awaitImagesOrSkip(
  imagesPromise: Promise<GeneratedImage[]>,
  skipSignal: AbortSignal,
): Promise<GeneratedImage[]> {
  if (skipSignal.aborted) throw new SkipIdeaSignal();

  return new Promise<GeneratedImage[]>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new SkipIdeaSignal());
    };
    skipSignal.addEventListener('abort', onAbort, { once: true });
    imagesPromise.then(
      imgs => {
        if (settled) return;
        settled = true;
        skipSignal.removeEventListener('abort', onAbort);
        resolve(imgs);
      },
      err => {
        if (settled) return;
        settled = true;
        skipSignal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
