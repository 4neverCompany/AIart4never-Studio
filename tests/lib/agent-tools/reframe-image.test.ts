/**
 * reframe_image tool — spend gate + dispatch tests (Story 10.1 follow-up).
 *
 * reframe_image is a real Higgsfield image generation (credit spend) exposed to
 * the autonomous agent. Story 10.1's code-review verification found it bypassed
 * the canonical approval gate; it now spend-gates exactly like generate_image.
 * These tests pin the fail-closed property at the tool boundary (gate denies →
 * NO generation) plus a positive control proving the gate is genuinely in the
 * path — and give the previously-untested executor baseline dispatch coverage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { executeReframeImage, reframeImageTool } from '@/lib/agent-tools/reframe-image';
import {
  ToolExecutionError,
  ToolNotAvailableError,
  ValidationError,
} from '@/lib/agent-tools/errors';
import { __registerProvider, __resetRegistry } from '@/lib/providers/registry';
import type { AssetRef, GenerateImageOptions, ProviderAdapter } from '@/lib/providers/interface';
import { __setCurrentRunContextForTests } from '@/lib/agent-loop/run-context';

const validPrompt = 'A long enough source prompt to keep the composition on regen.';
const SRC = 'https://example.invalid/source.jpg';

/**
 * Deterministic Higgsfield CLI adapter stand-in. `onGenerate` is the spy used to
 * assert the credit-spending generateImage was (or was not) reached.
 */
function mockHiggsfield(opts: {
  available: boolean;
  image?: Partial<AssetRef>;
  onGenerate?: () => void;
}): ProviderAdapter {
  return {
    name: 'higgsfield',
    label: 'Higgsfield (mock)',
    isAvailable: async () => opts.available,
    generateImage: async (_o: GenerateImageOptions): Promise<AssetRef> => {
      opts.onGenerate?.();
      return { kind: 'image', provider: 'higgsfield', ...(opts.image ?? {}) };
    },
    generateVideo: async (): Promise<AssetRef> => ({ kind: 'video', provider: 'higgsfield' }),
  };
}

beforeEach(() => {
  __registerProvider(
    'higgsfield',
    mockHiggsfield({ available: true, image: { url: 'https://cdn.higgsfield.ai/reframed.jpg' } }),
  );
  // Default: NO RunContext → the spend gate is skipped (the dispatch tests run
  // the legacy ungated path); the gate tests set a context explicitly.
  __setCurrentRunContextForTests(null);
});

afterEach(() => {
  __resetRegistry();
  __setCurrentRunContextForTests(null);
});

describe('executeReframeImage — input validation', () => {
  it('rejects an aspect ratio outside the supported enum', async () => {
    const r = await executeReframeImage({
      sourceImage: SRC,
      sourcePrompt: validPrompt,
      targetAspectRatio: '5:5' as never,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ValidationError);
  });

  it('rejects an empty sourcePrompt', async () => {
    const r = await executeReframeImage({
      sourceImage: SRC,
      sourcePrompt: '',
      targetAspectRatio: '9:16',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ValidationError);
  });
});

describe('executeReframeImage — provider dispatch (no RunContext → gate skipped)', () => {
  it('reframes via the higgsfield adapter and echoes the new aspect ratio', async () => {
    const r = await executeReframeImage({
      sourceImage: SRC,
      sourcePrompt: validPrompt,
      targetAspectRatio: '9:16',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.provider).toBe('higgsfield');
      expect(r.value.url).toBe('https://cdn.higgsfield.ai/reframed.jpg');
      expect(r.value.aspectRatio).toBe('9:16');
    }
  });

  it('throws ToolNotAvailableError when the CLI adapter is unavailable', async () => {
    __registerProvider('higgsfield', mockHiggsfield({ available: false }));
    const r = await executeReframeImage({
      sourceImage: SRC,
      sourcePrompt: validPrompt,
      targetAspectRatio: '9:16',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ToolNotAvailableError);
  });
});

describe('executeReframeImage — spend gate fails closed (Story 10.1 follow-up / AC2)', () => {
  it('denies when the budget cap is breached → throws, NO generation', async () => {
    const onGenerate = vi.fn();
    __registerProvider(
      'higgsfield',
      mockHiggsfield({ available: true, image: { url: 'x.jpg' }, onGenerate }),
    );
    // $0.04 ≤ the $0.10 default ceiling, BUT projected 0.95 + 0.04 = 0.99 > budget
    // 1 * 0.95 → the default spend rule refuses; no operator channel → fail closed.
    __setCurrentRunContextForTests({ runId: 'run_x', stepCounter: 0, totalCostUsd: 0.95, budgetUsd: 1 });
    const r = await executeReframeImage({
      sourceImage: SRC,
      sourcePrompt: validPrompt,
      targetAspectRatio: '9:16',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(ToolExecutionError);
      expect(r.error.message).toMatch(/approval denied/i);
      expect((r.error as ToolExecutionError).retryable).toBe(false);
    }
    // Fail-closed proof: the credit-spending generateImage was never reached.
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it('auto-approves a within-budget reframe and reaches the adapter (positive control)', async () => {
    const onGenerate = vi.fn();
    __registerProvider(
      'higgsfield',
      mockHiggsfield({
        available: true,
        image: { url: 'https://cdn.higgsfield.ai/ok.jpg' },
        onGenerate,
      }),
    );
    __setCurrentRunContextForTests({ runId: 'run_x', stepCounter: 0, totalCostUsd: 0, budgetUsd: 1 });
    const r = await executeReframeImage({
      sourceImage: SRC,
      sourcePrompt: validPrompt,
      targetAspectRatio: '9:16',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.url).toBe('https://cdn.higgsfield.ai/ok.jpg');
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });
});

describe('reframeImageTool (Vercel AI SDK shape)', () => {
  it('has a description and schemas', () => {
    const obj = reframeImageTool as unknown as Record<string, unknown>;
    expect(typeof obj.description).toBe('string');
    expect(obj.inputSchema).toBeDefined();
    expect(obj.outputSchema).toBeDefined();
  });
});
