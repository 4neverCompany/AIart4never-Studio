// @vitest-environment jsdom
//
// V091-QA-FOLLOWUP §4 (PIPELINE-CONT-V2): the strip surfaces the
// `pipeline-week-confirmed` log event so the user gets a clear
// success signal on every tab — not just the pipeline view.
//
// The brief calls out a "success banner". We render a small green
// pill bound to `pipelineLog[last]?.step === 'pipeline-week-confirmed'`
// so it auto-dismisses the moment the daemon emits any newer event
// (no timer, no manual close).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { PipelineLogEntry } from '@/types/mashup';

// Controllable mash stub. Only the fields the strip actually reads are
// modeled — the rest stay undefined and the type assertion below pins
// the cast.
const mashStub: {
  pipelineEnabled: boolean;
  pipelineRunning: boolean;
  pipelineQueue: unknown[];
  pipelineProgress: { currentStep: string; currentIdea: string } | null;
  pipelineContinuous: boolean;
  pipelineLog: PipelineLogEntry[];
} = {
  pipelineEnabled: false,
  pipelineRunning: false,
  pipelineQueue: [],
  pipelineProgress: null,
  pipelineContinuous: false,
  pipelineLog: [],
};

vi.mock('@/components/MashupContext', () => ({
  useMashup: () => mashStub,
}));

import { PipelineStatusStrip } from '@/components/PipelineStatusStrip';

function logEntry(step: string, ageMs = 0): PipelineLogEntry {
  return {
    timestamp: new Date(Date.now() - ageMs),
    step,
    ideaId: '',
    status: 'success',
    message: 'test',
  };
}

describe('PipelineStatusStrip — pipeline-week-confirmed banner', () => {
  beforeEach(() => {
    mashStub.pipelineEnabled = true;
    mashStub.pipelineRunning = true;
    mashStub.pipelineQueue = [];
    mashStub.pipelineProgress = null;
    mashStub.pipelineContinuous = true;
    mashStub.pipelineLog = [];
  });

  afterEach(() => cleanup());

  it('renders the banner when the most-recent log is pipeline-week-confirmed', () => {
    mashStub.pipelineLog = [
      logEntry('pipeline-cycle', 30_000),
      logEntry('pipeline-week-confirmed', 1_000),
    ];
    render(<PipelineStatusStrip setView={() => {}} />);
    const banner = screen.getByTestId('pipeline-week-confirmed-banner');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('Week confirmed');
  });

  it('does NOT render the banner when the most-recent log is something else', () => {
    // Confirmed event happened earlier but a newer cycle log replaced
    // it — banner must auto-dismiss without any explicit timer.
    mashStub.pipelineLog = [
      logEntry('pipeline-week-confirmed', 30_000),
      logEntry('pipeline-cycle', 1_000),
    ];
    render(<PipelineStatusStrip setView={() => {}} />);
    expect(screen.queryByTestId('pipeline-week-confirmed-banner')).toBeNull();
  });

  it('does NOT render the banner when pipelineLog is empty', () => {
    mashStub.pipelineLog = [];
    render(<PipelineStatusStrip setView={() => {}} />);
    expect(screen.queryByTestId('pipeline-week-confirmed-banner')).toBeNull();
  });

  it('does NOT confuse the partial-fill log with the confirmed one', () => {
    // pipeline-week-partial fires when filled-but-pending, and the
    // daemon keeps generating — that is NOT the confirmed-fill state
    // and must not show the success banner.
    mashStub.pipelineLog = [logEntry('pipeline-week-partial', 1_000)];
    render(<PipelineStatusStrip setView={() => {}} />);
    expect(screen.queryByTestId('pipeline-week-confirmed-banner')).toBeNull();
  });
});
