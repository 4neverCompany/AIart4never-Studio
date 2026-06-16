/**
 * v1.2 Tool Registry — `generate_image` tool tests.
 *
 * Tests the provider-dispatch + settings-validation logic. The
 * mock provider is fully exercised; the real-provider branches
 * assert on the ToolNotAvailableError shape (the v1.2.3 PR
 * fleshes those out).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// AGENTIC-CORE: the Higgsfield branch now routes through the shared
// `lib/higgsfield/generate.ts` core (submit + poll). Mock it so the tool tests
// never touch the network and we can assert WHAT the tool submits (incl. the
// canon anchor for kael) and how it handles missing connectors / async jobs.
const submitSpy = vi.fn();
const pollSpy = vi.fn();
vi.mock('@/lib/higgsfield/generate', () => ({
  submitHiggsfieldGeneration: (...args: unknown[]) => submitSpy(...args),
  pollHiggsfieldJob: (...args: unknown[]) => pollSpy(...args),
}));

import {
  executeGenerateImage,
  generateImageTool,
  __test__,
} from '@/lib/agent-tools/generate-image';
import {
  ValidationError,
  ToolExecutionError,
  ToolNotAvailableError,
} from '@/lib/agent-tools/errors';
import { HIGGSFIELD_IMAGE_MODELS, getHiggsfieldImageModel } from '@/lib/higgsfield/models';
import {
  __setCurrentRunContextForTests,
  type RunContext,
} from '@/lib/agent-loop/run-context';
import { getElementRef } from '@/lib/canon';
import type { McpServerConfig } from '@/lib/mcp';

const validPrompt = 'A long enough prompt to satisfy the min-20 validation gate.';

/** A stand-in Higgsfield connector (the client would supply the real one). */
const CONNECTOR: McpServerConfig = {
  id: 'hf-1',
  name: 'Higgsfield',
  transport: 'http',
  url: 'https://higgsfield.example.com/mcp',
  headers: { Authorization: 'Bearer secret' },
  enabled: true,
  trusted: true,
  addedAt: 0,
};

/**
 * Set the RunContext the tool reads, with the Higgsfield connector present (so
 * the generate_image tool can submit). NODE_ENV==='test' makes the HIL guard a
 * no-op, so the context here only supplies the connector + characterId.
 */
function enterCtxWithConnector(
  connector: McpServerConfig | undefined,
  characterId: RunContext['characterId'] = 'kael',
): void {
  __setCurrentRunContextForTests({
    runId: 'run_test',
    stepCounter: 0,
    totalCostUsd: 0,
    budgetUsd: 1,
    ...(characterId ? { characterId } : {}),
    ...(connector ? { higgsfieldConnector: connector } : {}),
  });
}

beforeEach(() => {
  submitSpy.mockReset();
  pollSpy.mockReset();
  __setCurrentRunContextForTests(null);
});

afterEach(() => {
  __setCurrentRunContextForTests(null);
});

describe('executeGenerateImage — input validation', () => {
  it('rejects when model is missing', async () => {
    const r = await executeGenerateImage({ prompt: validPrompt });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ValidationError);
  });

  it('rejects a too-short prompt', async () => {
    const r = await executeGenerateImage({ model: 'nano_banana_2', prompt: 'short' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ValidationError);
  });
});

describe('executeGenerateImage — provider dispatch', () => {
  it('mock provider returns a deterministic AssetRef', async () => {
    const r = await executeGenerateImage({
      model: 'mock',
      prompt: validPrompt,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.assetRef.provider).toBe('mock');
      expect(r.value.assetRef.url).toMatch(/^https:\/\/example\.invalid\/mock-images\//);
      expect(r.value.creditsCharged).toBe(0);
    }
  });

  it('mock provider returns the SAME id for the SAME prompt + settings (deterministic)', async () => {
    const input = { model: 'mock', prompt: validPrompt, settings: { aspectRatio: '1:1' as const, resolution: '1k' as const, seed: 0 } };
    const a = await executeGenerateImage(input);
    const b = await executeGenerateImage(input);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value.assetRef.id).toBe(b.value.assetRef.id);
    }
  });

  it('higgsfield throws ToolNotAvailableError when no connector is in the RunContext', async () => {
    // No connector configured anywhere (no run context at all).
    const r = await executeGenerateImage({
      model: 'nano_banana_2',
      prompt: validPrompt,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(ToolNotAvailableError);
      expect(r.error.message).toMatch(/No Higgsfield connector configured/i);
    }
    // Never submitted.
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('higgsfield throws ToolNotAvailableError when a run context exists but carries no connector', async () => {
    enterCtxWithConnector(undefined);
    const r = await executeGenerateImage({
      model: 'nano_banana_2',
      prompt: validPrompt,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ToolNotAvailableError);
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('AGENTIC-CORE: submits through Higgsfield with the canon anchor for kael and returns the completed rawUrl', async () => {
    enterCtxWithConnector(CONNECTOR, 'kael');
    const elementRef = getElementRef('kael') as string;
    expect(elementRef).toBeTruthy();
    submitSpy.mockResolvedValue({
      jobId: 'job-abc',
      prompt: `${elementRef} ${validPrompt}`,
      anchored: true,
      model: 'nano_banana_2',
      characterId: 'kael',
    });
    pollSpy.mockResolvedValue({
      status: 'completed',
      images: ['https://cdn.higgsfield.ai/out.jpeg', 'https://cdn.higgsfield.ai/out_min.webp'],
    });

    const r = await executeGenerateImage({ model: 'nano_banana_2', prompt: validPrompt });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.assetRef.provider).toBe('higgsfield');
      // images[0] is the full-res rawUrl.
      expect(r.value.assetRef.url).toBe('https://cdn.higgsfield.ai/out.jpeg');
      expect(r.value.assetRef.id).toBe('job-abc');
    }

    // The tool routed to the shared lib with: the connector, the agent's
    // already-finalized prompt (enhance OFF), and the canon character so the
    // <<<element>>> anchor is applied for kael.
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const submitArgs = submitSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(submitArgs.connector).toEqual(CONNECTOR);
    expect(submitArgs.prompt).toBe(validPrompt);
    expect(submitArgs.enhance).toBe(false);
    expect(submitArgs.characterId).toBe('kael');
    expect(submitArgs.model).toBe('nano_banana_2');
  });

  it('AGENTIC-CORE: surfaces a retryable ToolExecutionError when the job never completes', async () => {
    enterCtxWithConnector(CONNECTOR, 'kael');
    submitSpy.mockResolvedValue({
      jobId: 'job-xyz',
      prompt: validPrompt,
      anchored: true,
      model: 'nano_banana_2',
      characterId: 'kael',
    });
    // A terminal-failure status → pollToCompletion returns undefined.
    pollSpy.mockResolvedValue({ status: 'failed', images: [] });

    const r = await executeGenerateImage({ model: 'nano_banana_2', prompt: validPrompt });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(ToolExecutionError);
      expect((r.error as ToolExecutionError).retryable).toBe(true);
    }
  });

  it('AGENTIC-CORE: maps a Higgsfield submit failure to a retryable ToolExecutionError', async () => {
    enterCtxWithConnector(CONNECTOR, 'kael');
    submitSpy.mockRejectedValue(new Error('Higgsfield returned no job id'));
    const r = await executeGenerateImage({ model: 'nano_banana_2', prompt: validPrompt });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(ToolExecutionError);
      expect((r.error as ToolExecutionError).retryable).toBe(true);
    }
  });

  it('minimax provider throws ToolNotAvailableError', async () => {
    const r = await executeGenerateImage({
      model: 'minimax:image-01',
      prompt: validPrompt,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ToolNotAvailableError);
  });

  it('openai provider throws ToolNotAvailableError', async () => {
    const r = await executeGenerateImage({
      model: 'gpt-image-1.5',
      prompt: validPrompt,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ToolNotAvailableError);
  });
});

describe('executeGenerateImage — settings validation', () => {
  it('rejects an unsupported aspect ratio for image_auto (only 5 allowlisted ratios)', async () => {
    // image_auto accepts 1:1, 4:3, 3:4, 16:9, 9:16 only. 3:2 is
    // valid in the Zod schema but rejected at execute() time
    // by validateSettingsForModel — the layered validation
    // we're testing here.
    const r = await executeGenerateImage({
      model: 'image_auto',
      prompt: validPrompt,
      settings: { aspectRatio: '3:2' as const, resolution: '1k', seed: 0 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(ToolExecutionError);
      const te = r.error as ToolExecutionError;
      expect(te.retryable).toBe(false);
      expect(te.message).toContain('3:2');
      expect(te.message).toContain('image_auto');
    }
  });

  it('rejects an aspect ratio not in the Zod enum (caught at validation, not provider check)', async () => {
    // A ratio the schema itself rejects — surfaces as ValidationError
    // (NOT ToolExecutionError). Test asserts the layering: invalid
    // schema values fail at the input gate, not at the provider gate.
    const r = await executeGenerateImage({
      model: 'image_auto',
      prompt: validPrompt,
      settings: { aspectRatio: '7:7' as never, resolution: '1k', seed: 0 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ValidationError);
  });

  it('routes an unknown higgsfield:* slug to the higgsfield provider (no connector → ToolNotAvailableError)', async () => {
    // The dispatcher routes any `higgsfield:*` slug to the Higgsfield
    // provider. With no connector in context, that surfaces
    // ToolNotAvailableError — proving the routing without a network call.
    const r = await executeGenerateImage({
      model: 'higgsfield:nonexistent',
      prompt: validPrompt,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ToolNotAvailableError);
  });
});

describe('executeGenerateImage — providerOverride', () => {
  it('routes to mock when providerOverride="mock" even for a non-mock model slug', async () => {
    const r = await executeGenerateImage(
      { model: 'nano_banana_2', prompt: validPrompt },
      { providerOverride: 'mock' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.assetRef.provider).toBe('mock');
  });
});

describe('__test__ helpers', () => {
  it('detectProvider routes the documented slugs to the right provider', () => {
    expect(__test__.detectProvider('mock')).toBe('mock');
    expect(__test__.detectProvider('nano_banana_2')).toBe('higgsfield');
    expect(__test__.detectProvider('nano_banana_flash')).toBe('higgsfield');
    expect(__test__.detectProvider('flux_2')).toBe('higgsfield');
    expect(__test__.detectProvider('gpt_image_2')).toBe('higgsfield');
    expect(__test__.detectProvider('higgsfield:anything')).toBe('higgsfield');
    expect(__test__.detectProvider('minimax:image-01')).toBe('minimax');
    expect(__test__.detectProvider('openai:anything')).toBe('openai');
  });

  it('exposes the current Higgsfield image-model count (catalog sanity check)', () => {
    expect(__test__.higgsfieldImageModelCount).toBe(HIGGSFIELD_IMAGE_MODELS.length);
    expect(__test__.higgsfieldImageModelCount).toBeGreaterThan(0);
  });
});

describe('generateImageTool (Vercel AI SDK shape)', () => {
  it('has a description and schemas', () => {
    const obj = generateImageTool as unknown as Record<string, unknown>;
    expect(typeof obj.description).toBe('string');
    expect(obj.inputSchema).toBeDefined();
    expect(obj.outputSchema).toBeDefined();
  });
});

// Sanity check: the model catalog itself has not been emptied.
it('Higgsfield image model catalog is still populated', () => {
  expect(HIGGSFIELD_IMAGE_MODELS.length).toBeGreaterThanOrEqual(3);
  expect(getHiggsfieldImageModel('nano_banana_2')).toBeDefined();
});
