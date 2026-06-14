import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isServerless } from '@/lib/runtime-env';

// Regression gate for the serverless-platform detector. Every API
// route that spawns a child process (pi, tmux, etc.) uses this as a
// defense-in-depth guard before touching the filesystem / process
// table. Dropping a platform flag here would silently re-enable
// subprocess spawning on whatever cloud we'd forgotten about, which
// on Vercel / Lambda just means every request dies with EACCES or
// ENOSPC deep inside the spawn call.

const PLATFORM_VARS = [
  'VERCEL',
  'AWS_LAMBDA_FUNCTION_NAME',
  'NETLIFY',
  'CF_PAGES',
] as const;

describe('isServerless', () => {
  const saved: Partial<Record<(typeof PLATFORM_VARS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of PLATFORM_VARS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of PLATFORM_VARS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it('returns false when no platform flag is set (desktop / local dev)', () => {
    expect(isServerless()).toBe(false);
  });

  it.each(PLATFORM_VARS)('returns true when %s is set', (flag) => {
    process.env[flag] = '1';
    expect(isServerless()).toBe(true);
  });

  it('returns false when a platform flag is set to empty string', () => {
    // Boolean('') === false — empty env shouldn't trip the guard.
    process.env.VERCEL = '';
    expect(isServerless()).toBe(false);
  });

  it('returns true when multiple flags are set', () => {
    process.env.VERCEL = '1';
    process.env.NETLIFY = '1';
    expect(isServerless()).toBe(true);
  });
});
