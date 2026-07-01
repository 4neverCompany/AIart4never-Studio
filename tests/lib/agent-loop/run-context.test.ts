/**
 * Story 10.6 — RunContext concurrency guard rail.
 *
 * The request-scoped `_current` singleton must hold at most ONE active run per
 * worker (AD-4). `enterRunContext` now FAILS LOUD on overlap instead of silently
 * overwriting run-scoped state (which would bleed one run's budget / character /
 * connector / approval into another). These tests pin: overlap → throw (AC1),
 * sequential enter-after-exit → succeeds (AC3), and the test seam bypasses the
 * guard (AC4).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  enterRunContext,
  exitRunContext,
  currentRunContext,
  __setCurrentRunContextForTests,
  type RunContext,
} from '@/lib/agent-loop/run-context';

function ctx(runId: string): RunContext {
  return { runId, stepCounter: 0, totalCostUsd: 0, budgetUsd: 0 };
}

afterEach(() => {
  // Never leak an active context between tests (the guard would cascade).
  __setCurrentRunContextForTests(null);
});

describe('RunContext concurrency guard (Story 10.6)', () => {
  it('enterRunContext sets the active context; currentRunContext returns it', () => {
    expect(currentRunContext()).toBeNull();
    enterRunContext(ctx('run_a'));
    expect(currentRunContext()?.runId).toBe('run_a');
  });

  it('AC1: a second enterRunContext before exit THROWS a clear error naming both runs', () => {
    enterRunContext(ctx('run_a'));
    expect(() => enterRunContext(ctx('run_b'))).toThrow(/concurrency violation/i);
    // The clear error mentions both the existing and the incoming run ids.
    try {
      enterRunContext(ctx('run_b'));
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as Error).message).toContain('run_a');
      expect((e as Error).message).toContain('run_b');
    }
    // The active context is UNCHANGED (not silently overwritten).
    expect(currentRunContext()?.runId).toBe('run_a');
  });

  it('AC3: sequential enter → exit → enter succeeds (no false-positive)', () => {
    enterRunContext(ctx('run_a'));
    exitRunContext();
    expect(currentRunContext()).toBeNull();
    // A fresh run enters cleanly after the previous one disposed.
    expect(() => enterRunContext(ctx('run_b'))).not.toThrow();
    expect(currentRunContext()?.runId).toBe('run_b');
  });

  it('exitRunContext clears the singleton to null', () => {
    enterRunContext(ctx('run_a'));
    exitRunContext();
    expect(currentRunContext()).toBeNull();
    // exitRunContext is idempotent / safe when nothing is active.
    expect(() => exitRunContext()).not.toThrow();
    expect(currentRunContext()).toBeNull();
  });

  it('AC4: __setCurrentRunContextForTests bypasses the guard (force-set even when active)', () => {
    enterRunContext(ctx('run_a'));
    // The test seam can overwrite an active context without throwing.
    expect(() => __setCurrentRunContextForTests(ctx('run_forced'))).not.toThrow();
    expect(currentRunContext()?.runId).toBe('run_forced');
  });
});
