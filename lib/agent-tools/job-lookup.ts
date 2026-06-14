/**
 * v1.3 Tool Registry — `job_lookup` tool.
 *
 * Wraps the Higgsfield CLI's `generate get` and `generate list` verbs
 * to surface async job status and history to the user. Today, an
 * async `generate create` returns `{kind: 'job', jobId: '...'}` and
 * the user has no way to see the job's progress or recover the
 * result URL — this tool fills that gap.
 *
 * Two actions:
 *   - `get`  → `higgsfield generate get <job_id> --json` (one job)
 *   - `list` → `higgsfield generate list [--image|--video|--text] --size N --json`
 *
 * The Studio uses `list` to show "Recent generations" and `get` to
 * poll a queued/in-flight job until it lands.
 */

import { tool } from 'ai';
import { z } from 'zod';
import {
  ToolNotAvailableError,
  ToolExecutionError,
  safeExecute,
  type ToolResult,
} from './errors';
import { getProvider } from '@/lib/providers/registry';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const JOB_STATUSES = ['queued', 'in_progress', 'completed', 'failed', 'cancelled', 'unknown'] as const;

export const zJobLookupInput = z.object({
  action: z.enum(['get', 'list']),
  /** For action=get: the job id returned by a previous generate. */
  jobId: z.string().trim().min(1).max(80).optional(),
  /** For action=list: filter by media type. */
  mediaType: z.enum(['image', 'video', 'text']).optional(),
  /** For action=list: page size (default 20, max 100). */
  size: z.number().int().min(1).max(100).default(20),
});
export type JobLookupInput = z.infer<typeof zJobLookupInput>;

const zJobEntry = z.object({
  id: z.string(),
  status: z.enum(JOB_STATUSES).or(z.string()),
  display_name: z.string().optional(),
  job_set_type: z.string().optional(),
  result_url: z.string().url().optional(),
  created_at: z.number().optional(),
  error: z.string().optional(),
}).passthrough();

export const zJobLookupOutput = z.union([
  // action=get
  z.object({
    action: z.literal('get'),
    job: zJobEntry,
  }),
  // action=list
  z.object({
    action: z.literal('list'),
    jobs: z.array(zJobEntry),
    count: z.number().int().min(0),
  }),
]);
export type JobLookupOutput = z.infer<typeof zJobLookupOutput>;

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeJobLookup(
  rawInput: unknown,
  opts: { signal?: AbortSignal } = {},
): Promise<ToolResult<JobLookupOutput>> {
  return safeExecute(async () => {
    const parsed = zJobLookupInput.safeParse(rawInput);
    if (!parsed.success) throw parsed.error;
    const input = parsed.data;

    if (input.action === 'get' && !input.jobId) {
      throw new ToolExecutionError(
        'job_lookup',
        'action="get" requires a jobId',
        { retryable: false },
      );
    }

    let adapter;
    try {
      adapter = getProvider('higgsfield');
    } catch {
      throw new ToolNotAvailableError(
        'job_lookup',
        'provider "higgsfield" is not registered — check lib/providers/registry.ts',
      );
    }

    const available = await adapter.isAvailable();
    if (!available) {
      throw new ToolNotAvailableError(
        'job_lookup',
        'Higgsfield CLI is not available on PATH (higgsfield or higgs binary missing)',
      );
    }

    // Delegate to the adapter's getJobStatus / listJobs methods.
    const adapterAny = adapter as unknown as {
      getJobStatus(jobId: string): Promise<unknown>;
      listJobs(opts: { mediaType?: 'image' | 'video' | 'text'; size?: number }): Promise<unknown>;
    };

    try {
      if (input.action === 'get') {
        const job = await adapterAny.getJobStatus(input.jobId!);
        return zJobLookupOutput.parse({ action: 'get', job });
      }
      const jobs = await adapterAny.listJobs({
        mediaType: input.mediaType,
        size: input.size,
      });
      const list = Array.isArray(jobs) ? jobs : [];
      return zJobLookupOutput.parse({ action: 'list', jobs: list, count: list.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ToolExecutionError('job_lookup', msg, { retryable: true, cause: e });
    }
  });
}

// ---------------------------------------------------------------------------
// Vercel AI SDK `tool()` definition
// ---------------------------------------------------------------------------

export const jobLookupTool = tool({
  description:
    'Look up the status of a Higgsfield generation job. action="get" returns the current state of one job (queued / in_progress / completed / failed + result_url if done). action="list" returns recent jobs filtered by media type (image/video/text). Use after a generate_image / generate_video returns a jobId to poll for completion, or to show a "Recent generations" panel in the Studio.',
  inputSchema: zJobLookupInput,
  outputSchema: zJobLookupOutput,
  execute: async (input, options) => {
    const result = await executeJobLookup(input, {
      signal: options?.abortSignal,
    });
    if (!result.ok) throw result.error;
    return result.value;
  },
});
