/**
 * Tests for lib/agent-tools/cost-estimate.ts
 *
 * Coverage:
 *   - routes text models (brain_activity, llm_text) to text adapter
 *   - routes non-text models to the CLI adapter
 *   - returns the credit cost in the typed output
 *   - handles CLI not on PATH → ToolNotAvailableError
 *   - invalid input → result.ok is false
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import * as cliUtils from '@/lib/providers/cli-utils';
import { __setSpawnForTests } from '@/lib/providers/cli-utils';
import { __resetRegistry, __registerProvider } from '@/lib/providers/registry';
import { HiggsfieldTextAdapter } from '@/lib/providers/higgsfield/text-adapter';
import { HiggsfieldCliAdapter } from '@/lib/providers/higgsfield/cli-adapter';
import {
  executeCostEstimate,
  zCostEstimateInput,
  zCostEstimateOutput,
  costEstimateTool,
} from '@/lib/agent-tools/cost-estimate';
import { ToolNotAvailableError } from '@/lib/agent-tools/errors';

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill: ReturnType<typeof vi.fn>;
}

function makeChild(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  errorOnSpawn?: Error;
} = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  if (opts.stdout) stdout.push(opts.stdout);
  if (opts.stderr) stderr.push(opts.stderr);
  stdout.push(null);
  stderr.push(null);
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn();
  if (opts.errorOnSpawn) {
    setImmediate(() => child.emit('error', opts.errorOnSpawn));
  } else {
    setImmediate(() => {
      child.emit('close', opts.exitCode ?? 0);
    });
  }
  return child;
}

const spawnMock = vi.fn();

beforeEach(() => {
  __setSpawnForTests(spawnMock as never);
  spawnMock.mockReset();
});

afterEach(() => {
  __setSpawnForTests(null);
  __resetRegistry();
});

describe('executeCostEstimate — schema validation', () => {
  it('accepts a valid input with model only', () => {
    const result = zCostEstimateInput.safeParse({ model: 'nano_banana_2' });
    expect(result.success).toBe(true);
  });

  it('accepts a valid input with model + prompt', () => {
    const result = zCostEstimateInput.safeParse({
      model: 'seedance_2_0',
      prompt: 'a sunrise',
      durationSec: 8,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty model', () => {
    const result = zCostEstimateInput.safeParse({ model: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid imageUrl', () => {
    const result = zCostEstimateInput.safeParse({
      model: 'nano_banana_2',
      imageUrl: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('output schema requires credits number and credit currency', () => {
    const r = zCostEstimateOutput.safeParse({ credits: 4, currency: 'credit', model: 'x' });
    expect(r.success).toBe(true);
    const r2 = zCostEstimateOutput.safeParse({ credits: 4, currency: 'usd', model: 'x' });
    expect(r2.success).toBe(false);
  });
});

describe('executeCostEstimate — text adapter routing', () => {
  it('routes brain_activity to the text adapter and returns credits', async () => {
    // Pre-resolve the binary so isAvailable returns true
    const ta = new HiggsfieldTextAdapter();
    (ta as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolvedBinary = 'higgsfield';
    (ta as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolveAttempted = true;
    __registerProvider('higgsfield-text', ta);

    spawnMock.mockReturnValue(
      makeChild({ stdout: JSON.stringify({ credits: 1, credits_exact: 1 }) }) as never,
    );

    const result = await executeCostEstimate({
      model: 'brain_activity',
      prompt: 'estimate this caption',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.credits).toBe(1);
      expect(result.value.currency).toBe('credit');
      expect(result.value.model).toBe('brain_activity');
    }
  });

  it('routes llm_text to the text adapter', async () => {
    const ta = new HiggsfieldTextAdapter();
    (ta as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolvedBinary = 'higgsfield';
    (ta as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolveAttempted = true;
    __registerProvider('higgsfield-text', ta);

    spawnMock.mockReturnValue(
      makeChild({ stdout: JSON.stringify({ credits: 2 }) }) as never,
    );

    const result = await executeCostEstimate({ model: 'llm_text' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.credits).toBe(2);
      expect(result.value.model).toBe('llm_text');
    }
  });
});

describe('executeCostEstimate — error paths', () => {
  it('returns ToolNotAvailableError when the underlying CLI is not on PATH', async () => {
    // Register the text adapter pre-marked as failed resolution
    const ta = new HiggsfieldTextAdapter();
    (ta as unknown as { resolvedBinary: string | null }).resolvedBinary = null;
    (ta as unknown as { resolveAttempted: boolean }).resolveAttempted = true;
    __registerProvider('higgsfield-text', ta);

    const result = await executeCostEstimate({ model: 'brain_activity' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ToolNotAvailableError);
    }
  });

  it('handles a non-text model by routing to the CLI adapter', async () => {
    // For non-text models the executor calls the CLI adapter's
    // estimateCost(model, opts) with the model slug as the first
    // arg. We pre-resolve the CLI adapter's binary and mock the
    // spawn to return a cost response — proves the routing went
    // through the CLI adapter, not the text adapter.
    const cli = new HiggsfieldCliAdapter();
    (cli as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolvedBinary = 'higgsfield';
    (cli as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolveAttempted = true;
    __registerProvider('higgsfield', cli);

    spawnMock.mockReturnValue(
      makeChild({ stdout: JSON.stringify({ credits: 60 }) }) as never,
    );
    const result = await executeCostEstimate({
      model: 'seedance_2_0',
      prompt: 'a sunrise',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.credits).toBe(60);
      expect(result.value.model).toBe('seedance_2_0');
    }
  });
});

describe('cost_estimate tool — AI SDK registration', () => {
  it('is exported as a tool with a non-empty description', () => {
    expect(costEstimateTool).toBeDefined();
    const desc = (costEstimateTool as unknown as { description: string }).description;
    expect(desc.length).toBeGreaterThan(40);
  });

  it('has an inputSchema and outputSchema', () => {
    const t = costEstimateTool as unknown as { inputSchema: unknown; outputSchema: unknown };
    expect(t.inputSchema).toBeDefined();
    expect(t.outputSchema).toBeDefined();
  });
});
