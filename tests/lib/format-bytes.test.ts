// V083-UPDATE-UI — pins the formatBytes helper that powers the
// "Downloaded X / Total Y" readout in the update toast.

import { describe, it, expect } from 'vitest';
import { formatBytes } from '@/components/UpdateChecker';

describe('formatBytes', () => {
  it('shows bytes under 1 KiB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('shows KB with one decimal under 1 MiB', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('shows MB with one decimal under 1 GiB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(5 * 1024 * 1024 + 512 * 1024)).toBe('5.5 MB');
  });

  it('shows GB with two decimals at and beyond 1 GiB', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.50 GB');
  });

  it('returns 0 B for negative or non-finite inputs', () => {
    expect(formatBytes(-10)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});
