/**
 * POST /api/cron/sunday-recap
 *
 * Hit by .github/workflows/sunday-recap.yml every Sunday at 10:00 UTC.
 *
 * Body shape:
 *   {
 *     "posts": RecapPost[],     // last 7 days of posts; route filters on date
 *     "now":   "ISO string"     // optional override for testing / catch-up runs
 *   }
 *
 * Auth: Bearer <CRON_SHARED_SECRET>, constant-time compared. Same env
 * var as /api/social/cron-fire so deployments don't sprout per-cron
 * secrets. Without the env var configured the route returns 503.
 *
 * Response: a RecapPlan (text) plus RecapArtifacts (paths/task IDs). The
 * route does NOT yet combine artifacts into a single clip or post to
 * social — those need an ffmpeg pipeline and are deliberately deferred.
 */

import { NextResponse } from 'next/server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { isAvailable } from '@/lib/mmx-client';
import {
  planRecap,
  executeRecap,
  type RecapPost,
} from '@/lib/sunday-recap';

function safeEqual(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function checkAuth(req: Request): { ok: true } | { ok: false; res: Response } {
  const expected = process.env.CRON_SHARED_SECRET;
  if (!expected) {
    return {
      ok: false,
      res: NextResponse.json(
        { error: 'CRON_SHARED_SECRET not configured on server' },
        { status: 503 },
      ),
    };
  }
  const header = req.headers.get('authorization') || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!presented || !safeEqual(presented, expected)) {
    return {
      ok: false,
      res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }
  return { ok: true };
}

interface RecapBody {
  posts?: unknown;
  now?: unknown;
  windowDays?: unknown;
}

function isRecapPost(value: unknown): value is RecapPost {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.date === 'string' &&
    typeof v.caption === 'string'
  );
}

export async function POST(req: Request): Promise<Response> {
  const auth = checkAuth(req);
  if (!auth.ok) return auth.res;

  let body: RecapBody;
  try {
    body = (await req.json()) as RecapBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const posts: RecapPost[] = Array.isArray(body.posts) ? body.posts.filter(isRecapPost) : [];
  const now = typeof body.now === 'string' ? new Date(body.now) : new Date();
  const windowDays =
    typeof body.windowDays === 'number' && body.windowDays > 0 ? body.windowDays : undefined;

  const plan = planRecap(posts, { now, windowDays });

  if (!(await isAvailable())) {
    // mmx is not installed on this runtime (e.g., Vercel serverless). The
    // plan is still useful — return it as a successful but degraded
    // response so the cron workflow doesn't alarm. Artifact generation
    // happens elsewhere (local runner / future background job).
    return NextResponse.json({
      plan,
      artifacts: null,
      degraded: true,
      message: 'MMX CLI not available on this runtime — plan returned, artifact generation skipped.',
    });
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'mashupforge-recap-'));
  try {
    const artifacts = await executeRecap(plan, {
      outDir: tempDir,
      signal: req.signal,
    });
    // QA-W2: artifacts.musicPath / voiceoverPath / videoPath are
    // RUNNER-LOCAL paths under `tempDir`. The `finally` block below
    // rmSyncs `tempDir` after this response is serialised, so by the
    // time a caller receives the JSON the files are already deleted.
    // The fields are kept in the response for workflow-log breadcrumbs
    // (handy when a stage fails partway through) — they are NOT
    // persistent URLs and callers must not try to fetch them. A future
    // commit will upload artifacts to durable storage and replace these
    // paths with hosted URLs before unlink.
    return NextResponse.json({ plan, artifacts });
  } catch (e) {
    return NextResponse.json(
      {
        plan,
        artifacts: null,
        error: e instanceof Error ? e.message : 'Recap execution failed',
      },
      { status: 500 },
    );
  } finally {
    // We intentionally rm the temp dir even on success: the artifacts
    // referenced by `artifacts.musicPath` etc. are local-to-runner. A
    // future commit will upload them somewhere persistent and combine
    // before unlink. For now the response carries enough info for a
    // workflow log to surface what was generated.
    rmSync(tempDir, { recursive: true, force: true });
  }
}
