/**
 * Tests for lib/agent-tools/virality-predict.ts
 *
 * Coverage:
 *   1. success: returns score + confidence + reasoning
 *   2. low score colour band: score 25 → 0–30 red band
 *   3. provider unavailable: Higgsfield CLI not on PATH
 *   4. invalid input: empty prompt → validation error
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import * as cliUtils from '@/lib/providers/cli-utils';
import {
  __setSpawnForTests,
  __setLogForTests,
} from '@/lib/providers/cli-utils';
import { __resetRegistry, __registerProvider } from '@/lib/providers/registry';
import { HiggsfieldTextAdapter } from '@/lib/providers/higgsfield/text-adapter';
import {
  executeViralityPredict,
  zViralityPredictInput,
  zViralityPredictOutput,
} from '@/lib/agent-tools/virality-predict';
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
  child.stdout = Readable.from([Buffer.from(opts.stdout ?? '', 'utf8')]);
  child.stderr = Readable.from([Buffer.from(opts.stderr ?? '', 'utf8')]);
  child.kill = vi.fn();
  if (opts.errorOnSpawn) {
    setImmediate(() => child.emit('error', opts.errorOnSpawn));
  } else {
    setImmediate(() => child.emit('close', opts.exitCode ?? 0));
  }
  return child;
}

const spawnMock = vi.fn();

beforeEach(() => {
  spawnMock.mockReset();
  __setSpawnForTests(spawnMock as never);
  __setLogForTests(() => {});
  __resetRegistry();
});

afterEach(() => {
  __setSpawnForTests(null);
  __setLogForTests(null);
  __resetRegistry();
});

describe('executeViralityPredict — schema validation', () => {
  it('accepts a valid input with non-empty prompt', () => {
    const result = zViralityPredictInput.safeParse({ prompt: 'A cool crossover #art' });
    expect(result.success).toBe(true);
  });

  it('rejects an empty prompt', () => {
    const result = zViralityPredictInput.safeParse({ prompt: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a prompt that is only whitespace', () => {
    const result = zViralityPredictInput.safeParse({ prompt: '   ' });
    expect(result.success).toBe(false);
  });

  it('accepts a prompt at the max length (4000 chars)', () => {
    const longPrompt = 'x'.repeat(4000);
    const result = zViralityPredictInput.safeParse({ prompt: longPrompt });
    expect(result.success).toBe(true);
  });

  it('rejects a prompt over 4000 chars', () => {
    const longPrompt = 'x'.repeat(4001);
    const result = zViralityPredictInput.safeParse({ prompt: longPrompt });
    expect(result.success).toBe(false);
  });
});

describe('executeViralityPredict — output schema', () => {
  it('accepts a valid output with score + confidence + reasoning', () => {
    const result = zViralityPredictOutput.safeParse({
      score: 78,
      confidence: 0.85,
      reasoning: 'Strong visual hook + trending hashtag',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(78);
      expect(result.data.confidence).toBe(0.85);
    }
  });

  it('accepts score only (confidence and reasoning optional)', () => {
    const result = zViralityPredictOutput.safeParse({ score: 42 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(42);
    }
  });

  it('rejects score below 0', () => {
    const result = zViralityPredictOutput.safeParse({ score: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects score above 100', () => {
    const result = zViralityPredictOutput.safeParse({ score: 101 });
    expect(result.success).toBe(false);
  });
});

describe('executeViralityPredict — integration', () => {
  it('returns score + confidence + reasoning on success', async () => {
    // Set up the mock adapter
    const mockAdapter = new HiggsfieldTextAdapter();
    (mockAdapter as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolvedBinary = 'higgsfield';
    (mockAdapter as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolveAttempted = true;
    __registerProvider('higgsfield-text', mockAdapter);

    spawnMock.mockReturnValue(
      makeChild({
        stdout: JSON.stringify({
          text: JSON.stringify({ score: 78, confidence: 0.85, reasoning: 'Great hashtag combination' }),
        }),
      }) as never,
    );

    const result = await executeViralityPredict({ prompt: 'Darth Vader meets Iron Man #crossover' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.score).toBe(78);
      expect(result.value.confidence).toBe(0.85);
      expect(result.value.reasoning).toBe('Great hashtag combination');
    }
  });

  it('returns score on success even when confidence/reasoning absent', async () => {
    const mockAdapter = new HiggsfieldTextAdapter();
    (mockAdapter as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolvedBinary = 'higgsfield';
    (mockAdapter as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolveAttempted = true;
    __registerProvider('higgsfield-text', mockAdapter);

    spawnMock.mockReturnValue(
      makeChild({
        stdout: JSON.stringify({ text: JSON.stringify({ score: 25 }) }),
      }) as never,
    );

    const result = await executeViralityPredict({ prompt: 'Low engagement post' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.score).toBe(25);
      // 25 is in the 0–30 red/dim band
    }
  });

  it('returns ToolNotAvailableError when the underlying CLI is not on PATH', async () => {
    // Register a HiggsfieldTextAdapter pre-marked as having
    // attempted + failed resolution (resolvedBinary = null,
    // resolveAttempted = true). isAvailable() short-circuits to
    // false, hitting the ToolNotAvailableError branch. We DON'T use
    // __resetRegistry to clear the factory (it doesn't touch
    // FACTORIES), so the real factory is still present; this test
    // verifies the executor's behaviour when the *capability* is
    // unavailable, not when the *provider* is missing from the
    // registry.
    const unavailable = new HiggsfieldTextAdapter();
    (unavailable as unknown as { resolvedBinary: string | null }).resolvedBinary = null;
    (unavailable as unknown as { resolveAttempted: boolean }).resolveAttempted = true;
    __registerProvider('higgsfield-text', unavailable);
    const result = await executeViralityPredict({ prompt: 'Any prompt' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ToolNotAvailableError);
    }
  });
});
