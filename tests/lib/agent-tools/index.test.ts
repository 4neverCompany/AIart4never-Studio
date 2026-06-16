/**
 * v1.2 Tool Registry — barrel / `AGENT_TOOLS` array tests.
 *
 * Asserts that every tool the Director loop relies on is:
 *   - present in `AGENT_TOOLS`
 *   - has a non-empty description (so the model knows when to use it)
 *   - has a Zod input schema (so the SDK can validate the model's call)
 *   - has a Zod output schema (so the loop can read the result)
 *   - has an `execute` function (the actual side-effecting code)
 */
import { describe, it, expect } from 'vitest';
import {
  AGENT_TOOLS,
  AGENT_TOOLS_MAP,
  describeAgentTools,
  generatePromptTool,
  critiquePromptTool,
  generateImageTool,
  generateVideoTool,
  persistAssetTool,
  m3VisionDescribeTool,
  viralityPredictTool,
  costEstimateTool,
  reframeImageTool,
  jobLookupTool,
} from '@/lib/agent-tools';

describe('AGENT_TOOLS — barrel contents', () => {
  // V1.3.0: 11 tools, minus trending_search (removed with the
  // web-trending strip) = 10 tools total.
  it('contains exactly the 10 documented tools', () => {
    expect(AGENT_TOOLS).toHaveLength(10);
  });

  it('contains the 10 expected tool references (in any order)', () => {
    const set = new Set(AGENT_TOOLS);
    expect(set.has(generatePromptTool)).toBe(true);
    expect(set.has(critiquePromptTool)).toBe(true);
    expect(set.has(generateImageTool)).toBe(true);
    expect(set.has(generateVideoTool)).toBe(true);
    expect(set.has(persistAssetTool)).toBe(true);
    expect(set.has(m3VisionDescribeTool)).toBe(true);
    expect(set.has(viralityPredictTool)).toBe(true);
    expect(set.has(costEstimateTool)).toBe(true);
    expect(set.has(reframeImageTool)).toBe(true);
    expect(set.has(jobLookupTool)).toBe(true);
  });
});

describe('AGENT_TOOLS — per-tool contract', () => {
  const docs = describeAgentTools();
  const expectedNames = [
    'generate_prompt',
    'critique_prompt',
    'generate_image',
    'generate_video',
    'persist_asset',
    'm3_vision_describe',
    'virality_predict',
    'cost_estimate',
    'reframe_image',
    'job_lookup',
  ];

  it('exposes one description row per tool', () => {
    expect(docs).toHaveLength(10);
  });

  it('names match the 10 documented tools', () => {
    const names = docs.map((d) => d.name).sort();
    expect(names).toEqual([...expectedNames].sort());
  });

  for (const d of docs) {
    it(`${d.name}: has a non-empty description (>= 40 chars)`, () => {
      expect(d.description.length).toBeGreaterThan(40);
    });

    it(`${d.name}: has an inputSchema`, () => {
      expect(d.hasInputSchema).toBe(true);
    });

    it(`${d.name}: has an outputSchema`, () => {
      expect(d.hasOutputSchema).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// AGENTIC-HARNESS: the name-keyed map for the conversational `streamText` turn.
// Its keys MUST stay in lock-step with the names `describeAgentTools()` reports
// (which AGENT.md references) so the SDK routes the model's tool-call to the
// right `execute()`.
// ---------------------------------------------------------------------------

describe('AGENT_TOOLS_MAP — name-keyed ToolSet', () => {
  const map = AGENT_TOOLS_MAP as unknown as Record<string, unknown>;
  const expectedNames = describeAgentTools().map((d) => d.name);

  it('keys exactly match the describeAgentTools names', () => {
    expect(Object.keys(map).sort()).toEqual([...expectedNames].sort());
  });

  it('has exactly 10 entries', () => {
    expect(Object.keys(map)).toHaveLength(10);
  });

  it('maps each name to the matching tool object', () => {
    expect(map.generate_prompt).toBe(generatePromptTool);
    expect(map.critique_prompt).toBe(critiquePromptTool);
    expect(map.generate_image).toBe(generateImageTool);
    expect(map.generate_video).toBe(generateVideoTool);
    expect(map.persist_asset).toBe(persistAssetTool);
    expect(map.m3_vision_describe).toBe(m3VisionDescribeTool);
    expect(map.virality_predict).toBe(viralityPredictTool);
    expect(map.cost_estimate).toBe(costEstimateTool);
    expect(map.reframe_image).toBe(reframeImageTool);
    expect(map.job_lookup).toBe(jobLookupTool);
  });
});
