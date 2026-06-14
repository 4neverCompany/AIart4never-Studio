import { describe, it, expect } from 'vitest';
import {
  classifyHttpStatus,
  httpApiError,
  networkApiError,
  budgetExhaustedError,
  toastMessageForApiError,
  RETRY_BUDGET,
} from '@/lib/api-error';

describe('classifyHttpStatus', () => {
  it('marks 429 as retryable rate_limit', () => {
    expect(classifyHttpStatus(429)).toEqual({ retryable: true, code: 'rate_limit' });
  });

  it('marks 401/403 as non-retryable auth', () => {
    expect(classifyHttpStatus(401)).toEqual({ retryable: false, code: 'auth' });
    expect(classifyHttpStatus(403)).toEqual({ retryable: false, code: 'auth' });
  });

  it('marks 5xx as retryable http', () => {
    expect(classifyHttpStatus(500).retryable).toBe(true);
    expect(classifyHttpStatus(503).retryable).toBe(true);
  });

  it('marks other 4xx as non-retryable http', () => {
    expect(classifyHttpStatus(400)).toEqual({ retryable: false, code: 'http' });
    expect(classifyHttpStatus(404)).toEqual({ retryable: false, code: 'http' });
  });

  it('marks 2xx/3xx as non-retryable (caller already has the response)', () => {
    expect(classifyHttpStatus(200).retryable).toBe(false);
  });
});

describe('error builders', () => {
  it('httpApiError carries status and source', () => {
    const e = httpApiError('leonardo', 503);
    expect(e.source).toBe('leonardo');
    expect(e.status).toBe(503);
    expect(e.retryable).toBe(true);
    expect(e.code).toBe('http');
  });

  it('httpApiError with 429 is rate_limit', () => {
    // M3.3-P3 commit c: 'pi' source is gone; 'leonardo' is the
    // closest remaining example (Leonardo is the only HTTP API
    // that historically took the retry-budget path).
    expect(httpApiError('leonardo', 429).code).toBe('rate_limit');
  });

  it('networkApiError is always retryable', () => {
    const e = networkApiError('leonardo', new Error('ECONNRESET'));
    expect(e.retryable).toBe(true);
    expect(e.code).toBe('network');
    expect(e.message).toContain('ECONNRESET');
  });

  it('budgetExhaustedError wraps last error and is fatal', () => {
    const last = httpApiError('leonardo', 500);
    const e = budgetExhaustedError('leonardo', 3, last);
    expect(e.retryable).toBe(false);
    expect(e.code).toBe('budget_exhausted');
    expect(e.cause).toBe(last);
    expect(e.message).toContain('3 attempts');
  });
});

describe('RETRY_BUDGET', () => {
  it('matches the spec: leonardo 3, social 1 (pi retired in M3.3-P3 commit c)', () => {
    expect(RETRY_BUDGET.leonardo).toBe(3);
    expect(RETRY_BUDGET.social).toBe(1);
  });
});

describe('toastMessageForApiError', () => {
  it('auth error prompts user to update credentials', () => {
    const msg = toastMessageForApiError(httpApiError('social', 401));
    expect(msg).toMatch(/credentials/i);
    expect(msg).toMatch(/Settings/);
  });

  it('rate_limit asks user to wait', () => {
    const msg = toastMessageForApiError(httpApiError('leonardo', 429));
    expect(msg).toMatch(/rate-limited|wait/i);
  });

  it('network error references connection', () => {
    // M3.3-P3 commit c: 'pi' source gone; use 'leonardo'.
    const msg = toastMessageForApiError(networkApiError('leonardo', new Error('x')));
    expect(msg).toMatch(/connection/i);
  });
});
