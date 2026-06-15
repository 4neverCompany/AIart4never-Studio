/**
 * 4NE-14 — Insights source tests.
 *
 * `mapRawInsight` is PURE and is the thing we pin down hardest: realistic raw
 * rows → correct PostInsight; garbage → null; missing metrics → 0.
 *
 * `fetchInsights` is exercised with an INJECTED fake `connect` (no network):
 * the fake's `callMcpTool` returns fixture rows, and we assert the mapped +
 * enriched PostInsight[] AND that the client is closed.
 *
 * `@/lib/mcp` is mocked so `callMcpTool` is controllable and a real connect is
 * loud — same pattern as `tests/lib/publish/dispatch.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const callMcpToolSpy = vi.fn();
vi.mock('@/lib/mcp', () => ({
  callMcpTool: (...args: unknown[]) => callMcpToolSpy(...args),
  connectMcp: vi.fn(() => {
    throw new Error('real connectMcp should never be called in tests');
  }),
  getServer: vi.fn(async (id: string) => ({
    id,
    name: 'fake-ig',
    transport: 'http' as const,
    url: 'https://mcp.example.com',
    enabled: true,
    trusted: true,
    addedAt: 0,
  })),
}));

import { fetchInsights, mapRawInsight, INSIGHTS_TOOL } from '@/lib/analytics/insights-source';
import type { FetchInsightsDeps, PostRef } from '@/lib/analytics/insights-source';

const closeSpy = vi.fn();
const connectSpy = vi.fn();

function fakeConnect() {
  closeSpy.mockResolvedValue(undefined);
  connectSpy.mockResolvedValue({ client: { __fake: true }, close: closeSpy });
  return connectSpy as unknown as FetchInsightsDeps['connect'];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mapRawInsight', () => {
  it('maps a realistic flat Composio row to a PostInsight', () => {
    const raw = {
      media_id: '17900000000000000',
      timestamp: '2024-01-05T12:00:00+0000',
      like_count: 120,
      comments_count: 8,
      saves: 30,
      shares: 12,
      reach: 5400,
      impressions: 7200,
    };
    const got = mapRawInsight(raw);
    expect(got).not.toBeNull();
    expect(got).toMatchObject({
      postId: '17900000000000000',
      likes: 120,
      comments: 8,
      saves: 30,
      shares: 12,
      reach: 5400,
      impressions: 7200,
    });
    expect(got!.postedAt).toBeGreaterThan(0);
  });

  it('reads the IG Graph insights-array shape (name/values)', () => {
    const raw = {
      id: 'abc123',
      data: [
        { name: 'reach', values: [{ value: 2000 }] },
        { name: 'saved', values: [{ value: 45 }] },
        { name: 'likes', value: 10 },
      ],
    };
    const got = mapRawInsight(raw);
    expect(got).toMatchObject({ postId: 'abc123', reach: 2000, saves: 45, likes: 10 });
  });

  it('unwraps a { media: {...} } envelope', () => {
    const got = mapRawInsight({ media: { post_id: 'm1', like_count: 5 } });
    expect(got).toMatchObject({ postId: 'm1', likes: 5 });
  });

  it('defaults missing metrics to 0 (never NaN)', () => {
    const got = mapRawInsight({ id: 'only-id' });
    expect(got).toMatchObject({
      postId: 'only-id',
      likes: 0,
      comments: 0,
      saves: 0,
      shares: 0,
      reach: 0,
      impressions: 0,
      postedAt: 0,
    });
  });

  it('returns null for a garbage / id-less row', () => {
    expect(mapRawInsight(null)).toBeNull();
    expect(mapRawInsight(42)).toBeNull();
    expect(mapRawInsight('nope')).toBeNull();
    expect(mapRawInsight([])).toBeNull();
    expect(mapRawInsight({ like_count: 10 })).toBeNull(); // no post id
  });
});

describe('fetchInsights', () => {
  it('connects, calls the insights tool, maps + enriches rows, and closes the client', async () => {
    callMcpToolSpy.mockResolvedValue([
      { media_id: 'p1', like_count: 10, saves: 5, reach: 1000 },
      { media_id: 'p2', like_count: 2, reach: 500 },
      { garbage: true }, // dropped (no id)
    ]);

    const postRefs: PostRef[] = [
      { postId: 'p1', pillarId: 'story-beat', reality: 'prime', day: 'fri', assetId: 'a1', postedAt: 123 },
    ];

    const result = await fetchInsights('ig-connector', { connect: fakeConnect(), postRefs });

    // The right tool was called.
    expect(callMcpToolSpy).toHaveBeenCalledTimes(1);
    expect(callMcpToolSpy.mock.calls[0]![1]).toBe(INSIGHTS_TOOL);

    // Two usable rows mapped; garbage dropped.
    expect(result).toHaveLength(2);

    // p1 enriched from postRefs.
    const p1 = result.find((r) => r.postId === 'p1')!;
    expect(p1).toMatchObject({
      pillarId: 'story-beat',
      reality: 'prime',
      day: 'fri',
      assetId: 'a1',
      likes: 10,
      saves: 5,
      reach: 1000,
      postedAt: 123, // planned time filled in since the live row had none
    });

    // p2 had no ref → no planning metadata.
    const p2 = result.find((r) => r.postId === 'p2')!;
    expect(p2.pillarId).toBeUndefined();

    // Client always closed.
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('unwraps an MCP text-part result containing JSON', async () => {
    callMcpToolSpy.mockResolvedValue([
      { type: 'text', text: JSON.stringify({ data: [{ id: 'x1', reach: 900, saved: 3 }] }) },
    ]);
    const result = await fetchInsights('ig-connector', { connect: fakeConnect() });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ postId: 'x1', reach: 900, saves: 3 });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('closes the client even when the tool call throws', async () => {
    callMcpToolSpy.mockRejectedValue(new Error('tool boom'));
    await expect(fetchInsights('ig-connector', { connect: fakeConnect() })).rejects.toThrow('tool boom');
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('throws on an unknown connector and never connects', async () => {
    const connect = fakeConnect();
    await expect(
      fetchInsights('missing', { connect, getConnector: async () => undefined }),
    ).rejects.toThrow(/unknown connector/i);
    expect(connect).not.toHaveBeenCalled();
  });

  it('honors a custom tool slug override', async () => {
    callMcpToolSpy.mockResolvedValue([]);
    await fetchInsights('ig-connector', { connect: fakeConnect(), tool: 'CUSTOM_INSIGHTS_SLUG' });
    expect(callMcpToolSpy.mock.calls[0]![1]).toBe('CUSTOM_INSIGHTS_SLUG');
  });
});
