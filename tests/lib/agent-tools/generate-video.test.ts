/**
 * v1.2 Tool Registry — `generate_video` tool tests.
 *
 * Mirrors the structure of `generate-image.test.ts` — provider
 * dispatch + per-model duration caps + settings validation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  executeGenerateVideo,
  generateVideoTool,
  __test__,
} from '@/lib/agent-tools/generate-video';
import {
  ValidationError,
  ToolNotAvailableError,
  ToolExecutionError,
} from '@/lib/agent-tools/errors';
import { HIGGSFIELD_VIDEO_MODELS } from '@/lib/higgsfield/models';
import { __registerProvider, __resetRegistry } from '@/lib/providers/registry';
import type { AssetRef, ProviderAdapter } from '@/lib/providers/interface';

const validPrompt = 'A long enough prompt to satisfy the min-20 validation gate.';

/**
 * V1.5: deterministic Higgsfield video adapter stand-in so the wired
 * tests don't depend on the real CLI binary being on PATH. The default
 * (registered in beforeEach) is UNAVAILABLE so the pre-existing dispatch
 * tests still surface ToolNotAvailableError on every machine.
 */
function mockHiggsfieldVideo(opts: {
  available: boolean;
  video?: Partial<AssetRef>;
  jobStatus?: { status?: string; result_url?: string; error?: string };
}): ProviderAdapter & { getJobStatus?: (id: string) => Promise<unknown> } {
  return {
    name: 'higgsfield',
    label: 'Higgsfield (mock)',
    isAvailable: async () => opts.available,
    generateImage: async () => ({ kind: 'image', provider: 'higgsfield' }) as AssetRef,
    generateVideo: async () =>
      ({ kind: opts.video?.url ? 'video' : 'job', provider: 'higgsfield', ...opts.video }) as AssetRef,
    getJobStatus: async () => opts.jobStatus ?? { status: 'queued' },
  };
}

beforeEach(() => {
  // Default: CLI unavailable. Individual tests override with an
  // available mock when they exercise the wired success/poll paths.
  __registerProvider('higgsfield', mockHiggsfieldVideo({ available: false }));
});

afterEach(() => {
  __resetRegistry();
  vi.useRealTimers();
});

describe('executeGenerateVideo — input validation', () => {
  it('rejects when model is missing', async () => {
    const r = await executeGenerateVideo({ prompt: validPrompt });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ValidationError);
  });
});

describe('executeGenerateVideo — provider dispatch', () => {
  it('mock provider returns a deterministic AssetRef', async () => {
    const r = await executeGenerateVideo({
      model: 'mock',
      prompt: validPrompt,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.assetRef.provider).toBe('mock');
      expect(r.value.assetRef.url).toMatch(/\.mp4$/);
    }
  });

  it('higgsfield provider throws ToolNotAvailableError (until v1.2.3)', async () => {
    const r = await executeGenerateVideo({
      model: 'seedance_2_0',
      prompt: validPrompt,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ToolNotAvailableError);
  });

  it('minimax provider throws ToolNotAvailableError', async () => {
    const r = await executeGenerateVideo({
      model: 'minimax:hailuo',
      prompt: validPrompt,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ToolNotAvailableError);
  });

  it('leonardo provider throws ToolNotAvailableError', async () => {
    const r = await executeGenerateVideo({
      model: 'leonardo:motion',
      prompt: validPrompt,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ToolNotAvailableError);
  });

  it('openai provider throws ToolNotAvailableError', async () => {
    const r = await executeGenerateVideo({
      model: 'sora',
      prompt: validPrompt,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ToolNotAvailableError);
  });
});

describe('V1.5: executeGenerateVideo — wired Higgsfield CLI', () => {
  it('returns the AssetRef directly when generation completes synchronously', async () => {
    __registerProvider(
      'higgsfield',
      mockHiggsfieldVideo({ available: true, video: { url: 'https://cdn.higgsfield.ai/vid/abc.mp4' } }),
    );
    const r = await executeGenerateVideo({ model: 'seedance_2_0', prompt: validPrompt });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.assetRef.provider).toBe('higgsfield');
      expect(r.value.assetRef.url).toBe('https://cdn.higgsfield.ai/vid/abc.mp4');
    }
  });

  it('polls an async job and returns the result URL when it completes', async () => {
    vi.useFakeTimers();
    __registerProvider(
      'higgsfield',
      mockHiggsfieldVideo({
        available: true,
        video: { jobId: 'job-async-1' },
        jobStatus: { status: 'completed', result_url: 'https://cdn.higgsfield.ai/vid/done.mp4' },
      }),
    );
    const promise = executeGenerateVideo({ model: 'seedance_2_0', prompt: validPrompt });
    // Advance past the first 5s poll interval.
    await vi.advanceTimersByTimeAsync(6000);
    const r = await promise;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.assetRef.url).toBe('https://cdn.higgsfield.ai/vid/done.mp4');
  });

  it('surfaces a retryable error when an async job fails', async () => {
    vi.useFakeTimers();
    __registerProvider(
      'higgsfield',
      mockHiggsfieldVideo({
        available: true,
        video: { jobId: 'job-async-2' },
        jobStatus: { status: 'failed', error: 'content policy' },
      }),
    );
    const promise = executeGenerateVideo({ model: 'seedance_2_0', prompt: validPrompt });
    await vi.advanceTimersByTimeAsync(6000);
    const r = await promise;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ToolExecutionError);
  });
});

describe('executeGenerateVideo — duration caps', () => {
  it('rejects when duration exceeds the model cap (within schema max)', async () => {
    // seedance_2_0's cap is 12s, schema max is 15s — so 13s
    // passes the Zod schema but trips the per-model cap.
    const r = await executeGenerateVideo({
      model: 'seedance_2_0',
      prompt: validPrompt,
      settings: { durationSec: 13 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(ToolExecutionError);
      const te = r.error as ToolExecutionError;
      expect(te.message).toContain('cap');
      expect(te.retryable).toBe(false);
    }
  });

  it('rejects a duration over the schema max as ValidationError', async () => {
    // Schema max is 15s, so 20 fails the Zod validation gate
    // BEFORE the per-model cap check runs.
    const r = await executeGenerateVideo({
      model: 'seedance_2_0',
      prompt: validPrompt,
      settings: { durationSec: 20 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ValidationError);
  });

  it('accepts a duration within the cap', async () => {
    const r = await executeGenerateVideo({
      model: 'seedance_2_0',
      prompt: validPrompt,
      settings: { durationSec: 5 },
    });
    // Routes to higgsfield (ToolNotAvailableError) but settings pass.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ToolNotAvailableError);
  });
});

describe('executeGenerateVideo — aspect ratio', () => {
  it('rejects an aspect ratio not in the model allowlist', async () => {
    // veo3_1 only supports 16:9 and 9:16 (per the catalog).
    const r = await executeGenerateVideo({
      model: 'veo3_1',
      prompt: validPrompt,
      settings: { aspectRatio: '4:3' as never, durationSec: 5 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ToolExecutionError);
  });

  it('accepts an aspect ratio in the model allowlist', async () => {
    const r = await executeGenerateVideo({
      model: 'veo3_1',
      prompt: validPrompt,
      settings: { aspectRatio: '9:16', durationSec: 5 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ToolNotAvailableError);
  });
});

describe('__test__ helpers', () => {
  it('detectProvider routes the documented slugs', () => {
    expect(__test__.detectProvider('mock')).toBe('mock');
    expect(__test__.detectProvider('seedance_2_0')).toBe('higgsfield');
    expect(__test__.detectProvider('seedance1_5')).toBe('higgsfield');
    expect(__test__.detectProvider('kling3_0')).toBe('higgsfield');
    expect(__test__.detectProvider('veo3_1')).toBe('higgsfield');
    expect(__test__.detectProvider('veo3_1_lite')).toBe('higgsfield');
    expect(__test__.detectProvider('wan2_6')).toBe('higgsfield');
    expect(__test__.detectProvider('minimax_hailuo')).toBe('higgsfield');
    expect(__test__.detectProvider('higgsfield:any')).toBe('higgsfield');
    expect(__test__.detectProvider('minimax:hailuo')).toBe('minimax');
    expect(__test__.detectProvider('leonardo:motion')).toBe('leonardo');
    expect(__test__.detectProvider('sora')).toBe('openai');
  });

  it('DURATION_CAPS is non-empty and bounded (no model > 15s)', () => {
    expect(Object.keys(__test__.DURATION_CAPS).length).toBeGreaterThan(0);
    for (const [slug, cap] of Object.entries(__test__.DURATION_CAPS)) {
      expect(cap, `${slug} cap`).toBeGreaterThan(0);
      expect(cap, `${slug} cap`).toBeLessThanOrEqual(15);
    }
  });

  it('exposes the current Higgsfield video-model count', () => {
    expect(__test__.higgsfieldVideoModelCount).toBe(HIGGSFIELD_VIDEO_MODELS.length);
  });
});

describe('generateVideoTool (Vercel AI SDK shape)', () => {
  it('has a description and schemas', () => {
    const obj = generateVideoTool as unknown as Record<string, unknown>;
    expect(typeof obj.description).toBe('string');
    expect(obj.inputSchema).toBeDefined();
    expect(obj.outputSchema).toBeDefined();
  });
});
