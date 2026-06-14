import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { isAllowedUrl, getCacheEntry, getStaleEntry, setCacheEntry, clearCache, getCacheSize } from '@/app/api/proxy-image/route';

describe('proxy-image isAllowedUrl', () => {
  it('allows cdn.leonardo.ai', () => {
    expect(isAllowedUrl('https://cdn.leonardo.ai/users/abc/generations/x.png')).toBe(true);
  });

  it('allows i.uguu.se', () => {
    expect(isAllowedUrl('https://i.uguu.se/AbCdEfG.png')).toBe(true);
  });

  it('allows storage.googleapis.com subdomains', () => {
    expect(isAllowedUrl('https://leonardo-bucket.storage.googleapis.com/file.png')).toBe(true);
  });

  it('rejects http (downgrade attack vector)', () => {
    expect(isAllowedUrl('http://cdn.leonardo.ai/x.png')).toBe(false);
  });

  it('rejects file:// protocol', () => {
    expect(isAllowedUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects gopher:// protocol', () => {
    expect(isAllowedUrl('gopher://internal.local/x')).toBe(false);
  });

  it('rejects arbitrary external hosts', () => {
    expect(isAllowedUrl('https://evil.example.com/x.png')).toBe(false);
  });

  it('rejects localhost', () => {
    expect(isAllowedUrl('https://localhost/admin')).toBe(false);
  });

  it('rejects 127.0.0.1', () => {
    expect(isAllowedUrl('https://127.0.0.1/internal')).toBe(false);
  });

  it('rejects host suffix lookalike (e.g. cdn.leonardo.ai.evil.com)', () => {
    expect(isAllowedUrl('https://cdn.leonardo.ai.evil.com/x.png')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isAllowedUrl('')).toBe(false);
  });

  it('rejects malformed URL', () => {
    expect(isAllowedUrl('not a url at all')).toBe(false);
  });

  it('treats hostname case-insensitively', () => {
    expect(isAllowedUrl('https://CDN.LEONARDO.AI/x.png')).toBe(true);
  });

  it('rejects bare suffix without leading dot (storage.googleapis.com itself)', () => {
    // The suffix list is .storage.googleapis.com so a host of exactly
    // "storage.googleapis.com" should NOT match — it would need a
    // subdomain, which is the actual deployment shape.
    expect(isAllowedUrl('https://storage.googleapis.com/x.png')).toBe(false);
  });
});

describe('proxy-image LRU cache', () => {
  const buf = new ArrayBuffer(8);
  const url = 'https://cdn.leonardo.ai/test.png';

  beforeEach(() => clearCache());
  afterEach(() => vi.useRealTimers());

  it('returns undefined for a cold cache', () => {
    expect(getCacheEntry(url)).toBeUndefined();
  });

  it('returns the entry after a set', () => {
    setCacheEntry(url, buf, 'image/png');
    const entry = getCacheEntry(url);
    expect(entry?.contentType).toBe('image/png');
    expect(entry?.buffer).toBe(buf);
  });

  it('increments cache size', () => {
    setCacheEntry(url, buf, 'image/png');
    expect(getCacheSize()).toBe(1);
  });

  it('does not cache buffers over 10 MB', () => {
    const big = new ArrayBuffer(11 * 1024 * 1024);
    setCacheEntry(url, big, 'image/png');
    expect(getCacheEntry(url)).toBeUndefined();
    expect(getCacheSize()).toBe(0);
  });

  it('returns undefined from getCacheEntry after fresh TTL expires', () => {
    vi.useFakeTimers();
    setCacheEntry(url, buf, 'image/png');
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(getCacheEntry(url)).toBeUndefined();
  });

  it('entry is still valid just before TTL expires', () => {
    vi.useFakeTimers();
    setCacheEntry(url, buf, 'image/png');
    vi.advanceTimersByTime(60 * 60 * 1000 - 1);
    expect(getCacheEntry(url)).toBeDefined();
  });

  it('evicts the oldest entry when cap is reached', () => {
    const first = 'https://cdn.leonardo.ai/first.png';
    setCacheEntry(first, buf, 'image/png');
    for (let i = 0; i < 100; i++) {
      setCacheEntry(`https://cdn.leonardo.ai/img-${i}.png`, buf, 'image/png');
    }
    expect(getCacheEntry(first)).toBeUndefined();
  });

  it('clearCache empties all entries', () => {
    setCacheEntry(url, buf, 'image/png');
    clearCache();
    expect(getCacheSize()).toBe(0);
    expect(getCacheEntry(url)).toBeUndefined();
  });
});

describe('proxy-image stale-while-error', () => {
  const buf = new ArrayBuffer(8);
  const url = 'https://cdn.leonardo.ai/stale.png';

  beforeEach(() => clearCache());
  afterEach(() => vi.useRealTimers());

  it('getStaleEntry returns a fresh entry', () => {
    setCacheEntry(url, buf, 'image/png');
    expect(getStaleEntry(url)?.contentType).toBe('image/png');
  });

  it('getStaleEntry returns the entry past fresh TTL but within stale window', () => {
    vi.useFakeTimers();
    setCacheEntry(url, buf, 'image/png');
    vi.advanceTimersByTime(2 * 60 * 60 * 1000); // 2 hours: stale, but well within 7d
    expect(getCacheEntry(url)).toBeUndefined();
    expect(getStaleEntry(url)?.contentType).toBe('image/png');
  });

  it('getStaleEntry returns undefined past max stale window and evicts', () => {
    vi.useFakeTimers();
    setCacheEntry(url, buf, 'image/png');
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000 + 1); // > 7 days
    expect(getStaleEntry(url)).toBeUndefined();
    expect(getCacheSize()).toBe(0);
  });

  it('stale entry persists in cache across the fresh→stale boundary', () => {
    vi.useFakeTimers();
    setCacheEntry(url, buf, 'image/png');
    vi.advanceTimersByTime(60 * 60 * 1000 + 1); // just past fresh TTL
    // getCacheEntry must NOT delete a still-usable stale entry
    expect(getCacheEntry(url)).toBeUndefined();
    expect(getCacheSize()).toBe(1);
    expect(getStaleEntry(url)).toBeDefined();
  });
});
