import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { writeFileSync } from 'node:fs';
import { POST as musicPost } from '@/app/api/mmx/music/route';
import { POST as describePost } from '@/app/api/mmx/describe/route';
import { __setSpawnForTests } from '@/lib/mmx-client';

const spawnMock = vi.fn();

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill: (sig?: NodeJS.Signals) => void;
}

function makeChild(stdoutPayload: string, exitCode: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Readable.from([Buffer.from(stdoutPayload, 'utf8')]);
  child.stderr = Readable.from([]);
  child.kill = vi.fn();
  setImmediate(() => child.emit('close', exitCode));
  return child;
}

/**
 * Build a fake spawn that "succeeds" the isAvailable() probe AND, on the
 * second call, runs the supplied `onSecondCall` to write the side-effect
 * artifact (e.g. an mp3 file) before returning the generation response.
 */
function spawnSequenced(generationResponse: string, onSecondCall?: () => void) {
  let n = 0;
  return (..._args: unknown[]) => {
    n += 1;
    if (n === 1) {
      // isAvailable() — `mmx --version`
      return makeChild('mmx 1.0.12\n', 0) as never;
    }
    if (onSecondCall) onSecondCall();
    return makeChild(generationResponse, 0) as never;
  };
}

beforeEach(() => {
  spawnMock.mockReset();
  __setSpawnForTests(spawnMock as never);
});
afterEach(() => {
  __setSpawnForTests(null);
});

describe('POST /api/mmx/music', () => {
  it('400s on missing prompt', async () => {
    const res = await musicPost(
      new Request('http://x/api/mmx/music', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('503s when mmx is not available', async () => {
    spawnMock.mockImplementation((..._args) => {
      const child = new EventEmitter() as FakeChild;
      child.stdout = Readable.from([]);
      child.stderr = Readable.from([]);
      child.kill = vi.fn();
      setImmediate(() => child.emit('error', new Error('ENOENT')));
      return child as never;
    });
    const res = await musicPost(
      new Request('http://x/api/mmx/music', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'cinematic strings' }),
      }),
    );
    expect(res.status).toBe(503);
  });

  it('streams audio bytes back on success', async () => {
    spawnMock.mockImplementation(
      spawnSequenced(JSON.stringify({ output_file: 'placeholder' }), () => {
        // The route hands mmx an --out <tempPath>; capture that arg and
        // write a fake mp3 payload there so the route's readFileSync
        // returns deterministic bytes.
        const args = spawnMock.mock.calls[1][1] as string[];
        const outIdx = args.indexOf('--out');
        const outPath = args[outIdx + 1];
        writeFileSync(outPath, Buffer.from([0x49, 0x44, 0x33])); // 'ID3'
      }),
    );
    const res = await musicPost(
      new Request('http://x/api/mmx/music', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'cinematic strings', options: { instrumental: true } }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.toString('utf8')).toBe('ID3');
  });

  it('402s when MiniMax returns a Token Plan quota error', async () => {
    spawnMock.mockImplementation(
      spawnSequenced(
        JSON.stringify({
          error: { code: 4, message: 'Token Plan does not include music-2.6', hint: 'Upgrade to Plus' },
        }),
      ),
    );
    const res = await musicPost(
      new Request('http://x/api/mmx/music', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'p', options: { instrumental: true } }),
      }),
    );
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string; hint?: string };
    expect(body.error).toMatch(/quota/i);
    expect(body.hint).toMatch(/Upgrade/);
  });
});

describe('POST /api/mmx/describe', () => {
  it('400s when neither image nor fileId is provided', async () => {
    const res = await describePost(
      new Request('http://x/api/mmx/describe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'what is this?' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400s when both image AND fileId are provided', async () => {
    const res = await describePost(
      new Request('http://x/api/mmx/describe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: 'https://x', fileId: 'f-1' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns the description on success', async () => {
    spawnMock.mockImplementation(
      spawnSequenced(JSON.stringify({ description: 'a cat sitting on a sofa' })),
    );
    const res = await describePost(
      new Request('http://x/api/mmx/describe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: '/tmp/x.png' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { description: string };
    expect(body.description).toBe('a cat sitting on a sofa');
  });

  it('502s on a generic mmx error', async () => {
    spawnMock.mockImplementation(
      spawnSequenced(
        JSON.stringify({ error: { code: 401, message: 'unauthorized' } }),
      ),
    );
    const res = await describePost(
      new Request('http://x/api/mmx/describe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: '/tmp/x.png' }),
      }),
    );
    expect(res.status).toBe(502);
  });
});
