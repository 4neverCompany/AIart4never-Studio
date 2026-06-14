import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { planRecap, executeRecap, AVATAR_VOICE_PROFILE } from '@/lib/sunday-recap';
import { __setSpawnForTests } from '@/lib/mmx-client';

const FIXED_NOW = new Date('2026-04-26T10:00:00Z'); // a Sunday

describe('planRecap', () => {
  it('filters posts to the rolling window', () => {
    // FIXED_NOW = 2026-04-26 10:00 UTC, windowDays=7
    // → window starts at 2026-04-19 10:00. Posts on or after that are in.
    const plan = planRecap(
      [
        { id: 'a', date: '2026-04-25T12:00:00Z', caption: '#cyberpunk #night' }, // in
        { id: 'b', date: '2026-04-21T12:00:00Z', caption: '#space' },             // in
        { id: 'c', date: '2026-04-19T11:00:00Z', caption: '#ancient' },           // in (1h after start)
        { id: 'd', date: '2026-04-15T12:00:00Z', caption: '#dropped' },           // out
      ],
      { now: FIXED_NOW, windowDays: 7 },
    );
    expect(plan.postsConsidered).toBe(4);
    expect(plan.postsInWindow).toBe(3);
  });

  it('extracts top hashtags as topics, lower-cased and frequency-ranked', () => {
    const plan = planRecap(
      [
        { id: '1', date: '2026-04-25T12:00:00Z', caption: '#cyberpunk #cyberpunk #space' },
        { id: '2', date: '2026-04-24T12:00:00Z', caption: '#cyberpunk #space' },
        { id: '3', date: '2026-04-23T12:00:00Z', caption: '#dragon' },
      ],
      { now: FIXED_NOW, maxTopics: 5 },
    );
    expect(plan.topics[0]).toBe('cyberpunk');
    expect(plan.topics[1]).toBe('space');
    expect(plan.topics).toContain('dragon');
  });

  it('uses explicit hashtags array over caption scan', () => {
    const plan = planRecap(
      [{ id: '1', date: '2026-04-25T12:00:00Z', caption: 'no tags here', hashtags: ['Mecha', 'noir'] }],
      { now: FIXED_NOW },
    );
    expect(plan.topics).toEqual(['mecha', 'noir']);
  });

  it('builds an "AI art 4never" video prompt referencing the topics', () => {
    const plan = planRecap(
      [{ id: '1', date: '2026-04-25T12:00:00Z', caption: '#mecha #noir' }],
      { now: FIXED_NOW },
    );
    expect(plan.videoPrompt).toMatch(/AI art 4never/);
    expect(plan.videoPrompt).toMatch(/mecha/);
  });

  it('builds a music prompt that asks for warm + dramatic + instrumental cues', () => {
    const plan = planRecap([], { now: FIXED_NOW });
    expect(plan.musicPrompt).toMatch(/warm/i);
    expect(plan.musicPrompt).toMatch(/dramatic/i);
  });

  it('voiceover script: zero-post fallback', () => {
    const plan = planRecap([], { now: FIXED_NOW });
    expect(plan.voiceoverScript).toMatch(/Hey friends.*what a week/);
    expect(plan.voiceoverScript).toMatch(/AI art 4never\.$/);
  });

  it('voiceover script: single-post wording', () => {
    const plan = planRecap(
      [{ id: '1', date: '2026-04-25T12:00:00Z', caption: '#cyberpunk' }],
      { now: FIXED_NOW },
    );
    expect(plan.voiceoverScript).toMatch(/one piece this week/);
    expect(plan.voiceoverScript).toMatch(/cyberpunk/);
  });

  it('voiceover script: many posts wording with topic arc', () => {
    const plan = planRecap(
      [
        { id: '1', date: '2026-04-25T12:00:00Z', caption: '#cyberpunk' },
        { id: '2', date: '2026-04-24T12:00:00Z', caption: '#noir' },
        { id: '3', date: '2026-04-23T12:00:00Z', caption: '#mecha' },
      ],
      { now: FIXED_NOW },
    );
    expect(plan.voiceoverScript).toMatch(/3 new pieces this week/);
    // Multi-topic branch should string the topics through "and finished strong on".
    expect(plan.voiceoverScript).toMatch(/finished strong on/);
  });

  it('reports the window bounds as ISO strings', () => {
    const plan = planRecap([], { now: FIXED_NOW, windowDays: 7 });
    expect(plan.windowEnd).toBe(FIXED_NOW.toISOString());
    expect(new Date(plan.windowStart).getTime()).toBe(
      FIXED_NOW.getTime() - 7 * 24 * 60 * 60 * 1000,
    );
  });

  it('AVATAR_VOICE_PROFILE points at an expressive narrator voice', () => {
    expect(AVATAR_VOICE_PROFILE.voice).toBe('English_expressive_narrator');
  });
});

// ----- executeRecap (uses spawn DI seam) -----------------------------------

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

beforeEach(() => {
  spawnMock.mockReset();
  __setSpawnForTests(spawnMock as never);
});
afterEach(() => {
  __setSpawnForTests(null);
});

describe('executeRecap', () => {
  it('runs all three generations in parallel and surfaces handles', async () => {
    let n = 0;
    spawnMock.mockImplementation(() => {
      n += 1;
      // Order is non-deterministic across Promise.allSettled, but each
      // invocation is independent — use the first arg slot's command to
      // pick the response. We can't peek here easily; canned responses
      // for each are returned sequentially and tests just assert the
      // RecapArtifacts shape.
      const fixtures = [
        JSON.stringify({ task_id: 'video-task-1' }),
        JSON.stringify({ output_file: '/tmp/m.mp3' }),
        JSON.stringify({ output_file: '/tmp/v.mp3' }),
      ];
      return makeChild(fixtures[n - 1] ?? fixtures[0], 0) as never;
    });

    const plan = planRecap(
      [{ id: '1', date: FIXED_NOW.toISOString(), caption: '#cyberpunk' }],
      { now: FIXED_NOW },
    );
    const artifacts = await executeRecap(plan, { outDir: '/tmp' });

    expect(artifacts.errors).toEqual([]);
    expect(spawnMock).toHaveBeenCalledTimes(3);
    // Three results landed on the artifacts object — exact field-to-call
    // mapping depends on settle order; we just verify everything was
    // captured.
    const captured = [artifacts.videoTaskId, artifacts.musicPath, artifacts.voiceoverPath]
      .filter(Boolean).length;
    expect(captured).toBe(3);
  });

  it('one stage failing does not block the others', async () => {
    let n = 0;
    spawnMock.mockImplementation(() => {
      n += 1;
      // Force one of the three to error out via JSON error response.
      if (n === 2) {
        return makeChild(
          JSON.stringify({ error: { code: 401, message: 'unauthorized' } }),
          0,
        ) as never;
      }
      return makeChild(JSON.stringify({ task_id: 't', output_file: '/tmp/x' }), 0) as never;
    });

    const plan = planRecap([], { now: FIXED_NOW });
    const artifacts = await executeRecap(plan, { outDir: '/tmp' });
    expect(artifacts.errors).toHaveLength(1);
    // The two surviving stages still produced output.
    const survived = [artifacts.videoTaskId, artifacts.musicPath, artifacts.voiceoverPath]
      .filter(Boolean).length;
    expect(survived).toBeGreaterThanOrEqual(2);
  });
});
