/**
 * Leonardo.AI HTTP adapter — ProviderAdapter implementation that
 * hits https://cloud.leonardo.ai/api/rest/v2/* directly.
 *
 * Why HTTP not CLI (DECISIONS.md ADR-005):
 *   Leonardo doesn't publish an official CLI as of 2026-06-07 — the
 *   only official surface is the REST API documented at
 *   https://docs.leonardo.ai. So this adapter is HTTP-only. The
 *   existing app/api/leonardo/route.ts and app/api/leonardo-video/
 *   route.ts handlers are the "production" callers; this adapter
 *   is the agent-time caller. We share the request-body logic but
 *   keep the new code in lib/providers/ so the Director doesn't
 *   have to hit a Next.js route.
 *
 * Models we cover (from app/api/leonardo/route.ts MODEL_ID_MAP +
 * the v2 video model set in app/api/leonardo-video/route.ts):
 *   Image:
 *     - nano-banana       → gemini-2.5-flash-image
 *     - nano-banana-2     → nano-banana-2
 *     - nano-banana-pro   → gemini-image-2
 *     - gpt-image-1.5     → gpt-image-1.5
 *     - gpt-image-2       → gpt-image-2
 *   Video:
 *     - kling-3.0         → kling-3.0
 *     - kling-video-o-3   → kling-video-o-3
 *     - seedance-2.0      → seedance-2.0
 *     - seedance-2.0-fast → seedance-2.0-fast
 *     - veo-3.1           → VEO3_1
 *     - VEO3_1FAST        → VEO3_1FAST
 *
 * All generation calls are async — Leonardo returns a generationId
 * and renders in the background. We return AssetRef with
 * kind: 'job' and a helper `pollJob()` the Director can call to
 * resolve to kind: 'image' | 'video'.
 */

import { z } from 'zod';
import {
  type AssetRef,
  type GenerateImageOptions,
  type GenerateVideoOptions,
  type ProviderAdapter,
  ProviderError,
  ProviderExecError,
  ProviderParseError,
  ProviderRejectedError,
  ProviderUnavailableError,
} from '../interface';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = 'https://cloud.leonardo.ai/api/rest';
const DEFAULT_TIMEOUT_MS = 60_000;

/** Internal id → Leonardo v2 API model id. Mirrors
 *  app/api/leonardo/route.ts MODEL_ID_MAP. */
const IMAGE_MODEL_ID_MAP: Record<string, string> = {
  'nano-banana': 'gemini-2.5-flash-image',
  'nano-banana-2': 'nano-banana-2',
  'nano-banana-pro': 'gemini-image-2',
  'gpt-image-1.5': 'gpt-image-1.5',
  'gpt-image-2': 'gpt-image-2',
};

/** Map of internal video id → (api model id, payload family). The
 *  v2 endpoint serves kling / seedance / veo with distinct payload
 *  shapes; legacy ray still hits the v1 motion-svd endpoint. */
type VideoFamily = 'kling' | 'seedance' | 'veo' | 'legacy';

const VIDEO_MODEL_ID_MAP: Record<string, { apiModel: string; family: VideoFamily }> = {
  'kling-3.0': { apiModel: 'kling-3.0', family: 'kling' },
  'kling-video-o-3': { apiModel: 'kling-video-o-3', family: 'kling' },
  'kling-o3': { apiModel: 'kling-video-o-3', family: 'kling' },
  'seedance-2.0': { apiModel: 'seedance-2.0', family: 'seedance' },
  'seedance-2.0-fast': { apiModel: 'seedance-2.0-fast', family: 'seedance' },
  'veo-3.1': { apiModel: 'VEO3_1', family: 'veo' },
  'VEO3_1FAST': { apiModel: 'VEO3_1FAST', family: 'veo' },
};

const DEFAULT_IMAGE_MODEL = 'nano-banana-pro';
const DEFAULT_VIDEO_MODEL = 'kling-3.0';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const GenerationResponse = z.object({
  sdGenerationJob: z
    .object({ generationId: z.string() })
    .optional(),
  generation: z
    .object({ id: z.string() })
    .optional(),
  generate: z
    .object({ generationId: z.string() })
    .optional(),
  generationId: z.string().optional(),
  id: z.string().optional(),
});

const JobStatusResponse = z.object({
  generations_by_pk: z
    .object({
      id: z.string().optional(),
      status: z.string().optional(),
      url: z.string().optional(),
      video_url: z.string().optional(),
      image_urls: z.array(z.string()).optional(),
    })
    .optional(),
  generation: z
    .object({
      id: z.string().optional(),
      status: z.string().optional(),
      url: z.string().optional(),
      video_url: z.string().optional(),
      image_urls: z.array(z.string()).optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface LeonardoHttpAdapterOptions {
  /** Bearer token. Defaults to process.env.LEONARDO_API_KEY at call
   *  time (so a runtime-override after construction still wins). */
  apiKey?: string;
  /** Per-request timeout in ms. Default 60_000. */
  timeoutMs?: number;
  /** Base URL override (mostly for tests). */
  baseUrl?: string;
  /** Inject a custom fetch (e.g. for msw in tests). */
  fetchImpl?: typeof fetch;
}

export class LeonardoHttpAdapter implements ProviderAdapter {
  readonly name = 'leonardo';
  readonly label = 'Leonardo.AI (HTTP)';

  private readonly opts: LeonardoHttpAdapterOptions;

  constructor(opts: LeonardoHttpAdapterOptions = {}) {
    this.opts = opts;
  }

  async isAvailable(): Promise<boolean> {
    const key = this.apiKey();
    if (!key || key === 'MY_LEONARDO_API_KEY') return false;
    return true;
  }

  async generateImage(opts: GenerateImageOptions): Promise<AssetRef> {
    if (!opts.prompt) {
      throw new ProviderParseError(this.name, 'generateImage requires a non-empty prompt');
    }
    const apiKey = this.requireKey();
    const modelId = opts.model ?? DEFAULT_IMAGE_MODEL;
    const apiModelId = IMAGE_MODEL_ID_MAP[modelId] ?? modelId;

    const parameters: Record<string, unknown> = {
      prompt: String(opts.prompt),
      width: Number(opts.width) || 1024,
      height: Number(opts.height) || 1024,
      quantity: Math.min(Number(opts.n) || 1, 8),
      prompt_enhance: opts.extra?.promptEnhance === 'OFF' ? 'OFF' : 'ON',
      quality: opts.quality ?? 'HIGH',
    };
    if (modelId === 'gpt-image-1.5') {
      parameters.quantity = Math.min(parameters.quantity as number, 4);
    }
    if (Array.isArray(opts.styleIds) && opts.styleIds.length > 0) {
      parameters.style_ids = opts.styleIds;
    }
    if (opts.seed !== undefined) parameters.seed = opts.seed;

    const body = {
      model: apiModelId,
      parameters,
      public: false,
    };

    const json = await this.fetchJson<unknown>(
      `${this.baseUrl()}/v2/generations`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      },
      opts.signal,
      opts.timeoutMs,
    );

    const parsed = GenerationResponse.safeParse(json);
    if (!parsed.success) {
      throw new ProviderParseError(
        this.name,
        `Leonardo create response did not match schema: ${parsed.error.message}`,
        JSON.stringify(json).slice(0, 500),
      );
    }
    const generationId =
      parsed.data.sdGenerationJob?.generationId
      ?? parsed.data.generate?.generationId
      ?? parsed.data.generationId
      ?? parsed.data.id
      ?? parsed.data.generation?.id;
    if (!generationId) {
      throw new ProviderParseError(
        this.name,
        'Leonardo create response had no generationId',
        JSON.stringify(json).slice(0, 500),
      );
    }
    return { kind: 'job', provider: this.name, jobId: generationId, raw: json };
  }

  async generateVideo(opts: GenerateVideoOptions): Promise<AssetRef> {
    if (!opts.prompt && !opts.imageId) {
      throw new ProviderParseError(
        this.name,
        'generateVideo requires a prompt or an imageId',
      );
    }
    const apiKey = this.requireKey();
    const modelId = opts.model ?? DEFAULT_VIDEO_MODEL;
    const mapEntry = VIDEO_MODEL_ID_MAP[modelId];
    const apiModel = mapEntry?.apiModel ?? modelId;
    const family: VideoFamily = mapEntry?.family ?? 'legacy';

    const endpoint = family === 'legacy'
      ? `${this.baseUrl()}/v1/generations-motion-svd`
      : `${this.baseUrl()}/v2/generations`;

    let body: Record<string, unknown>;
    if (family === 'kling') {
      const parameters: Record<string, unknown> = {
        prompt: String(opts.prompt || 'Animate this image'),
        duration: Number(opts.durationSec) || 3,
        mode: 'RESOLUTION_1080',
        motion_has_audio: true,
      };
      if (opts.imageId) {
        parameters.guidances = {
          start_frame: [{ image: { id: opts.imageId, type: 'GENERATED' } }],
        };
      } else {
        parameters.width = 1920;
        parameters.height = 1080;
      }
      body = { model: apiModel, public: false, parameters };
    } else if (family === 'seedance') {
      const parameters: Record<string, unknown> = {
        prompt: String(opts.prompt || 'Animate this image'),
        duration: Number(opts.durationSec) || 8,
        mode: 'RESOLUTION_720',
        motion_has_audio: true,
      };
      if (opts.imageId) {
        parameters.guidances = {
          start_frame: [{ image: { id: opts.imageId, type: 'GENERATED' } }],
        };
      } else {
        parameters.width = 1280;
        parameters.height = 720;
      }
      body = { model: apiModel, public: false, parameters };
    } else if (family === 'veo') {
      const rawDur = Number(opts.durationSec) || 8;
      const safeDur = rawDur <= 4 ? 4 : rawDur <= 6 ? 6 : 8;
      const payload: Record<string, unknown> = {
        model: apiModel,
        prompt: String(opts.prompt || 'Animate this image'),
        duration: safeDur,
        resolution: 'RESOLUTION_1080',
        isPublic: false,
      };
      if (opts.imageId) {
        payload.imageId = opts.imageId;
        payload.imageType = 'GENERATED';
      } else {
        payload.width = 1920;
        payload.height = 1080;
      }
      body = payload;
    } else {
      body = {
        imageId: opts.imageId,
        motionStrength: 5,
        isPublic: false,
      };
    }

    const json = await this.fetchJson<unknown>(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      },
      opts.signal,
      opts.timeoutMs,
    );

    const parsed = GenerationResponse.safeParse(json);
    if (!parsed.success) {
      throw new ProviderParseError(
        this.name,
        `Leonardo video create response did not match schema: ${parsed.error.message}`,
        JSON.stringify(json).slice(0, 500),
      );
    }
    const generationId =
      parsed.data.sdGenerationJob?.generationId
      ?? parsed.data.generate?.generationId
      ?? parsed.data.generationId
      ?? parsed.data.id
      ?? parsed.data.generation?.id;
    if (!generationId) {
      throw new ProviderParseError(
        this.name,
        'Leonardo video create response had no generationId',
        JSON.stringify(json).slice(0, 500),
      );
    }
    return {
      kind: 'job',
      provider: this.name,
      jobId: generationId,
      durationSec: opts.durationSec,
      raw: json,
    };
  }

  /**
   * Poll a generationId for completion. Returns an AssetRef with
   * kind: 'image' or 'video' once status === 'COMPLETE'. The
   * Director calls this in a loop with backoff; the adapter does
   * NOT poll on its own.
   */
  async pollJob(generationId: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<AssetRef> {
    const apiKey = this.requireKey();
    // v2 first, v1 fallback (mirrors app/api/leonardo/[id]/route.ts).
    let json = await this.fetchJson<unknown>(
      `${this.baseUrl()}/v2/generations/${generationId}`,
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } },
      opts.signal,
      opts.timeoutMs,
    );
    // If v2 returns 404-ish, try v1.
    if (!json || (typeof json === 'object' && 'error' in (json as Record<string, unknown>))) {
      try {
        json = await this.fetchJson<unknown>(
          `${this.baseUrl()}/v1/generations/${generationId}`,
          { method: 'GET', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } },
          opts.signal,
          opts.timeoutMs,
        );
      } catch {
        // fall through with the original error
      }
    }
    const parsed = JobStatusResponse.safeParse(json);
    if (!parsed.success) {
      throw new ProviderParseError(
        this.name,
        `Leonardo job status did not match schema: ${parsed.error.message}`,
        JSON.stringify(json).slice(0, 500),
      );
    }
    const job = parsed.data.generations_by_pk ?? parsed.data.generation;
    if (!job) {
      throw new ProviderParseError(
        this.name,
        'Leonardo job status response had no generation',
        JSON.stringify(json).slice(0, 500),
      );
    }
    if (job.status && job.status !== 'COMPLETE' && job.status !== 'complete') {
      return {
        kind: 'job',
        provider: this.name,
        jobId: generationId,
        raw: job,
      };
    }
    const videoUrl = job.video_url;
    const imageUrls = job.image_urls;
    if (videoUrl) {
      return {
        kind: 'video',
        provider: this.name,
        url: videoUrl,
        jobId: generationId,
        raw: job,
      };
    }
    const firstImage = imageUrls?.[0];
    if (firstImage) {
      return {
        kind: 'image',
        provider: this.name,
        url: firstImage,
        jobId: generationId,
        raw: job,
      };
    }
    if (job.url) {
      // Some response shapes put a single url field.
      return {
        kind: 'image',
        provider: this.name,
        url: job.url,
        jobId: generationId,
        raw: job,
      };
    }
    throw new ProviderParseError(
      this.name,
      'Leonardo job completed but no asset url was returned',
      JSON.stringify(job).slice(0, 500),
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private baseUrl(): string {
    return this.opts.baseUrl ?? BASE_URL;
  }

  private apiKey(): string | undefined {
    return this.opts.apiKey ?? process.env.LEONARDO_API_KEY;
  }

  private requireKey(): string {
    const key = this.apiKey();
    if (!key || key === 'MY_LEONARDO_API_KEY') {
      throw new ProviderUnavailableError(
        this.name,
        'LEONARDO_API_KEY',
      );
    }
    return key;
  }

  private async fetchJson<T>(
    url: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
  ): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch;
    const effectiveSignal = combineSignals(signal, timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await f(url, { ...init, signal: effectiveSignal });
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        throw new ProviderExecError(this.name, -1, `request aborted: ${(e as Error).message}`);
      }
      throw new ProviderExecError(this.name, -1, (e as Error).message);
    }
    if (!res.ok) {
      const text = await res.text();
      // Try to surface a structured error from the body.
      try {
        const parsedErr = JSON.parse(text);
        const msg = extractLeonardoErrorMessage(parsedErr);
        if (msg) {
          throw new ProviderRejectedError(this.name, res.status, msg);
        }
      } catch (e) {
        if (e instanceof ProviderRejectedError) throw e;
      }
      throw new ProviderExecError(this.name, res.status, text.slice(0, 400));
    }
    try {
      return (await res.json()) as T;
    } catch (e) {
      throw new ProviderParseError(this.name, `response was not JSON: ${(e as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  // AbortSignal.timeout is built into Node 18+ and modern browsers
  // (target=ES2017 in tsconfig — runtime is Node 20+). When no
  // caller-supplied signal exists, return the timeout signal directly.
  // When one does, AND-combine so either source aborts the request.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  if (signal.aborted) return signal;
  if (timeoutSignal.aborted) return timeoutSignal;
  const combined = new AbortController();
  const onAbort = () => combined.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  timeoutSignal.addEventListener('abort', onAbort, { once: true });
  return combined.signal;
}

/**
 * Same shape-extraction as app/api/leonardo/route.ts.
 * Returns a human-readable error message from one of:
 *   { error: "string" } | { error: { message, code } } | { errors: [...] } | { message: "string" }
 */
export function extractLeonardoErrorMessage(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.error === 'string' && p.error.trim()) return p.error;
  if (p.error && typeof p.error === 'object') {
    const e = p.error as Record<string, unknown>;
    if (typeof e.message === 'string' && e.message.trim()) return e.message;
    if (typeof e.code === 'string' && e.code.trim()) return e.code;
  }
  if (Array.isArray(p.errors) && p.errors.length > 0) {
    const first = p.errors[0] as Record<string, unknown> | undefined;
    if (first && typeof first.message === 'string' && first.message.trim()) {
      return first.message;
    }
  }
  if (typeof p.message === 'string' && p.message.trim()) return p.message;
  return null;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const leonardoAdapter: ProviderAdapter = new LeonardoHttpAdapter();

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { ProviderAdapter, ProviderError };
