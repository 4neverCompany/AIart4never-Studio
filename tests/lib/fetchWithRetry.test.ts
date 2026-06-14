import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithRetry, fetchApi } from '@/lib/fetchWithRetry';

function mockResponse(status: number): Response {
  return new Response('body', { status });
}

describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns immediately on a 200 response without retrying', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200));
    const promise = fetchWithRetry('https://example.test/x');
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns 4xx responses without retrying', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(400));
    const promise = fetchWithRetry('https://example.test/x');
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries on 500 then succeeds', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockResponse(500))
      .mockResolvedValueOnce(mockResponse(200));
    const promise = fetchWithRetry('https://example.test/x');
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns the last response after exhausting attempts on persistent 500', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(503));
    const promise = fetchWithRetry('https://example.test/x', undefined, { attempts: 3 });
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(503);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('retries on network error then succeeds', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(mockResponse(200));
    const promise = fetchWithRetry('https://example.test/x');
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws the network error after exhausting attempts', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection refused'));
    const promise = fetchWithRetry('https://example.test/x', undefined, { attempts: 2 });
    const assertion = expect(promise).rejects.toThrow('connection refused');
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('respects custom attempts: 1 means no retry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(500));
    const promise = fetchWithRetry('https://example.test/x', undefined, { attempts: 1 });
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(500);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('fetchApi (Result-returning)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns ok with the response on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200));
    const promise = fetchApi('leonardo', 'https://example.test/x');
    await vi.runAllTimersAsync();
    const r = await promise;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.status).toBe(200);
  });

  it('uses the per-API budget by default (leonardo: 3 on 503)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(503));
    const promise = fetchApi('leonardo', 'https://example.test/x');
    await vi.runAllTimersAsync();
    const r = await promise;
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('budget_exhausted');
      expect(r.error.source).toBe('leonardo');
    }
  });

  it('uses the per-API budget by default (leonardo: 3 on 503)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(503));
    // M3.3-P3 commit c: 'pi' source is gone. Leonardo has budget=3.
    const promise = fetchApi('leonardo', 'https://example.test/x');
    await vi.runAllTimersAsync();
    await promise;
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('uses the per-API budget by default (social: 1 — no retry on 503)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(503));
    const promise = fetchApi('social', 'https://example.test/x');
    await vi.runAllTimersAsync();
    const r = await promise;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Single attempt, retryable status, budget=1 → exhausted on first try
      expect(r.error.code).toBe('budget_exhausted');
    }
  });

  it('does NOT retry 401 (auth) — returns Response in ok branch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(401));
    const promise = fetchApi('social', 'https://example.test/x');
    await vi.runAllTimersAsync();
    const r = await promise;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.status).toBe(401);
  });

  it('retries on 429 (rate_limit) within budget', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockResponse(429))
      .mockResolvedValueOnce(mockResponse(200));
    const promise = fetchApi('leonardo', 'https://example.test/x');
    await vi.runAllTimersAsync();
    const r = await promise;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(true);
  });

  it('retries on network error then surfaces budget_exhausted', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('ECONNRESET'));
    // M3.3-P3 commit c: 'pi' source gone. Leonardo has budget=3.
    const promise = fetchApi('leonardo', 'https://example.test/x');
    await vi.runAllTimersAsync();
    const r = await promise;
    expect(fetchSpy).toHaveBeenCalledTimes(3); // leonardo budget = 3
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('budget_exhausted');
      expect((r.error.cause as { code?: string }).code).toBe('network');
    }
  });

  it('honors a caller-provided attempts override', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(503));
    const promise = fetchApi('leonardo', 'https://example.test/x', undefined, { attempts: 1 });
    await vi.runAllTimersAsync();
    await promise;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
