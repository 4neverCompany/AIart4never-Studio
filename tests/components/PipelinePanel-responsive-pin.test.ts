// V081-TEST-GAPS: pin the STORY-012 responsive breakpoints on
// `components/PipelinePanel.tsx`. QA flagged the visual check as
// outstanding in V080-QA-REVIEW.md (gap #4) — true human verification
// at 390/640/768 px in DevTools is out of scope for an automated
// suite, but a class-pin regression net is in scope: a future styling
// refactor that silently drops the new breakpoint classes will fail
// here loud and proud, even before anyone reaches a browser.
//
// What this test does NOT do: it does not render the component or
// verify visual layout. jsdom does not apply CSS media queries. The
// human-eye verification at 390/640/768 px is still owed (logged in
// QA-REVIEW-RECENT-001 line 130) — this test only protects the input
// contract that drives that visual.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(
  resolve(__dirname, '../../components/PipelinePanel.tsx'),
  'utf-8',
);

describe('PipelinePanel — STORY-012 responsive breakpoint pin', () => {
  // Pipeline header row: must stack vertically below 640 px so the
  // Start/Stop button does not fight the toggle group when it wraps.
  it('pipeline header row uses flex-col + sm:flex-row stacking (no plain flex-wrap)', () => {
    expect(SOURCE).toContain(
      'flex flex-col sm:flex-row sm:flex-wrap sm:items-center sm:justify-between gap-3',
    );
    // The pre-fix shape — bare flex-wrap without flex-col — must NOT
    // re-appear at the same site. Match the exact pre-fix open tag so
    // we don't false-trigger on other flex-wrap rows in the file.
    expect(SOURCE).not.toContain(
      'flex flex-wrap items-center justify-between gap-3',
    );
  });

  // Stage toggles: 3 toggles must land in one row at >=768 px (md)
  // instead of the 2+1 orphan the old grid-cols-2-only spec produced.
  it('stage toggles grid promotes to md:grid-cols-3 at tablet width', () => {
    expect(SOURCE).toContain('grid grid-cols-2 md:grid-cols-3 gap-2');
  });

  // Per-platform 4-col grids (Auto-Approve, Daily Caps): the 640-767
  // band was cramming 4 columns under the old sm:grid-cols-4. Both
  // grids should now promote at md instead. Two occurrences expected
  // (one per grid).
  it('per-platform grids promote at md:grid-cols-4 (both Auto-Approve and Daily Caps)', () => {
    const matches = SOURCE.match(/grid grid-cols-2 md:grid-cols-4 gap-2/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    // Old shape must not re-appear.
    expect(SOURCE).not.toContain('grid grid-cols-2 sm:grid-cols-4 gap-2');
  });
});
