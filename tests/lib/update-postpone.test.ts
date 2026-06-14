// SHOULDFIX-001: covers the pure decision logic for UpdateChecker's
// postpone watchdog + an integration-style test that wires the
// pipeline-busy subscription pattern the same way the component does.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PIPELINE_POSTPONE_MAX_MS,
  PIPELINE_POSTPONE_POLL_MS,
  computePostponeDeadline,
  shouldFireInstall,
} from '@/lib/update-postpone';
import {
  setPipelineBusy,
  isPipelineBusy,
  subscribePipelineBusy,
} from '@/lib/pipeline-busy';

describe('update-postpone constants', () => {
  it('PIPELINE_POSTPONE_MAX_MS is 120 minutes', () => {
    expect(PIPELINE_POSTPONE_MAX_MS).toBe(120 * 60 * 1000);
  });

  it('PIPELINE_POSTPONE_POLL_MS is 60 seconds', () => {
    expect(PIPELINE_POSTPONE_POLL_MS).toBe(60 * 1000);
  });
});

describe('computePostponeDeadline', () => {
  it('returns now + 120 minutes', () => {
    const now = 1_700_000_000_000;
    expect(computePostponeDeadline(now)).toBe(now + PIPELINE_POSTPONE_MAX_MS);
  });
});

describe('shouldFireInstall', () => {
  const now = 1_700_000_000_000;
  const deadline = now + PIPELINE_POSTPONE_MAX_MS;

  it('fires immediately when pipeline is idle', () => {
    expect(shouldFireInstall(now, deadline, false)).toBe(true);
  });

  it('waits when busy and before the deadline', () => {
    expect(shouldFireInstall(now, deadline, true)).toBe(false);
  });

  it('fires when the 120-min deadline has elapsed, even if still busy', () => {
    expect(shouldFireInstall(deadline, deadline, true)).toBe(true);
    expect(shouldFireInstall(deadline + 1, deadline, true)).toBe(true);
  });

  it('fires when idle regardless of deadline position', () => {
    expect(shouldFireInstall(now - 1000, deadline, false)).toBe(true);
    expect(shouldFireInstall(deadline + 10_000, deadline, false)).toBe(true);
  });
});

// Integration-style: the watchdog effect in UpdateChecker wires
// subscribePipelineBusy to a tryInstall closure that checks
// shouldFireInstall. This reproduces that wiring without React so
// regressions in either half (pub/sub + decision logic) surface.
describe('postpone watchdog wiring', () => {
  beforeEach(() => { setPipelineBusy(false); });

  it('busy → idle edge fires install once', () => {
    const install = vi.fn();
    setPipelineBusy(true);
    const deadline = computePostponeDeadline(Date.now());
    let fired = false;
    const tryInstall = () => {
      if (fired) return;
      if (shouldFireInstall(Date.now(), deadline, isPipelineBusy())) {
        fired = true;
        install();
      }
    };
    const unsub = subscribePipelineBusy((busy) => { if (!busy) tryInstall(); });
    // Initial check: still busy, deadline not elapsed → no-op.
    tryInstall();
    expect(install).not.toHaveBeenCalled();
    // Pipeline finishes → edge-trigger fires install.
    setPipelineBusy(false);
    expect(install).toHaveBeenCalledTimes(1);
    // Subsequent toggles must not double-fire (fired guard).
    setPipelineBusy(true);
    setPipelineBusy(false);
    expect(install).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('deadline elapses while busy → polling-style check fires install', () => {
    const install = vi.fn();
    setPipelineBusy(true);
    // Fake: deadline is already in the past.
    const deadline = Date.now() - 1;
    let fired = false;
    const tryInstall = () => {
      if (fired) return;
      if (shouldFireInstall(Date.now(), deadline, isPipelineBusy())) {
        fired = true;
        install();
      }
    };
    // Simulates the setInterval tick in the component.
    tryInstall();
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing halts further edge-triggers', () => {
    const listener = vi.fn();
    const unsub = subscribePipelineBusy(listener);
    setPipelineBusy(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    setPipelineBusy(false);
    setPipelineBusy(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
