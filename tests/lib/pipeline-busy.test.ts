// SHOULDFIX-001: pipeline-busy is module-level state, so tests must reset
// the flag between cases. setPipelineBusy(false) at the top of each `it`
// keeps the singleton tidy.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setPipelineBusy,
  isPipelineBusy,
  subscribePipelineBusy,
} from '@/lib/pipeline-busy';

describe('pipeline-busy pub/sub', () => {
  beforeEach(() => {
    // Drain any state from previous tests. setPipelineBusy is idempotent,
    // so calling false twice is safe if we were already idle.
    setPipelineBusy(false);
  });

  it('isPipelineBusy returns current flag', () => {
    expect(isPipelineBusy()).toBe(false);
    setPipelineBusy(true);
    expect(isPipelineBusy()).toBe(true);
  });

  it('subscribePipelineBusy fires listener on state change', () => {
    const listener = vi.fn();
    subscribePipelineBusy(listener);
    setPipelineBusy(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(true);
  });

  it('setPipelineBusy is idempotent — no fire if value unchanged', () => {
    const listener = vi.fn();
    subscribePipelineBusy(listener);
    setPipelineBusy(false); // already false
    expect(listener).not.toHaveBeenCalled();
    setPipelineBusy(true);
    setPipelineBusy(true); // already true
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe returned from subscribe stops delivery', () => {
    const listener = vi.fn();
    const unsub = subscribePipelineBusy(listener);
    setPipelineBusy(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    setPipelineBusy(false);
    setPipelineBusy(true);
    // Still only the one pre-unsubscribe call.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('multiple subscribers all receive the same event', () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    subscribePipelineBusy(a);
    subscribePipelineBusy(b);
    subscribePipelineBusy(c);
    setPipelineBusy(true);
    expect(a).toHaveBeenCalledWith(true);
    expect(b).toHaveBeenCalledWith(true);
    expect(c).toHaveBeenCalledWith(true);
  });

  it('a listener throwing does not break other listeners', () => {
    const throwing = vi.fn(() => { throw new Error('boom'); });
    const healthy = vi.fn();
    subscribePipelineBusy(throwing);
    subscribePipelineBusy(healthy);
    expect(() => setPipelineBusy(true)).not.toThrow();
    // Healthy listener still fires despite the sibling throw.
    expect(healthy).toHaveBeenCalledWith(true);
  });

  it('unsubscribing one listener does not affect others', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribePipelineBusy(a);
    subscribePipelineBusy(b);
    unsubA();
    setPipelineBusy(true);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith(true);
  });
});
