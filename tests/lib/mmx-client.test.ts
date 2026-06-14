import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
  generateImage,
  generateMusic,
  generateVideo,
  synthesizeSpeech,
  describeImage,
  isAvailable,
  MmxError,
  MmxQuotaError,
  MmxSpawnError,
  __setSpawnForTests,
} from '@/lib/mmx-client';

// Use the lib's __setSpawnForTests injection seam to swap in a fake spawn.
// Cleaner and more robust than vi.mock('node:child_process'), which behaves
// inconsistently for node: built-ins under the project's jsdom default env.
const spawnMock = vi.fn();

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill: (sig?: NodeJS.Signals) => void;
}

function makeChild(stdoutPayload: string, exitCode: number, stderrPayload = ''): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Readable.from([Buffer.from(stdoutPayload, 'utf8')]);
  child.stderr = Readable.from([Buffer.from(stderrPayload, 'utf8')]);
  child.kill = vi.fn();
  // Defer the close event so callers attach listeners first (matches real spawn).
  setImmediate(() => child.emit('close', exitCode));
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
  __setSpawnForTests(spawnMock as never);
});
afterEach(() => {
  __setSpawnForTests(null);
  vi.useRealTimers();
});

describe('mmx-client argument construction', () => {
  it('generateImage builds the correct flags', async () => {
    spawnMock.mockReturnValue(
      makeChild(JSON.stringify({ data: { image_urls: ['https://x/a.png'] } }), 0) as never,
    );

    const result = await generateImage('a cat', {
      aspectRatio: '16:9',
      n: 2,
      seed: 42,
      promptOptimizer: true,
    });

    expect(result.urls).toEqual(['https://x/a.png']);
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toEqual([
      '--output',
      'json',
      'image',
      'generate',
      '--prompt',
      'a cat',
      '--aspect-ratio',
      '16:9',
      '--n',
      '2',
      '--seed',
      '42',
      '--prompt-optimizer',
    ]);
  });

  it('generateMusic rejects mutually exclusive flags', async () => {
    await expect(
      generateMusic('p', { lyrics: 'x', instrumental: true }),
    ).rejects.toThrow(/instrumental cannot be combined with lyrics/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('generateMusic passes through structured flags', async () => {
    spawnMock.mockReturnValue(
      makeChild(JSON.stringify({ output_file: '/tmp/song.mp3' }), 0) as never,
    );
    const result = await generateMusic('cinematic strings', {
      instrumental: true,
      genre: 'orchestral',
      bpm: 90,
      out: '/tmp/song.mp3',
    });
    expect(result.path).toBe('/tmp/song.mp3');
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('--instrumental');
    expect(args).toContain('--genre');
    expect(args).toContain('orchestral');
    expect(args).toContain('--bpm');
    expect(args).toContain('90');
  });

  it('generateVideo with noWait surfaces the task id', async () => {
    spawnMock.mockReturnValue(
      makeChild(JSON.stringify({ task_id: 'task-123' }), 0) as never,
    );
    const result = await generateVideo('a sunrise', { noWait: true });
    expect(result.taskId).toBe('task-123');
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('--no-wait');
  });

  it('synthesizeSpeech surfaces the saved path', async () => {
    spawnMock.mockReturnValue(
      makeChild(JSON.stringify({ output_file: '/tmp/v.mp3' }), 0) as never,
    );
    const result = await synthesizeSpeech('hello', { voice: 'calm', out: '/tmp/v.mp3' });
    expect(result.path).toBe('/tmp/v.mp3');
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('--voice');
    expect(args).toContain('calm');
  });

  it('describeImage routes --image vs --file-id', async () => {
    spawnMock.mockReturnValue(
      makeChild(JSON.stringify({ description: 'a cat on a sofa' }), 0) as never,
    );
    let result = await describeImage({ image: '/tmp/x.png' }, { prompt: 'what is this?' });
    expect(result.description).toBe('a cat on a sofa');
    let args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('--image');
    expect(args).toContain('/tmp/x.png');
    expect(args).toContain('--prompt');
    expect(args).toContain('what is this?');

    spawnMock.mockClear();
    spawnMock.mockReturnValue(
      makeChild(JSON.stringify({ description: 'doc text' }), 0) as never,
    );
    result = await describeImage({ fileId: 'file-9' });
    args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('--file-id');
    expect(args).toContain('file-9');
    expect(args).not.toContain('--image');
  });

  it('does not invoke a shell — prompt with metacharacters is passed verbatim', async () => {
    spawnMock.mockReturnValue(
      makeChild(JSON.stringify({ data: { image_urls: [] } }), 0) as never,
    );
    const evil = 'innocent"; rm -rf / #';
    await generateImage(evil);
    const [, args, opts] = spawnMock.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    // The dangerous string sits in its own argv slot, not concatenated into a shell command.
    expect(args).toContain(evil);
    // No shell invocation: opts.shell must be falsy / undefined.
    expect(opts?.shell).not.toBe(true);
  });
});

describe('mmx-client error handling', () => {
  it('maps Token Plan errors to MmxQuotaError', async () => {
    spawnMock.mockReturnValue(
      makeChild(
        JSON.stringify({
          error: {
            code: 4,
            message:
              'This model is not available on your current Token Plan. your current token plan not support model, image-01',
            hint: 'image-01 requires the Plus plan or above.',
          },
        }),
        0,
      ) as never,
    );
    await expect(generateImage('x')).rejects.toBeInstanceOf(MmxQuotaError);
  });

  it('maps generic JSON errors to MmxError with code', async () => {
    spawnMock.mockReturnValue(
      makeChild(
        JSON.stringify({ error: { code: 401, message: 'unauthorized' } }),
        0,
      ) as never,
    );
    await expect(generateImage('x')).rejects.toMatchObject({
      name: 'MmxError',
      code: 401,
    });
  });

  it('maps spawn ENOENT to MmxSpawnError', async () => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = Readable.from([]);
    child.stderr = Readable.from([]);
    child.kill = vi.fn();
    setImmediate(() => child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
    spawnMock.mockReturnValue(child as never);

    await expect(generateImage('q')).rejects.toBeInstanceOf(MmxSpawnError);
  });

  it('non-JSON stdout becomes a PARSE error', async () => {
    spawnMock.mockReturnValue(makeChild('not json', 0) as never);
    await expect(generateImage('q')).rejects.toMatchObject({
      name: 'MmxError',
      code: 'PARSE',
    });
  });

  it('non-zero exit with empty stdout surfaces stderr', async () => {
    spawnMock.mockReturnValue(makeChild('', 2, 'unexpected boom') as never);
    await expect(generateImage('q')).rejects.toMatchObject({
      name: 'MmxError',
      code: 2,
    });
  });

  // QA-W1: empty stdout + exit 0 used to fall through and silently
  // return undefined cast to T. Now surfaced as a PARSE error so callers
  // that destructure (e.g. `const { path } = await generateMusic(...)`)
  // get an actionable failure at the call site.
  it('empty stdout + exit 0 surfaces a PARSE error', async () => {
    spawnMock.mockReturnValue(makeChild('', 0) as never);
    await expect(generateMusic('p')).rejects.toMatchObject({
      name: 'MmxError',
      code: 'PARSE',
    });
  });
});

describe('mmx-client isAvailable', () => {
  it('returns true on successful --version', async () => {
    spawnMock.mockReturnValue(makeChild('mmx 1.0.12\n', 0) as never);
    expect(await isAvailable()).toBe(true);
  });

  it('returns false on spawn failure', async () => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = Readable.from([]);
    child.stderr = Readable.from([]);
    child.kill = vi.fn();
    setImmediate(() => child.emit('error', new Error('not found')));
    spawnMock.mockReturnValue(child as never);
    expect(await isAvailable()).toBe(false);
  });
});
