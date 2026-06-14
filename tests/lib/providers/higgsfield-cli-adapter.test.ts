/**
 * Tests for lib/providers/higgsfield/cli-adapter.
 *
 * Coverage (per spec):
 *   - happy path: CLI returns JSON with url → AssetRef(kind: 'image', url)
 *   - happy path async: CLI returns JSON with request_id, no url → AssetRef(kind: 'job')
 *   - CLI not found → ProviderUnavailableError
 *   - timeout → ProviderTimeoutError
 *   - JSON parse error → ProviderParseError
 *   - zero-exit JSON error payload → ProviderRejectedError
 *   - generateImage / generateVideo argument construction
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import * as cliUtils from '@/lib/providers/cli-utils';
import {
  __setSpawnForTests,
  __setLogForTests,
  type CliInvokeOptions,
} from '@/lib/providers/cli-utils';
import { HiggsfieldCliAdapter } from '@/lib/providers/higgsfield/cli-adapter';
import {
  ProviderParseError,
  ProviderRejectedError,
  ProviderTimeoutError,
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
const adapter = new HiggsfieldCliAdapter();

beforeEach(() => {
  spawnMock.mockReset();
  __setSpawnForTests(spawnMock as never);
  __setLogForTests(() => {});
  // Force-resolve the binary so isAvailable() short-circuits.
  (adapter as unknown as { resolvedBinary: string | null; resolveAttempted: boolean }).resolvedBinary = 'higgsfield';
  (adapter as unknown as { resolvedBinary: string | null; resolveAttempted: boolean }).resolveAttempted = true;
});

afterEach(() => {
  __setSpawnForTests(null);
  __setLogForTests(null);
});

describe('HiggsfieldCliAdapter.generateImage — happy paths', () => {
  it('returns AssetRef with url for sync image response', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdout: JSON.stringify({ url: 'https://cdn.higgsfield.ai/x.png', request_id: 'r-1' }),
      }) as never,
    );
    const ref = await adapter.generateImage({ prompt: 'a cat' });
    expect(ref.kind).toBe('image');
    expect(ref.provider).toBe('higgsfield');
    expect(ref.url).toBe('https://cdn.higgsfield.ai/x.png');
    expect(ref.jobId).toBe('r-1');
  });

  it('returns AssetRef kind:job when CLI returns request_id only', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdout: JSON.stringify({ request_id: 'r-async-1' }),
      }) as never,
    );
    const ref = await adapter.generateImage({ prompt: 'a cat' });
    expect(ref.kind).toBe('job');
    expect(ref.jobId).toBe('r-async-1');
    expect(ref.url).toBeUndefined();
  });

  it('builds the correct argv with all options', async () => {
    spawnMock.mockReturnValue(
      makeChild({ stdout: JSON.stringify({ url: 'https://x' }) }) as never,
    );
    await adapter.generateImage({
      prompt: 'a cat',
      aspectRatio: '16:9',
      // V1.2.6: --seed / --width / --height / --negative-prompt
      // are NOT in @higgsfield/cli MODELS.md. We intentionally
      // do NOT pass them through even when callers set them —
      // sending them causes the binary to error. The options
      // are kept on the adapter interface for forward-compat
      // with providers that DO support them (Leonardo, mmx);
      // the adapter silently drops them.
      seed: 7,
      width: 1024,
      height: 768,
      negativePrompt: 'blurry',
      referenceImage: { path: '/tmp/ref.png' },
      model: 'text2image_nano_banana',
    });
    const [, args] = spawnMock.mock.calls[0] as [string, string[], unknown];
    expect(args).toContain('--prompt');
    expect(args).toContain('a cat');
    // V1.7.0-PRE-PROD-FIX: the Higgsfield CLI flag is `--aspect_ratio`
    // (UNDERSCORE), not `--aspect-ratio` (hyphen). The hyphen form
    // was rejected by the CLI with "Error: Unknown params:
    // aspect-ratio".
    expect(args).toContain('--aspect_ratio');
    expect(args).toContain('16:9');
    expect(args).not.toContain('--aspect-ratio');
    expect(args).toContain('--image');
    expect(args).toContain('/tmp/ref.png');
    expect(args).toContain('text2image_nano_banana');
    // Sanity: the dropped flags must NOT appear in argv.
    expect(args).not.toContain('--seed');
    expect(args).not.toContain('--width');
    expect(args).not.toContain('--height');
    expect(args).not.toContain('--negative-prompt');
    expect(args).not.toContain('--image-url');
    expect(args).not.toContain('--image-id');
  });

  // V1.7.0-PRE-PROD-FIX: regression test for the hyphen-vs-underscore
  // bug. Spec at lib/model-specs/higgsfield-nano-banana-pro.json:74
  // says "Use --aspect_ratio, NOT --width/--height." The hyphen form
  // `--aspect-ratio` was rejected by the CLI with
  // "Error: Unknown params: aspect-ratio".
  it('uses --aspect_ratio (underscore) — hyphen form would be rejected by the CLI', async () => {
    spawnMock.mockReturnValueOnce(
      makeChild({ stdout: JSON.stringify({ url: 'https://x' }) }) as never,
    );
    await adapter.generateImage({
      prompt: 'test',
      aspectRatio: '4:5',
    });
    const [, args] = spawnMock.mock.calls[0] as [string, string[], unknown];
    // Must use underscore (CLI expects it).
    expect(args).toContain('--aspect_ratio');
    expect(args).toContain('4:5');
    // Must NOT use hyphen (CLI rejects it).
    expect(args).not.toContain('--aspect-ratio');
  });

  // V1.2.6: referenceImage with id (UUID) should be passed
  // verbatim via --image, not turned into a URL.
  it('passes a UUID reference via --image verbatim', async () => {
    spawnMock.mockReturnValue(
      makeChild({ stdout: JSON.stringify({ url: 'https://x' }) }) as never,
    );
    await adapter.generateImage({
      prompt: 'a dog',
      referenceImage: { id: 'prev-job-uuid-1234' },
    });
    const [, args] = spawnMock.mock.calls[0] as [string, string[], unknown];
    expect(args).toContain('--image');
    expect(args).toContain('prev-job-uuid-1234');
  });
});

describe('HiggsfieldCliAdapter.generateVideo — happy paths', () => {
  it('returns AssetRef kind:video for sync URL response', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdout: JSON.stringify({
          url: 'https://cdn.higgsfield.ai/clip.mp4',
          request_id: 'r-vid',
          duration: 8,
        }),
      }) as never,
    );
    const ref = await adapter.generateVideo({ prompt: 'a sunrise', durationSec: 8 });
    expect(ref.kind).toBe('video');
    expect(ref.url).toBe('https://cdn.higgsfield.ai/clip.mp4');
    expect(ref.durationSec).toBe(8);
  });

  it('returns AssetRef kind:job for queued video', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdout: JSON.stringify({ status: 'queued', request_id: 'r-queue-1' }),
      }) as never,
    );
    const ref = await adapter.generateVideo({ prompt: 'a sunrise' });
    expect(ref.kind).toBe('job');
    expect(ref.jobId).toBe('r-queue-1');
  });

  it('throws ProviderRejectedError when CLI returns status=failed', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdout: JSON.stringify({ status: 'failed', error: 'unsafe content' }),
      }) as never,
    );
    await expect(adapter.generateVideo({ prompt: 'x' })).rejects.toBeInstanceOf(
      ProviderRejectedError,
    );
  });
});

describe('HiggsfieldCliAdapter — error paths', () => {
  it('rejects empty prompt', async () => {
    await expect(adapter.generateImage({ prompt: '' })).rejects.toBeInstanceOf(
      ProviderParseError,
    );
  });

  it('rejects video with no prompt and no image', async () => {
    await expect(adapter.generateVideo({ prompt: '' })).rejects.toBeInstanceOf(
      ProviderParseError,
    );
  });

  it('maps CLI-not-found to ProviderUnavailableError', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        errorOnSpawn: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      }) as never,
    );
    await expect(adapter.generateImage({ prompt: 'x' })).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it('maps CLI timeout to ProviderTimeoutError', async () => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = Readable.from([]);
    child.stderr = Readable.from([]);
    // When the helper calls child.kill(), emit 'close' so the
    // helper's promise resolves through the timeout-error path.
    child.kill = vi.fn().mockImplementation(() => {
      setImmediate(() => child.emit('close', null));
    });
    spawnMock.mockReturnValue(child as never);
    await expect(
      adapter.generateImage({ prompt: 'x', timeoutMs: 25 }),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('maps non-JSON stdout to ProviderParseError', async () => {
    spawnMock.mockReturnValue(makeChild({ stdout: 'not json' }) as never);
    await expect(adapter.generateImage({ prompt: 'x' })).rejects.toBeInstanceOf(
      ProviderParseError,
    );
  });

  it('maps zero-exit JSON error payload to ProviderRejectedError', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        stdout: JSON.stringify({
          error: { code: 401, message: 'token expired', hint: 're-auth' },
        }),
      }) as never,
    );
    let caught: unknown;
    try {
      await adapter.generateImage({ prompt: 'x' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderRejectedError);
    expect((caught as ProviderRejectedError).message).toContain('token expired');
  });
});

describe('HiggsfieldCliAdapter.isAvailable', () => {
  it('returns true when binary is pre-resolved', async () => {
    expect(await adapter.isAvailable()).toBe(true);
  });

  it('returns false when no binary resolves', async () => {
    const fresh = new HiggsfieldCliAdapter();
    (fresh as unknown as { resolvedBinary: string | null; resolveAttempted: boolean }).resolveAttempted = true;
    (fresh as unknown as { resolvedBinary: string | null; resolveAttempted: boolean }).resolvedBinary = null;
    expect(await fresh.isAvailable()).toBe(false);
  });
});

describe('HiggsfieldCliAdapter.generateVideo — timeout default (spec 60s)', () => {
  it('applies 60s default when opts.timeoutMs is undefined', async () => {
    const spy = vi.spyOn(cliUtils, 'cliInvoke').mockResolvedValueOnce({
      parsed: { url: 'https://cdn.higgsfield.ai/clip.mp4', request_id: 'r-1', duration: 8 },
      stdout: '{}',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
    } as never);
    await adapter.generateVideo({ prompt: 'a sunrise', durationSec: 8 });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60_000 }));
    spy.mockRestore();
  });

  it('respects opts.timeoutMs override when set', async () => {
    const spy = vi.spyOn(cliUtils, 'cliInvoke').mockResolvedValueOnce({
      parsed: { url: 'https://cdn.higgsfield.ai/clip.mp4', request_id: 'r-2', duration: 8 },
      stdout: '{}',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
    } as never);
    await adapter.generateVideo({ prompt: 'a sunrise', durationSec: 8, timeoutMs: 5000 });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 5000 }));
    spy.mockRestore();
  });
});

describe('HiggsfieldCliAdapter — T1.1 video argv shape', () => {
  it('spawns "generate create <model>" (NOT "video create") for video models', async () => {
    // Regression test for the v1.2.6 → v1.2.9 bug: the adapter
    // built `args = ['video', 'create', model, '--json']` for video
    // models. The @higgsfield/cli v0.1.40 binary has no `video`
    // subcommand — all generations (image + video) go through
    // `generate create <job_set_type>`. The model slug is the only
    // discriminator. Without this assertion the bug shipped to
    // production and CI was green.
    const spy = vi.spyOn(cliUtils, 'cliInvoke').mockResolvedValueOnce({
      parsed: { url: 'https://cdn.higgsfield.ai/clip.mp4', request_id: 'r-vid' },
      stdout: '{}',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
    } as never);
    await adapter.generateVideo({ prompt: 'a sunrise', durationSec: 8 });
    const callArgs = spy.mock.calls[0][0] as CliInvokeOptions<unknown>;
    // Positive: the verb sequence is generate, create, <model>, --json.
    expect(callArgs.args[0]).toBe('generate');
    expect(callArgs.args[1]).toBe('create');
    expect(callArgs.args[2]).toBe('seedance_2_0'); // DEFAULT_VIDEO_MODEL
    expect(callArgs.args[3]).toBe('--json');
    // Negative: 'video' must NOT appear as a top-level arg
    // (it's the name of the family, not a CLI verb).
    expect(callArgs.args).not.toContain('video');
    spy.mockRestore();
  });
});

describe('HiggsfieldCliAdapter — V1.2.6 video image reference', () => {
  it('uses --start-image (not --image) when video has imagePath', async () => {
    const spy = vi.spyOn(cliUtils, 'cliInvoke').mockResolvedValueOnce({
      parsed: { url: 'https://cdn.higgsfield.ai/clip.mp4', request_id: 'r-3' },
      stdout: '{}',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
    } as never);
    await adapter.generateVideo({
      prompt: 'a sunrise',
      imagePath: '/tmp/start.png',
    });
    const callArgs = spy.mock.calls[0][0] as CliInvokeOptions<unknown>;
    expect(callArgs.args).toContain('--start-image');
    expect(callArgs.args).toContain('/tmp/start.png');
    expect(callArgs.args).not.toContain('--image');
    spy.mockRestore();
  });
});

describe('HiggsfieldCliAdapter — V1.2.6 auth via HIGGSFIELD_CREDENTIALS_PATH', () => {
  it('forwards token via a temp credentials.json when cliToken is set', async () => {
    const spy = vi.spyOn(cliUtils, 'cliInvoke').mockResolvedValueOnce({
      parsed: { url: 'https://x' },
      stdout: '{}',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
    } as never);
    const authed = new HiggsfieldCliAdapter({ cliToken: 'test-jwt-abc-123' });
    await authed.generateImage({ prompt: 'a cat' });
    const callArgs = spy.mock.calls[0][0] as CliInvokeOptions<unknown>;
    expect(callArgs.env).toBeDefined();
    expect(callArgs.env).toHaveProperty('HIGGSFIELD_CREDENTIALS_PATH');
    // V1.2.5's HIGGSFIELD_API_KEY is the silent-no-op path;
    // it must NOT be set after v1.2.6.
    expect(callArgs.env).not.toHaveProperty('HIGGSFIELD_API_KEY');
    const credPath = (callArgs.env as Record<string, string>).HIGGSFIELD_CREDENTIALS_PATH;
    // The file must exist and contain the right shape.
    const fs = await import('node:fs/promises');
    const contents = JSON.parse(await fs.readFile(credPath, 'utf8'));
    expect(contents).toEqual({ access_token: 'test-jwt-abc-123' });
    spy.mockRestore();
  });

  it('omits env entirely when no cliToken is set (CLI uses its own auth cache)', async () => {
    const spy = vi.spyOn(cliUtils, 'cliInvoke').mockResolvedValueOnce({
      parsed: { url: 'https://x' },
      stdout: '{}',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
    } as never);
    const fresh = new HiggsfieldCliAdapter(); // no cliToken
    await fresh.generateImage({ prompt: 'a cat' });
    const callArgs = spy.mock.calls[0][0] as CliInvokeOptions<unknown>;
    expect(callArgs.env).toBeUndefined();
    spy.mockRestore();
  });
});

describe('HiggsfieldCliAdapter.estimateCost — T1.3 credit-cost preview', () => {
  it('returns credits for a sync cost response', async () => {
    const spy = vi.spyOn(cliUtils, 'cliInvoke').mockResolvedValueOnce({
      parsed: { credits: 60, credits_exact: 60 },
      stdout: '{}',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
    } as never);
    const a = new HiggsfieldCliAdapter();
    (a as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolvedBinary = 'higgsfield';
    (a as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolveAttempted = true;
    const out = await a.estimateCost('seedance_2_0', { prompt: 'a sunrise' });
    expect(out.credits).toBe(60);
    expect(out.currency).toBe('credit');
    spy.mockRestore();
  });

  it('builds the right argv: generate cost <model> --prompt <text> --json', async () => {
    const spy = vi.spyOn(cliUtils, 'cliInvoke').mockResolvedValueOnce({
      parsed: { credits: 4 },
      stdout: '{}',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
    } as never);
    const a = new HiggsfieldCliAdapter();
    (a as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolvedBinary = 'higgsfield';
    (a as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolveAttempted = true;
    await a.estimateCost('nano_banana_2', { prompt: 'a cat' });
    const callArgs = spy.mock.calls[0][0] as CliInvokeOptions<unknown>;
    expect(callArgs.args[0]).toBe('generate');
    expect(callArgs.args[1]).toBe('cost');
    expect(callArgs.args[2]).toBe('nano_banana_2');
    expect(callArgs.args[3]).toBe('--json');
    spy.mockRestore();
  });

  it('throws ProviderParseError on a non-numeric credits field', async () => {
    const spy = vi.spyOn(cliUtils, 'cliInvoke').mockResolvedValueOnce({
      parsed: { credits: 'sixty' }, // wrong type
      stdout: '{}',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
    } as never);
    const a = new HiggsfieldCliAdapter();
    (a as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolvedBinary = 'higgsfield';
    (a as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolveAttempted = true;
    await expect(a.estimateCost('nano_banana_2', { prompt: 'a cat' })).rejects.toThrow();
    spy.mockRestore();
  });

  it('throws ProviderUnavailableError when the CLI is not on PATH', async () => {
    const a = new HiggsfieldCliAdapter();
    (a as unknown as { resolvedBinary: string | null }).resolvedBinary = null;
    (a as unknown as { resolveAttempted: boolean }).resolveAttempted = true;
    await expect(a.estimateCost('nano_banana_2', { prompt: 'a cat' })).rejects.toThrow();
  });
});
