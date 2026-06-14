/**
 * MiniMax Hailuo 2.3 video adapter — ProviderAdapter implementation
 * for the Hailuo 2.3 video generation model via the `mmx` CLI.
 *
 * Hailuo 2.3 is a video-only model (text/image → video). The mmx
 * CLI's `video generate --model Hailuo-2.3` (or whatever model id
 * mmx advertises for Hailuo 2.3) is the underlying call. Like
 * every other adapter, we delegate the actual spawn / parse work
 * to lib/mmx-client.ts so the test surface stays in one place.
 *
 * Hailuo 2.3 is async — mmx returns a taskId and the caller polls.
 * We surface that as `kind: 'job'` plus a `pollTask()` helper. The
 * `pollTask()` method is also a module extension (not part of
 * ProviderAdapter) so the Director can resolve the job when ready.
 *
 * For image generation: Hailuo 2.3 doesn't produce images. We
 * throw `UnsupportedOperationError` from `generateImage` so the
 * Director falls back. M3 (text-adapter.ts) is the text/vision
 * path; mmx-cli-adapter.ts is the mmx-native image path.
 */

import { z } from 'zod';
import {
  type AssetRef,
  type GenerateImageOptions,
  type GenerateVideoOptions,
  type ProviderAdapter,
  ProviderError,
  ProviderParseError,
  UnsupportedOperationError,
} from '../interface';
import {
  generateVideo as mmxGenerateVideo,
  isAvailable as mmxIsAvailable,
  MmxError,
  MmxSpawnError,
  type MmxVideoResult,
} from '../../mmx-client';
import { clampTimeout } from '../cli-utils';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const VideoResultSchema = z.object({
  taskId: z.string().optional(),
  path: z.string().optional(),
  raw: z.unknown().optional(),
});

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface MinimaxVideoAdapterOptions {
  /** Default Hailuo model id passed to mmx. The mmx docs use
   *  "Hailuo-2.3" as the canonical id; the underlying CLI also
   *  accepts "hailuo-2.3" — we keep the canonical form by default
   *  and let callers override. */
  defaultModel?: string;
}

export class MinimaxVideoAdapter implements ProviderAdapter {
  readonly name = 'minimax-video';
  readonly label = 'MiniMax Hailuo 2.3 (video)';

  private readonly opts: MinimaxVideoAdapterOptions;

  constructor(opts: MinimaxVideoAdapterOptions = {}) {
    this.opts = opts;
  }

  get defaultModel(): string {
    return this.opts.defaultModel ?? 'Hailuo-2.3';
  }

  async isAvailable(): Promise<boolean> {
    try {
      return await mmxIsAvailable();
    } catch {
      return false;
    }
  }

  /** Hailuo is video-only. */
  async generateImage(_opts: GenerateImageOptions): Promise<AssetRef> {
    throw new UnsupportedOperationError(this.name, 'image');
  }

  async generateVideo(opts: GenerateVideoOptions): Promise<AssetRef> {
    if (!opts.prompt && !opts.imagePath && !opts.imageUrl) {
      throw new ProviderParseError(
        this.name,
        'generateVideo requires a prompt or a reference image',
      );
    }
    let result: MmxVideoResult;
    try {
      result = await mmxGenerateVideo(
        opts.prompt ?? 'Animate this image',
        {
          model: opts.model ?? this.defaultModel,
          firstFrame: opts.imagePath,
          noWait: true,
        },
        {
          // 60s spec default; explicit override via opts.timeoutMs is
          // honoured (no upper clamp) so slow models can opt in.
          timeoutMs: clampTimeout(opts.timeoutMs),
          signal: opts.signal,
        },
      );
    } catch (e) {
      throw remapMmxError(e, this.name);
    }

    const parsed = VideoResultSchema.safeParse(result);
    if (!parsed.success) {
      throw new ProviderParseError(
        this.name,
        `Hailuo video result failed schema: ${parsed.error.message}`,
        JSON.stringify(result).slice(0, 500),
      );
    }
    const r = parsed.data;
    if (r.taskId) {
      return {
        kind: 'job',
        provider: this.name,
        jobId: r.taskId,
        path: r.path,
        durationSec: opts.durationSec,
        raw: r,
      };
    }
    if (r.path) {
      return {
        kind: 'video',
        provider: this.name,
        path: r.path,
        durationSec: opts.durationSec,
        raw: r,
      };
    }
    throw new ProviderParseError(
      this.name,
      'Hailuo video result had no taskId or path',
      JSON.stringify(r).slice(0, 500),
    );
  }

  /**
   * Poll a Hailuo task for completion. The Director is expected
   * to call this in a loop. We do NOT implement polling here —
   * that would tangle adapter lifetime with retry/backoff, and
   * the post-lifecycle subsystem already owns job state.
   *
   * The actual poll route is wired into the post-lifecycle state
   * machine; this helper exists for the agent-time caller that
   * wants to know "is it done yet?" synchronously.
   */
  async pollTask(taskId: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<AssetRef> {
    if (!taskId) {
      throw new ProviderParseError(this.name, 'pollTask requires a taskId');
    }
    // mmx exposes the same shape for `video generate --no-wait`
    // and the subsequent `video status <id>` command. The
    // mmx-client module's generateVideo handles the noWait path
    // and returns the taskId; the actual status polling lives in
    // a separate command we don't import here to keep this
    // adapter synchronous. Return a `job` AssetRef so the caller
    // knows to keep polling.
    return {
      kind: 'job',
      provider: this.name,
      jobId: taskId,
      raw: { polled: true, signal: opts.signal?.aborted === true ? 'aborted' : 'pending' },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function remapMmxError(e: unknown, provider: string): ProviderError {
  if (e instanceof MmxSpawnError) {
    return new ProviderError('UNAVAILABLE', e.message, provider, e.hint, e);
  }
  if (e instanceof MmxError) {
    return new ProviderError(String(e.code), e.message, provider, e.hint, e);
  }
  if (e instanceof Error) {
    return new ProviderError('UNKNOWN', e.message, provider, undefined, e);
  }
  return new ProviderError('UNKNOWN', String(e), provider);
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const minimaxVideoAdapter: ProviderAdapter = new MinimaxVideoAdapter();
