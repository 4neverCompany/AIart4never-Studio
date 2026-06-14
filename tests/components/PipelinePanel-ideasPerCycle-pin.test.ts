// V091-QA-FOLLOWUP — pin the PipelinePanel wiring of the new
// `pipelineIdeasPerCycle` control. Same pattern as the existing
// `PipelinePanel-responsive-pin.test.ts`: source-text assertion so
// a future refactor that silently drops the wiring fails loud here
// without needing to render the full heavy panel in jsdom.
//
// What this pins:
//   1. The control reads `pipelineIdeasPerCycle` from useMashup.
//   2. The control writes via `setPipelineIdeasPerCycle` from useMashup.
//   3. The onChange clamps to [1, 10] before calling the setter.
//   4. The input has the correct min/max/default-driven shape.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(
  resolve(__dirname, '../../components/PipelinePanel.tsx'),
  'utf-8',
);

describe('PipelinePanel — pipelineIdeasPerCycle wiring pin', () => {
  it('destructures pipelineIdeasPerCycle and setPipelineIdeasPerCycle from useMashup', () => {
    expect(SOURCE).toMatch(/pipelineIdeasPerCycle,\s*\n\s*setPipelineIdeasPerCycle,/);
  });

  it('renders a labelled "ideas/cycle" input bound to pipelineIdeasPerCycle', () => {
    expect(SOURCE).toContain('ideas/cycle');
    expect(SOURCE).toMatch(/value=\{pipelineIdeasPerCycle\}/);
  });

  it('input has min=1 max=10 (matches the daemon clamp range)', () => {
    // Block-match the input by finding the value={pipelineIdeasPerCycle}
    // anchor and grabbing the surrounding <input ...> tag — `[\s\S]` is
    // the dotall-equivalent that doesn't need the ES2018 `s` flag.
    const block = SOURCE.match(
      /<input[\s\S]*?value=\{pipelineIdeasPerCycle\}[\s\S]*?\/>/,
    );
    expect(block).not.toBeNull();
    expect(block?.[0]).toMatch(/min=\{1\}/);
    expect(block?.[0]).toMatch(/max=\{10\}/);
  });

  it('onChange calls setPipelineIdeasPerCycle with a clamped numeric value', () => {
    expect(SOURCE).toMatch(
      /onChange=\{[^}]*setPipelineIdeasPerCycle\(\s*Math\.max\(1,\s*Math\.min\(10,\s*Number\(e\.target\.value\)\)\)\s*\)/,
    );
  });
});
