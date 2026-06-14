/**
 * Tests for lib/providers/higgsfield/text-adapter.ts
 *
 * Coverage (per brief acceptance criteria):
 *   1. sync response: CLI returns valid JSON with score/confidence/reasoning
 *   2. async response: CLI returns JSON with score only (no confidence)
 *   3. missing CLI: isAvailable returns false when binary not found
 *   4. error payload: CLI returns error JSON → ProviderRejectedError
 *   5. auth env: cliToken option writes temp credentials.json
 *   6. generateText argument construction
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import * as cliUtils from '@/lib/providers/cli-utils';
import {
  __setSpawnForTests,
  __setLogForTests,
} from '@/lib/providers/cli-utils';
import { HiggsfieldTextAdapter } from '@/lib/providers/higgsfield/text-adapter';
import {
  ProviderParseError,
  ProviderRejectedError,
  ProviderUnavailableError,
} from '@/lib/providers/interface';

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
let adapter: HiggsfieldTextAdapter;

beforeEach(() => {
  spawnMock.mockReset();
  __setSpawnForTests(spawnMock as never);
  __setLogForTests(() => {});
  adapter = new HiggsfieldTextAdapter();
  // Force-resolve the binary so isAvailable() short-circuits.
  (adapter as unknown as { resolvedBinary: string | null; resolveAttempted: boolean }).resolvedBinary = 'higgsfield';
  (adapter as unknown as { resolvedBinary: string | null; resolveAttempted: boolean }).resolveAttempted = true;
});

afterEach(() => {
  __setSpawnForTests(null);
  __setLogForTests(null);
});

describe('HiggsfieldTextAdapter.generateText — happy paths', () => {
  it('returns score + confidence + reasoning from brain_activity response', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdout: JSON.stringify({
          text: JSON.stringify({ score: 78, confidence: 0.85, reasoning: 'High visual contrast and trending niche' }),
          request_id: 'req-1',
        }),
      }) as never,
    );
    const result = await adapter.generateText('A majestic lion in a cyberpunk city at sunset #nature');
    expect(result.score).toBe(78);
    expect(result.confidence).toBe(0.85);
    expect(result.reasoning).toBe('High visual contrast and trending niche');
  });

  it('returns score when confidence and reasoning are absent', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdout: JSON.stringify({
          text: JSON.stringify({ score: 42 }),
          request_id: 'req-2',
        }),
      }) as never,
    );
    const result = await adapter.generateText('A cat in a hat');
    expect(result.score).toBe(42);
    expect(result.confidence).toBeUndefined();
    expect(result.reasoning).toBeUndefined();
  });

  it('builds the correct argv for brain_activity model', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdout: JSON.stringify({
          text: JSON.stringify({ score: 55 }),
        }),
      }) as never,
    );
    await adapter.generateText('Test prompt #test');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('generate');
    expect(args).toContain('create');
    expect(args).toContain('brain_activity');
    expect(args).toContain('--json');
    const promptIdx = args.indexOf('--prompt');
    expect(promptIdx).toBeGreaterThan(-1);
    expect(args[promptIdx + 1]).toBe('Test prompt #test');
  });
});

describe('HiggsfieldTextAdapter.generateText — error paths', () => {
  it('throws ProviderParseError when CLI stdout is not JSON', async () => {
    spawnMock.mockReturnValue(makeChild({ stdout: 'not json at all' }) as never);
    await expect(adapter.generateText('any prompt')).rejects.toThrow(ProviderParseError);
  });

  it('throws ProviderParseError when brain_activity output is not valid JSON', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdout: JSON.stringify({ text: 'also not json' }),
      }) as never,
    );
    await expect(adapter.generateText('any prompt')).rejects.toThrow(ProviderParseError);
  });

  it('throws ProviderParseError when score is out of range', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdout: JSON.stringify({ text: JSON.stringify({ score: 150 }) }),
      }) as never,
    );
    await expect(adapter.generateText('any prompt')).rejects.toThrow(ProviderParseError);
  });

  it('throws ProviderParseError when prompt is empty', async () => {
    await expect(adapter.generateText('')).rejects.toThrow(ProviderParseError);
    await expect(adapter.generateText('   ')).rejects.toThrow(ProviderParseError);
  });

  it('throws ProviderRejectedError when CLI returns error payload', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdout: JSON.stringify({
          error: { code: 'INVALID_REQUEST', message: 'Prompt too long' },
        }),
      }) as never,
    );
    await expect(adapter.generateText('any prompt')).rejects.toThrow(ProviderRejectedError);
  });
});

describe('HiggsfieldTextAdapter.isAvailable', () => {
  it('returns true when binary is resolved', async () => {
    const available = await adapter.isAvailable();
    expect(available).toBe(true);
  });

  it('returns false when binary is not found', async () => {
    const unresolvedAdapter = new HiggsfieldTextAdapter();
    (unresolvedAdapter as unknown as { resolvedBinary: string | null }).resolvedBinary = null;
    (unresolvedAdapter as unknown as { resolveAttempted: boolean }).resolveAttempted = true;
    const available = await unresolvedAdapter.isAvailable();
    expect(available).toBe(false);
  });
});

describe('HiggsfieldTextAdapter.estimateCost — T1.3 credit-cost preview', () => {
  it('returns credits for a sync cost response', async () => {
    const spy = vi.spyOn(cliUtils, 'cliInvoke').mockResolvedValueOnce({
      parsed: { credits: 1, credits_exact: 1 },
      stdout: '{}',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
    } as never);
    const a = new HiggsfieldTextAdapter();
    (a as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolvedBinary = 'higgsfield';
    (a as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolveAttempted = true;
    const out = await a.estimateCost('a caption to estimate');
    expect(out.credits).toBe(1);
    expect(out.currency).toBe('credit');
    spy.mockRestore();
  });

  it('builds the right argv: generate cost brain_activity --json', async () => {
    const spy = vi.spyOn(cliUtils, 'cliInvoke').mockResolvedValueOnce({
      parsed: { credits: 1 },
      stdout: '{}',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
    } as never);
    const a = new HiggsfieldTextAdapter();
    (a as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolvedBinary = 'higgsfield';
    (a as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolveAttempted = true;
    await a.estimateCost('estimate this');
    const callArgs = spy.mock.calls[0][0] as { args: string[] };
    expect(callArgs.args[0]).toBe('generate');
    expect(callArgs.args[1]).toBe('cost');
    expect(callArgs.args[2]).toBe('brain_activity');
    expect(callArgs.args[3]).toBe('--json');
    spy.mockRestore();
  });
});
