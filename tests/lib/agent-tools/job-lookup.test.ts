/**
 * Tests for lib/agent-tools/job-lookup.ts
 *
 * Coverage:
 *   - action=get returns a single job record
 *   - action=list returns an array of job records
 *   - action=get requires jobId
 *   - CLI not on PATH → ToolNotAvailableError
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as cliUtils from '@/lib/providers/cli-utils';
import { __setSpawnForTests } from '@/lib/providers/cli-utils';
import { __resetRegistry, __registerProvider } from '@/lib/providers/registry';
import { HiggsfieldCliAdapter } from '@/lib/providers/higgsfield/cli-adapter';
import {
  executeJobLookup,
  zJobLookupInput,
  jobLookupTool,
} from '@/lib/agent-tools/job-lookup';
import { ToolNotAvailableError } from '@/lib/agent-tools/errors';

const spawnMock = vi.fn();

beforeEach(() => {
  __setSpawnForTests(spawnMock as never);
  spawnMock.mockReset();
});

afterEach(() => {
  __setSpawnForTests(null);
  __resetRegistry();
});

describe('job_lookup — schema validation', () => {
  it('accepts action=get with a jobId', () => {
    const r = zJobLookupInput.safeParse({ action: 'get', jobId: 'abc-123' });
    expect(r.success).toBe(true);
  });

  it('accepts action=list with a mediaType filter and size', () => {
    const r = zJobLookupInput.safeParse({ action: 'list', mediaType: 'video', size: 10 });
    expect(r.success).toBe(true);
  });

  it('rejects an invalid action', () => {
    const r = zJobLookupInput.safeParse({ action: 'delete' });
    expect(r.success).toBe(false);
  });

  it('rejects an invalid mediaType', () => {
    const r = zJobLookupInput.safeParse({ action: 'list', mediaType: 'audio' });
    expect(r.success).toBe(false);
  });
});

describe('job_lookup — happy paths', () => {
  it('returns one job on action=get', async () => {
    const cli = new HiggsfieldCliAdapter();
    (cli as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolvedBinary = 'higgsfield';
    (cli as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolveAttempted = true;
    __registerProvider('higgsfield', cli);

    const spy = vi.spyOn(cliUtils, 'cliInvoke').mockResolvedValueOnce({
      parsed: {
        id: 'abc-123',
        status: 'completed',
        result_url: 'https://cdn.x/img.png',
      },
      stdout: '{}',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
    } as never);

    const result = await executeJobLookup({ action: 'get', jobId: 'abc-123' });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.action === 'get') {
      expect(result.value.job.id).toBe('abc-123');
      expect(result.value.job.status).toBe('completed');
      expect(result.value.job.result_url).toBe('https://cdn.x/img.png');
    }
    // Verify argv
    const callArgs = spy.mock.calls[0][0] as { args: string[] };
    expect(callArgs.args[0]).toBe('generate');
    expect(callArgs.args[1]).toBe('get');
    expect(callArgs.args[2]).toBe('abc-123');
    expect(callArgs.args[3]).toBe('--json');
    spy.mockRestore();
  });

  it('returns an array on action=list with --image filter', async () => {
    const cli = new HiggsfieldCliAdapter();
    (cli as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolvedBinary = 'higgsfield';
    (cli as unknown as { resolvedBinary: string; resolveAttempted: boolean }).resolveAttempted = true;
    __registerProvider('higgsfield', cli);

    const spy = vi.spyOn(cliUtils, 'cliInvoke').mockResolvedValueOnce({
      parsed: [
        { id: 'a', status: 'completed', job_set_type: 'nano_banana_2' },
        { id: 'b', status: 'in_progress', job_set_type: 'nano_banana_2' },
      ],
      stdout: '{}',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
    } as never);

    const result = await executeJobLookup({ action: 'list', mediaType: 'image', size: 5 });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.action === 'list') {
      expect(result.value.count).toBe(2);
      expect(result.value.jobs).toHaveLength(2);
    }
    const callArgs = spy.mock.calls[0][0] as { args: string[] };
    expect(callArgs.args).toContain('--image');
    expect(callArgs.args).toContain('--size');
    expect(callArgs.args).toContain('5');
    spy.mockRestore();
  });
});

describe('job_lookup — error paths', () => {
  it('returns an error when action=get has no jobId', async () => {
    const result = await executeJobLookup({ action: 'get' });
    expect(result.ok).toBe(false);
  });

  it('returns ToolNotAvailableError when the CLI is not on PATH', async () => {
    const cli = new HiggsfieldCliAdapter();
    (cli as unknown as { resolvedBinary: string | null }).resolvedBinary = null;
    (cli as unknown as { resolveAttempted: boolean }).resolveAttempted = true;
    __registerProvider('higgsfield', cli);

    const result = await executeJobLookup({ action: 'list' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ToolNotAvailableError);
    }
  });
});

describe('job_lookup tool — AI SDK registration', () => {
  it('is exported with a non-empty description', () => {
    expect(jobLookupTool).toBeDefined();
    const desc = (jobLookupTool as unknown as { description: string }).description;
    expect(desc.length).toBeGreaterThan(40);
  });

  it('has inputSchema and outputSchema', () => {
    const t = jobLookupTool as unknown as { inputSchema: unknown; outputSchema: unknown };
    expect(t.inputSchema).toBeDefined();
    expect(t.outputSchema).toBeDefined();
  });
});
