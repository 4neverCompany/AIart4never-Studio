import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { POST as recapPost } from '@/app/api/cron/sunday-recap/route';
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

const ORIGINAL_ENV = process.env.CRON_SHARED_SECRET;

beforeEach(() => {
  spawnMock.mockReset();
  __setSpawnForTests(spawnMock as never);
});
afterEach(() => {
  __setSpawnForTests(null);
  if (ORIGINAL_ENV === undefined) delete process.env.CRON_SHARED_SECRET;
  else process.env.CRON_SHARED_SECRET = ORIGINAL_ENV;
});

function buildReq(authHeader: string | null, body: unknown = { posts: [] }): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authHeader !== null) headers.Authorization = authHeader;
  return new Request('http://x/api/cron/sunday-recap', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /api/cron/sunday-recap auth', () => {
  it('503s when CRON_SHARED_SECRET is not configured', async () => {
    delete process.env.CRON_SHARED_SECRET;
    const res = await recapPost(buildReq('Bearer anything'));
    expect(res.status).toBe(503);
  });

  it('401s on missing Authorization header', async () => {
    process.env.CRON_SHARED_SECRET = 'topsecret';
    const res = await recapPost(buildReq(null));
    expect(res.status).toBe(401);
  });

  it('401s on wrong secret', async () => {
    process.env.CRON_SHARED_SECRET = 'topsecret';
    const res = await recapPost(buildReq('Bearer wrong'));
    expect(res.status).toBe(401);
  });

  it('401s on right secret with wrong scheme', async () => {
    process.env.CRON_SHARED_SECRET = 'topsecret';
    const res = await recapPost(buildReq('topsecret')); // no "Bearer " prefix
    expect(res.status).toBe(401);
  });

  it('returns the plan + 200 degraded when authed but mmx is unavailable', async () => {
    process.env.CRON_SHARED_SECRET = 'topsecret';
    spawnMock.mockImplementation(() => {
      // isAvailable() probe: emit 'error' to simulate ENOENT.
      const child = new EventEmitter() as FakeChild;
      child.stdout = Readable.from([]);
      child.stderr = Readable.from([]);
      child.kill = vi.fn();
      setImmediate(() => child.emit('error', new Error('ENOENT')));
      return child as never;
    });
    // Pin `now` 1 day after the post so the 7-day window definitely
    // includes the post regardless of when the test runs. Without the
    // pin the route's `now ?? new Date()` made this assertion flaky:
    // the post lives forever at 2026-04-25, so once wall-clock time
    // drifts past 2026-05-02 the post falls out of the window and
    // `topics` becomes []. Caught on 2026-05-02 — fixing here unsticks
    // the precommit hook for the unrelated NCA-INTEGRATION-DEV work.
    const res = await recapPost(
      buildReq('Bearer topsecret', {
        posts: [{ id: '1', date: '2026-04-25T12:00:00Z', caption: '#x' }],
        now: '2026-04-26T00:00:00Z',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plan: { topics: string[] };
      artifacts: null;
      degraded: boolean;
      message: string;
    };
    // Plan is returned even when mmx is missing — useful in workflow logs.
    expect(body.plan.topics).toEqual(['x']);
    expect(body.artifacts).toBeNull();
    expect(body.degraded).toBe(true);
    expect(body.message).toMatch(/MMX CLI not available/);
  });
});
