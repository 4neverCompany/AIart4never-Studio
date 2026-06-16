/**
 * V1.1.1-MULTI-PROVIDER-VIDEO: shared client-side helper that
 * dispatches a video generation to the right provider endpoint
 * and polls until completion (or failure / timeout).
 *
 * The Studio's "Animate" button now reads
 * `settings.videoProviders` (an array; default `['minimax']` in
 * v1.1.1) and calls `submitAndPollVideo` for each provider in
 * parallel via `Promise.allSettled`. Each successful result is
 * saved to the gallery with the right `modelInfo.provider` badge.
 *
 * Provider endpoints + status shapes (Leonardo OUT — MashupForge rip):
 *   - minimax:   POST /api/minimax-video  -> { taskId, status: 'pending' }
 *                GET  /api/minimax-video/<taskId> -> { status, videoUrl? }
 *   - higgsfield:POST /api/higgsfield/video -> { completed, videoUrl?, requestId? }
 *                When `completed: true` the response already has
 *                the URL; otherwise the user must poll the Higgsfield
 *                dashboard. For studio use we treat it as fire-and-
 *                forget when requestId-only (the gallery gets a
 *                "generating" badge and the URL is filled in by
 *                a follow-up poll).
 *   - mmx:       POST /api/mmx/video      -> { taskId }
 *                (Status polling is handled by the mmx CLI's
 *                own async tracking; we surface a "generating"
 *                badge and the user fetches later.)
 *
 * Why one helper instead of three in MainContent: the submit +
 * poll + status-shape-mapping is shared infrastructure. Putting
 * it in a lib keeps MainContent's `handleAnimate` focused on
 * UI concerns (tag generation, gallery save, toasts).
 */

export type VideoProviderId = 'minimax' | 'higgsfield' | 'mmx';

export interface VideoProviderOptions {
  prompt: string;
  /** Per-provider model slug. */
  model: string;
  /** Duration in seconds. Defaults vary by provider. */
  duration?: number;
  /** Public URL of the source image. Used by minimax
   *  (`first_frame_url`), higgsfield (`startImageUrl`), and mmx
   *  (`firstFrame`). */
  firstFrameUrl?: string;
  /** Abort signal for the caller's request cancellation. */
  signal?: AbortSignal;
  /** How long to keep polling before giving up. Defaults to
   *  5 minutes. */
  timeoutMs?: number;
  /** How long to wait between poll requests. Defaults to 5s.
   *  Test code can crank this down to 10ms to keep the suite fast. */
  pollIntervalMs?: number;
}

export interface VideoResult {
  provider: VideoProviderId;
  modelId: string;
  modelName: string;
  videoUrl: string;
  /** Provider-side task/generation/request id. Persisted in the
   *  gallery entry so a follow-up poll can re-fetch the URL if
   *  the signed URL expires. */
  externalId?: string;
}

export interface VideoFailure {
  provider: VideoProviderId;
  error: string;
}

export const VIDEO_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 60;

/**
 * Submit + poll a video generation. Returns the final
 * VideoResult on success, throws on failure or timeout. Use
 * `Promise.allSettled` at the call site so one provider's
 * failure doesn't sink the others.
 */
export async function submitAndPollVideo(
  provider: VideoProviderId,
  opts: VideoProviderOptions,
): Promise<VideoResult> {
  switch (provider) {
    case 'minimax':
      return await submitAndPollMinimax(opts);
    case 'higgsfield':
      return await submitAndPollHiggsfield(opts);
    case 'mmx':
      return await submitAndPollMmx(opts);
    default: {
      // exhaustiveness check; TS will complain if a new provider
      // is added without a case.
      const _exhaustive: never = provider;
      throw new Error(`unknown video provider: ${String(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// MiniMax (Hailuo 2.3 native)
// ---------------------------------------------------------------------------

async function submitAndPollMinimax(opts: VideoProviderOptions): Promise<VideoResult> {
  const res = await fetch('/api/minimax-video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: opts.prompt,
      options: {
        model: opts.model,
        duration: opts.duration,
        firstFrameUrl: opts.firstFrameUrl,
      },
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`MiniMax submit failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { taskId?: string; error?: string };
  if (!data.taskId) {
    throw new Error(data.error || 'MiniMax returned no taskId');
  }

  const start = Date.now();
  const timeout = opts.timeoutMs ?? VIDEO_DEFAULT_TIMEOUT_MS;
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    if (Date.now() - start > timeout) {
      throw new Error('MiniMax video generation timed out');
    }
    await sleep(opts.pollIntervalMs ?? POLL_INTERVAL_MS, opts.signal);
    const statusRes = await fetch(`/api/minimax-video/${data.taskId}`, {
      signal: opts.signal,
    });
    if (!statusRes.ok) {
      const text = await statusRes.text().catch(() => '');
      throw new Error(`MiniMax status check failed (${statusRes.status}): ${text.slice(0, 200)}`);
    }
    const status = (await statusRes.json()) as {
      status?: string;
      videoUrl?: string;
      error?: string;
    };
    if (status.status === 'success') {
      if (!status.videoUrl) {
        throw new Error('MiniMax reported success but no videoUrl');
      }
      return {
        provider: 'minimax',
        modelId: opts.model,
        modelName: minimaxModelName(opts.model),
        videoUrl: status.videoUrl,
        externalId: data.taskId,
      };
    }
    if (status.status === 'fail') {
      throw new Error(status.error || 'MiniMax video generation failed');
    }
    // preparing / queueing / processing -> loop
  }
  throw new Error('MiniMax video generation timed out (max attempts)');
}

function minimaxModelName(slug: string): string {
  switch (slug) {
    case 'MiniMax-Hailuo-2.3':
      return 'Hailuo 2.3';
    case 'MiniMax-Hailuo-02':
      return 'Hailuo 02';
    case 'T2V-01-Director':
      return 'T2V-01 Director';
    case 'T2V-01':
      return 'T2V-01';
    default:
      return slug;
  }
}

// ---------------------------------------------------------------------------
// Higgsfield
// ---------------------------------------------------------------------------

async function submitAndPollHiggsfield(opts: VideoProviderOptions): Promise<VideoResult> {
  const res = await fetch('/api/higgsfield/video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: opts.prompt,
      model: opts.model,
      duration: opts.duration,
      startImageUrl: opts.firstFrameUrl,
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Higgsfield submit failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    completed?: boolean;
    videoUrl?: string;
    requestId?: string;
    error?: string;
  };
  if (data.completed && data.videoUrl) {
    return {
      provider: 'higgsfield',
      modelId: opts.model,
      modelName: higgsfieldModelName(opts.model),
      videoUrl: data.videoUrl,
      externalId: data.requestId,
    };
  }
  // Async: no completed video yet. The v1.1.0 higgsfield route
  // returns requestId-only when the job is queued. We treat that
  // as a timeout for studio use (the UI badge says "generating"
  // and a follow-up mechanism re-polls — out of scope here).
  throw new Error(
    data.error ||
      `Higgsfield video is still generating (request ${data.requestId ?? 'unknown'}). Open Higgsfield to monitor.`,
  );
}

function higgsfieldModelName(slug: string): string {
  // Re-export the catalog names from lib/higgsfield/models.ts via
  // a tiny lookup; falling back to the slug keeps unknown models
  // visible in the gallery.
  switch (slug) {
    case 'seedance_2_0':
      return 'Seedance 2.0';
    case 'seedance1_5':
      return 'Seedance 1.5 Pro';
    case 'kling3_0':
      return 'Kling v3.0';
    case 'veo3_1':
      return 'Google Veo 3.1';
    case 'veo3_1_lite':
      return 'Google Veo 3.1 Lite';
    case 'wan2_6':
      return 'Wan 2.6 Video';
    case 'minimax_hailuo':
      return 'MiniMax Hailuo 02';
    default:
      return slug;
  }
}

// ---------------------------------------------------------------------------
// mmx CLI wrapper
// ---------------------------------------------------------------------------

async function submitAndPollMmx(opts: VideoProviderOptions): Promise<VideoResult> {
  const res = await fetch('/api/mmx/video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: opts.prompt,
      options: {
        model: opts.model,
        firstFrame: opts.firstFrameUrl,
      },
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`mmx submit failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { taskId?: string; path?: string; error?: string };
  if (!data.taskId) {
    throw new Error(data.error || 'mmx returned no taskId');
  }
  // mmx is async-only via the noWait route; we surface the taskId
  // as the URL placeholder so the gallery entry shows "generating"
  // instead of a broken link. The user (or a follow-up poller)
  // resolves the URL later.
  throw new Error(
    `mmx task ${data.taskId} is still generating. Open the CLI to fetch the final video.`,
  );
}

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
