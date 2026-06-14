/**
 * Tests for lib/agent-tools/m3-vision-describe.
 *
 * Coverage:
 *   - happy path: mmx CLI returns description → output parsed
 *   - mmx not installed → ToolNotAvailableError
 *   - quota error → ToolNotAvailableError (no retry)
 *   - input validation (one of imagePath / imageUrl / imageId)
 *   - the tool is registered in AGENT_TOOLS and exposed by name
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as mmx from '@/lib/mmx-client';
import {
  executeM3VisionDescribe,
  m3VisionDescribeTool,
  AGENT_TOOLS,
  describeAgentTools,
} from '@/lib/agent-tools';

describe('m3_vision_describe.executeM3VisionDescribe — happy paths', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the mmx description for a valid imagePath input', async () => {
    vi.spyOn(mmx, 'isAvailable').mockResolvedValue(true);
    vi.spyOn(mmx, 'describeImage').mockResolvedValue({
      description: 'a black cat sitting on a windowsill at dusk',
      raw: { description: 'a black cat sitting on a windowsill at dusk' },
    });
    const result = await executeM3VisionDescribe({
      imagePath: '/tmp/cat.png',
      prompt: 'Describe the image briefly.',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.description).toMatch(/black cat/);
    expect(typeof result.value.durationMs).toBe('number');
    expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes a custom prompt through to mmx', async () => {
    vi.spyOn(mmx, 'isAvailable').mockResolvedValue(true);
    const spy = vi.spyOn(mmx, 'describeImage').mockResolvedValue({
      description: 'looks good',
      raw: {},
    });
    await executeM3VisionDescribe({
      imagePath: '/tmp/x.png',
      prompt: 'Score this 0-1 for visual issues.',
    });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ image: '/tmp/x.png' }),
      expect.objectContaining({ prompt: 'Score this 0-1 for visual issues.' }),
      expect.anything(),
    );
  });

  it('uses a default prompt when the input omits one', async () => {
    vi.spyOn(mmx, 'isAvailable').mockResolvedValue(true);
    const spy = vi.spyOn(mmx, 'describeImage').mockResolvedValue({
      description: 'something',
      raw: {},
    });
    await executeM3VisionDescribe({ imagePath: '/tmp/x.png' });
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ prompt: expect.stringMatching(/Describe/i) }),
      expect.anything(),
    );
  });
});

describe('m3_vision_describe.executeM3VisionDescribe — error paths', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ToolNotAvailableError when mmx is not installed', async () => {
    vi.spyOn(mmx, 'isAvailable').mockResolvedValue(false);
    const result = await executeM3VisionDescribe({ imagePath: '/tmp/x.png' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.name).toBe('ToolNotAvailableError');
    expect(result.error.message).toMatch(/mmx/i);
  });

  it('rejects input that has no image source', async () => {
    const result = await executeM3VisionDescribe({ prompt: 'hello' });
    expect(result.ok).toBe(false);
  });

  it('surfaces a quota error as ToolNotAvailableError (no retry)', async () => {
    vi.spyOn(mmx, 'isAvailable').mockResolvedValue(true);
    vi.spyOn(mmx, 'describeImage').mockRejectedValue(
      new mmx.MmxQuotaError('vision quota exhausted', 'upgrade plan'),
    );
    const result = await executeM3VisionDescribe({ imagePath: '/tmp/x.png' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.name).toBe('ToolNotAvailableError');
  });
});

describe('m3_vision_describe tool — registry wiring (V1.2.6)', () => {
  it('is registered in AGENT_TOOLS under the name m3_vision_describe', () => {
    const tools = describeAgentTools();
    const found = tools.find((t) => t.name === 'm3_vision_describe');
    expect(found).toBeDefined();
    expect(found!.description.length).toBeGreaterThan(20);
    expect(found!.hasInputSchema).toBe(true);
    expect(found!.hasOutputSchema).toBe(true);
  });

  it('the AGENT_TOOLS array now contains 11 tools (was 10, job_lookup added in V1.3.0 T1.5)', () => {
    expect(AGENT_TOOLS.length).toBe(11);
  });

  it('m3VisionDescribeTool object is the same reference as in AGENT_TOOLS', () => {
    expect(AGENT_TOOLS).toContain(m3VisionDescribeTool);
  });
});
