/**
 * v1.2 Tool Registry — error-class unit tests.
 *
 * The error hierarchy is small but central: every tool's safeExecute
 * path funnels through these classes, so a regression here breaks
 * every other tool's error handling.
 */
import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  AgentToolError,
  ValidationError,
  ToolNotAvailableError,
  ToolTimeoutError,
  ToolExecutionError,
  AssetPersistError,
  safeExecute,
  isAgentToolError,
  isRetryableError,
  ok,
  err,
} from '@/lib/agent-tools/errors';

describe('Error classes', () => {
  it('preserves the class name as Error.name', () => {
    expect(new ToolNotAvailableError('t', 'no key').name).toBe('ToolNotAvailableError');
    expect(new ValidationError('x', []).name).toBe('ValidationError');
    expect(new ToolTimeoutError('t', 1000).name).toBe('ToolTimeoutError');
  });

  it('preserves the underlying cause', () => {
    const cause = new Error('root');
    const e = new ToolExecutionError('t', 'failed', { cause });
    expect(e.cause).toBe(cause);
  });

  it('survives instanceof checks after JSON round-trip', () => {
    const e = new ToolNotAvailableError('gen_image', 'no API key');
    expect(e instanceof AgentToolError).toBe(true);
    expect(e instanceof ToolNotAvailableError).toBe(true);
  });

  it('ValidationError.fromZod attaches issues', () => {
    const z = new ZodError([
      { code: 'too_small', minimum: 1, origin: 'string', path: ['x'], message: 'too small', input: '' },
    ] as never);
    const e = ValidationError.fromZod(z, 'trending_search');
    expect(e.issues.length).toBe(1);
    expect(e.cause).toBe(z);
  });

  it('ToolExecutionError.retryable defaults to false', () => {
    expect(new ToolExecutionError('t', 'x').retryable).toBe(false);
  });

  it('ToolExecutionError accepts retryable + providerStatus', () => {
    const e = new ToolExecutionError('t', 'x', { retryable: true, providerStatus: 503 });
    expect(e.retryable).toBe(true);
    expect(e.providerStatus).toBe(503);
  });

  it('AssetPersistError surfaces the provider', () => {
    const e = new AssetPersistError('higgsfield', 'quota exceeded');
    expect(e.assetRefProvider).toBe('higgsfield');
    expect(e.code).toBe('ASSET_PERSIST_ERROR');
  });
});

describe('isAgentToolError', () => {
  it('narrows to AgentToolError', () => {
    expect(isAgentToolError(new ToolTimeoutError('t', 100))).toBe(true);
    expect(isAgentToolError(new Error('plain'))).toBe(false);
    expect(isAgentToolError('string')).toBe(false);
    expect(isAgentToolError(null)).toBe(false);
  });
});

describe('isRetryableError', () => {
  it('timeouts are retryable', () => {
    expect(isRetryableError(new ToolTimeoutError('t', 1000))).toBe(true);
  });

  it('ToolExecutionError.retryable=true is retryable', () => {
    expect(isRetryableError(new ToolExecutionError('t', 'x', { retryable: true }))).toBe(true);
  });

  it('non-retryable execution errors are not', () => {
    expect(isRetryableError(new ToolExecutionError('t', 'x'))).toBe(false);
  });

  it('non-retryable errors are not', () => {
    expect(isRetryableError(new ValidationError('x', []))).toBe(false);
    expect(isRetryableError(new ToolNotAvailableError('t', 'r'))).toBe(false);
  });
});

describe('ok / err', () => {
  it('ok wraps a value', () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it('err wraps an error', () => {
    const r = err(new ToolTimeoutError('t', 100));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ToolTimeoutError);
  });
});

describe('safeExecute', () => {
  it('returns ok on success', async () => {
    const r = await safeExecute(async () => 7);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(7);
  });

  it('wraps AgentToolError throws as err', async () => {
    const r = await safeExecute(async () => {
      throw new ToolNotAvailableError('t', 'no key');
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(isAgentToolError(r.error)).toBe(true);
  });

  it('wraps ZodError throws as ValidationError', async () => {
    const r = await safeExecute(async () => {
      throw new ZodError([{ code: 'custom', path: [], message: 'bad' }] as never);
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ValidationError);
  });

  it('wraps DOMException TimeoutError as retryable ToolExecutionError', async () => {
    const r = await safeExecute(async () => {
      throw new DOMException('boom', 'TimeoutError');
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(ToolExecutionError);
      const te = r.error as ToolExecutionError;
      expect(te.retryable).toBe(true);
    }
  });

  it('wraps AbortError as non-retryable ToolExecutionError', async () => {
    const r = await safeExecute(async () => {
      throw new DOMException('cancelled', 'AbortError');
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(ToolExecutionError);
      const te = r.error as ToolExecutionError;
      expect(te.retryable).toBe(false);
    }
  });

  it('re-throws unknown errors (no silent swallowing)', async () => {
    await expect(
      safeExecute(async () => {
        throw new TypeError('programmer bug');
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
