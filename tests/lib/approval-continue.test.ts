// V030-005: shouldAutoContinuePipeline decision tests.

import { describe, it, expect } from 'vitest';
import { shouldAutoContinuePipeline } from '@/lib/approval-continue';

const base = {
  pipelineRunning: false,
  isBulk: true,
  approvedCount: 3,
  weekFilled: false,
  pendingIdeaCount: 2,
};

describe('shouldAutoContinuePipeline', () => {
  it('returns true for a bulk approval on an idle pipeline with week gaps', () => {
    expect(shouldAutoContinuePipeline(base)).toBe(true);
  });

  it('returns false if the pipeline is already running', () => {
    expect(shouldAutoContinuePipeline({ ...base, pipelineRunning: true })).toBe(false);
  });

  it('returns false for single-item (non-bulk) approvals', () => {
    expect(shouldAutoContinuePipeline({ ...base, isBulk: false })).toBe(false);
  });

  it('returns false when no posts actually got approved', () => {
    expect(shouldAutoContinuePipeline({ ...base, approvedCount: 0 })).toBe(false);
  });

  it('returns true when week is filled but ideas still queued', () => {
    // pending ideas mean the user wants the daemon to keep grinding; the
    // target check inside the daemon will still gate publishing.
    expect(
      shouldAutoContinuePipeline({ ...base, weekFilled: true, pendingIdeaCount: 3 }),
    ).toBe(true);
  });

  it('returns false when week is filled AND no ideas are queued', () => {
    // Nothing left to do — don't spin up a run that would immediately idle.
    expect(
      shouldAutoContinuePipeline({ ...base, weekFilled: true, pendingIdeaCount: 0 }),
    ).toBe(false);
  });

  it('allows a 1-item bulk (Select All → single item) to trigger', () => {
    // Bulk action on a single-post queue still counts as a conscious
    // batch action by the user.
    expect(
      shouldAutoContinuePipeline({ ...base, approvedCount: 1 }),
    ).toBe(true);
  });
});
