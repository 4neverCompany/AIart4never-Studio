/**
 * V1.7.0-PIPELINE-HIGGSFIELD: shared Higgsfield image submit+poll.
 *
 * Until now the only Higgsfield image submit lived INSIDE
 * `hooks/useImageGeneration.ts` (`submitHiggsfieldImage`), unreachable
 * from the pipeline's `generateComparison` path — so the pipeline could
 * never actually use Higgsfield (it silently fell back to Leonardo).
 * This module is the shared, dependency-free submit so both the Studio
 * hook and the comparison/pipeline path can route a Higgsfield model id
 * to the real backend.
 *
 * Contract mirrors the Leonardo/MiniMax submit in `useComparison.ts`:
 * returns `{ imageUrl, imageId, seed }` on success, throws on failure.
 */

export interface HiggsfieldSubmitParams {
  prompt: string;
  /** Backend model slug, e.g. 'nano_banana_2' (UnifiedImageModel.apiModelId). */
  apiName: string;
  aspectRatio?: string;
  resolution?: '1k' | '2k' | '4k';
  quality?: 'low' | 'medium' | 'high';
  referenceImageUrl?: string;
  seed?: number;
  /** CLI token from settings — forwarded so the route uses the CLI
   *  binary path instead of OAuth (the common case for desktop). */
  higgsfieldCliToken?: string;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface HiggsfieldSubmitResult {
  imageUrl: string;
  imageId: string;
  seed: number;
}

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 150; // ~5 min, matches the Leonardo path

export async function submitHiggsfieldImageShared(
  params: HiggsfieldSubmitParams,
): Promise<HiggsfieldSubmitResult> {
  const doFetch = params.fetchImpl ?? fetch;
  const res = await doFetch('/api/higgsfield/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: params.prompt,
      model: params.apiName,
      aspectRatio: params.aspectRatio,
      resolution: params.resolution,
      quality: params.quality,
      referenceImageUrl: params.referenceImageUrl,
      seed: params.seed,
      higgsfieldCliToken: params.higgsfieldCliToken,
    }),
  });
  if (!res.ok) {
    let detail = `Higgsfield request failed (${res.status})`;
    try {
      const j = await res.json();
      if (typeof j?.error === 'string') detail = j.error;
    } catch { /* non-JSON */ }
    throw new Error(detail);
  }
  const data = (await res.json()) as {
    completed?: boolean;
    imageUrl?: string;
    requestId?: string;
    seed?: number;
  };
  // Sync completion.
  if (data.completed && typeof data.imageUrl === 'string' && data.imageUrl) {
    return { imageUrl: data.imageUrl, imageId: data.requestId ?? '', seed: data.seed ?? 0 };
  }
  // Async path — poll the status endpoint.
  if (!data.requestId) {
    throw new Error('Higgsfield returned neither an image nor a requestId');
  }
  const requestId = data.requestId;
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const statusRes = await doFetch(`/api/higgsfield/status/${requestId}`);
    if (!statusRes.ok) continue; // tolerate transient 5xx
    const status = (await statusRes.json()) as {
      status?: string;
      imageUrl?: string;
      seed?: number;
      error?: string;
    };
    if (status.status === 'completed' && typeof status.imageUrl === 'string') {
      return { imageUrl: status.imageUrl, imageId: requestId, seed: status.seed ?? 0 };
    }
    if (status.status === 'failed' || status.status === 'nsfw') {
      throw new Error(status.error || `Higgsfield job ${status.status}`);
    }
  }
  throw new Error('Timeout polling Higgsfield generation');
}
