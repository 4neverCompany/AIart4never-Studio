import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { POST as imagePost } from '@/app/api/mmx/image/route';
import { __setSpawnForTests } from '@/lib/mmx-client';

// STORY-MMX-PROMPT-WIRE — pin /api/mmx/image as the second consumer of
// buildEnhancedPrompt. The route owns the spec lookup so callers send
// raw inputs (modelId, styleName, aspectRatio) and we forward
// result.mmx to the CLI alongside result.prompt.

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

/** First spawn call answers `mmx --version` (isAvailable probe), second
 *  is the actual generate. */
function spawnSequenced(generationResponse: string) {
  let n = 0;
  return (..._args: unknown[]) => {
    n += 1;
    if (n === 1) return makeChild('mmx 1.0.12\n', 0) as never;
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

describe('POST /api/mmx/image', () => {
  it('400s on missing prompt', async () => {
    const res = await imagePost(
      new Request('http://x/api/mmx/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400s on whitespace-only prompt', async () => {
    const res = await imagePost(
      new Request('http://x/api/mmx/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '   ' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400s on invalid JSON body', async () => {
    const res = await imagePost(
      new Request('http://x/api/mmx/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
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
    const res = await imagePost(
      new Request('http://x/api/mmx/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'a cat' }),
      }),
    );
    expect(res.status).toBe(503);
  });

  it('returns urls on success and forwards spec inputs through buildEnhancedPrompt', async () => {
    spawnMock.mockImplementation(
      spawnSequenced(JSON.stringify({ data: { image_urls: ['https://x/y.png'] } })),
    );
    const res = await imagePost(
      new Request('http://x/api/mmx/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'a cat',
          modelId: 'nano-banana-2',
          aspectRatio: '16:9',
          count: 2,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      urls: string[];
      appliedHints: string[];
      finalPrompt: string;
    };
    expect(body.urls).toEqual(['https://x/y.png']);
    // buildEnhancedPrompt appended hint phrases — these come from the
    // model spec, not the route, so a regression in either side surfaces
    // here.
    expect(body.appliedHints).toEqual(expect.arrayContaining(['aspect ratio: 16:9']));
    expect(body.finalPrompt).toMatch(/aspect ratio: 16:9/);

    // The second spawn call is the actual generate; assert the args the
    // route handed mmx came from result.mmx (aspect ratio + count).
    const args = spawnMock.mock.calls[1][1] as string[];
    expect(args).toContain('image');
    expect(args).toContain('generate');
    const aspectIdx = args.indexOf('--aspect-ratio');
    expect(aspectIdx).toBeGreaterThan(-1);
    expect(args[aspectIdx + 1]).toBe('16:9');
    const nIdx = args.indexOf('--n');
    expect(nIdx).toBeGreaterThan(-1);
    expect(args[nIdx + 1]).toBe('2');
  });

  it('works without spec inputs (raw prompt passes through)', async () => {
    spawnMock.mockImplementation(
      spawnSequenced(JSON.stringify({ data: { image_urls: ['https://x/z.png'] } })),
    );
    const res = await imagePost(
      new Request('http://x/api/mmx/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'a cat' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { finalPrompt: string; appliedHints: string[] };
    expect(body.finalPrompt).toBe('a cat');
    expect(body.appliedHints).toEqual([]);
  });

  it('402s when MiniMax returns a Token Plan quota error', async () => {
    spawnMock.mockImplementation(
      spawnSequenced(
        JSON.stringify({
          error: { code: 4, message: 'Token Plan does not include image-01', hint: 'Upgrade to Plus' },
        }),
      ),
    );
    const res = await imagePost(
      new Request('http://x/api/mmx/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'a cat' }),
      }),
    );
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string; hint?: string };
    expect(body.error).toMatch(/quota/i);
    expect(body.hint).toMatch(/Upgrade/);
  });

  it('502s on a generic mmx error', async () => {
    spawnMock.mockImplementation(
      spawnSequenced(JSON.stringify({ error: { code: 401, message: 'unauthorized' } })),
    );
    const res = await imagePost(
      new Request('http://x/api/mmx/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'a cat' }),
      }),
    );
    expect(res.status).toBe(502);
  });
});
