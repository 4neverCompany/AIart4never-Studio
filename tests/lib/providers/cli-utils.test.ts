/**
 * Tests for lib/providers/cli-utils — the shared spawn/parse
 * helper used by every CLI-based adapter.
 *
 * Coverage:
 *   - happy path: spawn + JSON parse + Zod validation
 *   - non-zero exit with stderr → ProviderExecError
 *   - non-zero exit with JSON error payload → ProviderExecError
 *     with extracted message
 *   - exit 0 + empty stdout + tolerateEmptyStdout=false → ProviderParseError
 *   - exit 0 + empty stdout + tolerateEmptyStdout=true → ok, parsed=undefined
 *   - timeout → ProviderTimeoutError + SIGTERM
 *   - Zod validation failure → ProviderParseError
 *   - spawn ENOENT → ProviderUnavailableError
 *   - Windows .cmd path adds shell:true
 *
 * Test injection uses __setSpawnForTests — same pattern as
 * lib/mmx-client.ts. Cleaner than vi.mock('node:child_process').
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { z } from 'zod';
import {
  cliInvoke,
  __setSpawnForTests,
  __setLogForTests,
  isBinaryAvailable,
  binaryExists,
  pushFlag,
  pushBool,
  spawnNeedsShell,
  pickSafeCwd,
  type CliInvokeOptions,
} from '@/lib/providers/cli-utils';
import {
  ProviderExecError,
  ProviderParseError,
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
  killAfterMs?: number;
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
});
afterEach(() => {
  __setSpawnForTests(null);
  __setLogForTests(null);
});

const okJson = { url: 'https://x/a.png', request_id: 'r-1' };
const OkSchema = z.object({ url: z.string(), request_id: z.string() });

describe('cli-utils spawnNeedsShell', () => {
  it('is true on win32 for .cmd / .bat', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(spawnNeedsShell('C:\\foo\\bar.cmd')).toBe(true);
      expect(spawnNeedsShell('C:\\foo\\bar.bat')).toBe(true);
      expect(spawnNeedsShell('C:\\foo\\bar.exe')).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });
  it('is false on non-win32 even with .cmd', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      expect(spawnNeedsShell('mmx.cmd')).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });
});

describe('cli-utils pushFlag / pushBool', () => {
  it('skips undefined / null', () => {
    const args: string[] = [];
    pushFlag(args, '--foo', undefined);
    pushFlag(args, '--bar', null);
    expect(args).toEqual([]);
  });
  it('emits --flag value when defined', () => {
    const args: string[] = [];
    pushFlag(args, '--n', 2);
    pushFlag(args, '--q', 'HIGH');
    expect(args).toEqual(['--n', '2', '--q', 'HIGH']);
  });
  it('pushBool only emits when truthy', () => {
    const args: string[] = [];
    pushBool(args, '--enable', true);
    pushBool(args, '--disable', false);
    pushBool(args, '--maybe', undefined);
    expect(args).toEqual(['--enable']);
  });
});

describe('cli-utils cliInvoke happy path', () => {
  it('parses JSON, validates with Zod, returns typed result', async () => {
    spawnMock.mockReturnValue(
      makeChild({ stdout: JSON.stringify(okJson) }) as never,
    );
    const opts: CliInvokeOptions<z.infer<typeof OkSchema>> = {
      provider: 'p',
      binary: 'p-bin',
      args: ['hello'],
      schema: OkSchema,
    };
    const r = await cliInvoke(opts);
    expect(r.parsed).toEqual(okJson);
    expect(r.exitCode).toBe(0);
    expect(spawnMock).toHaveBeenCalledWith(
      'p-bin',
      ['hello'],
      expect.objectContaining({ shell: false, stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('does not invoke a shell — prompt metacharacters stay verbatim', async () => {
    spawnMock.mockReturnValue(
      makeChild({ stdout: JSON.stringify({ url: 'x' }) }) as never,
    );
    const evil = 'innocent"; rm -rf / #';
    await cliInvoke({
      provider: 'p',
      binary: 'p',
      args: ['--prompt', evil],
    });
    const callArgs = spawnMock.mock.calls[0];
    expect(callArgs[1]).toContain(evil);
    expect(callArgs[2].shell).not.toBe(true);
  });
});

describe('cli-utils cliInvoke error paths', () => {
  it('non-zero exit + stderr → ProviderExecError', async () => {
    spawnMock.mockReturnValue(
      makeChild({ exitCode: 2, stderr: 'unexpected boom' }) as never,
    );
    await expect(
      cliInvoke({ provider: 'p', binary: 'p', args: [] }),
    ).rejects.toBeInstanceOf(ProviderExecError);
  });

  it('non-zero exit + JSON error payload → ProviderExecError with extracted message', async () => {
    const payload = JSON.stringify({ error: { code: 401, message: 'unauthorized' } });
    spawnMock.mockReturnValue(
      makeChild({ exitCode: 1, stdout: payload, stderr: '' }) as never,
    );
    let caught: unknown;
    try {
      await cliInvoke({ provider: 'p', binary: 'p', args: [] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderExecError);
    expect((caught as ProviderExecError).message).toContain('unauthorized');
  });

  it('exit 0 + empty stdout → ProviderParseError', async () => {
    spawnMock.mockReturnValue(makeChild({ stdout: '' }) as never);
    await expect(
      cliInvoke({ provider: 'p', binary: 'p', args: [] }),
    ).rejects.toMatchObject({ name: 'ProviderParseError', code: 'PARSE' });
  });

  it('exit 0 + empty stdout + tolerateEmptyStdout=true → ok, parsed undefined', async () => {
    spawnMock.mockReturnValue(makeChild({ stdout: '' }) as never);
    const r = await cliInvoke<undefined>({
      provider: 'p',
      binary: 'p',
      args: [],
      tolerateEmptyStdout: true,
    });
    expect(r.parsed).toBeUndefined();
  });

  it('Zod validation failure → ProviderParseError', async () => {
    spawnMock.mockReturnValue(
      makeChild({ stdout: JSON.stringify({ wrong: 'shape' }) }) as never,
    );
    await expect(
      cliInvoke({ provider: 'p', binary: 'p', args: [], schema: OkSchema }),
    ).rejects.toMatchObject({ name: 'ProviderParseError' });
  });

  it('non-JSON stdout → ProviderParseError', async () => {
    spawnMock.mockReturnValue(
      makeChild({ stdout: 'not json at all' }) as never,
    );
    await expect(
      cliInvoke({ provider: 'p', binary: 'p', args: [] }),
    ).rejects.toMatchObject({ name: 'ProviderParseError' });
  });
});

describe('cli-utils cliInvoke timeout and ENOENT', () => {
  it('timeout → ProviderTimeoutError + child.kill SIGTERM', async () => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = Readable.from([]);
    child.stderr = Readable.from([]);
    // When the helper calls child.kill(), emit 'close' so the
    // helper's promise resolves (with the timeout-error path).
    child.kill = vi.fn().mockImplementation(() => {
      setImmediate(() => child.emit('close', null));
    });
    spawnMock.mockReturnValue(child as never);
    await expect(
      cliInvoke({ provider: 'p', binary: 'p', args: [], timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('spawn ENOENT → ProviderUnavailableError', async () => {
    spawnMock.mockReturnValue(
      makeChild({
        errorOnSpawn: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      }) as never,
    );
    await expect(
      cliInvoke({ provider: 'p', binary: 'missing-bin', args: [] }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe('cli-utils isBinaryAvailable', () => {
  it('returns true on exit 0', async () => {
    spawnMock.mockReturnValue(makeChild({ stdout: 'v1.0' }) as never);
    expect(await isBinaryAvailable('higgsfield')).toBe(true);
  });

  it('returns false on spawn ENOENT', async () => {
    spawnMock.mockReturnValue(
      makeChild({ errorOnSpawn: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }) as never,
    );
    expect(await isBinaryAvailable('nope')).toBe(false);
  });

  it('returns true on non-zero exit (binary is present, just unhappy)', async () => {
    spawnMock.mockReturnValue(makeChild({ exitCode: 1, stderr: 'no' }) as never);
    expect(await isBinaryAvailable('crashy')).toBe(true);
  });
});

describe('cli-utils binaryExists', () => {
  it('returns false for empty', () => {
    expect(binaryExists('')).toBe(false);
  });
  it('returns true for path-like names without probing', () => {
    expect(binaryExists('C:/foo/bar.exe')).toBe(true);
    expect(binaryExists('./local-bin')).toBe(true);
  });
});

describe('cli-utils pickSafeCwd (V1.8.1-UNC-CWD)', () => {
  const TMP = '/tmp/x';
  it('overrides to tmp when the Windows cwd is an extended-length \\\\?\\ path', () => {
    expect(pickSafeCwd('win32', '\\\\?\\G:\\MashupForge\\resources\\app', TMP)).toBe(TMP);
  });
  it('overrides to tmp for a true UNC \\\\server\\share cwd', () => {
    expect(pickSafeCwd('win32', '\\\\server\\share\\app', TMP)).toBe(TMP);
  });
  it('overrides to tmp when process.cwd() threw (null)', () => {
    expect(pickSafeCwd('win32', null, TMP)).toBe(TMP);
  });
  it('inherits (undefined) for a normal drive-letter cwd', () => {
    expect(pickSafeCwd('win32', 'C:\\Users\\x\\app', TMP)).toBeUndefined();
  });
  it('always inherits on non-Windows', () => {
    expect(pickSafeCwd('linux', '\\\\?\\weird', TMP)).toBeUndefined();
    expect(pickSafeCwd('darwin', null, TMP)).toBeUndefined();
  });
});
