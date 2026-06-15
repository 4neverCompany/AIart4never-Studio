/**
 * 4NE-16 — Research dispatcher tests.
 *
 * `researchNiches` is exercised with an INJECTED fake `connect` whose
 * `callMcpTool` is scripted (no network), mirroring
 * `tests/lib/analytics/insights-source.test.ts`. We assert the full fallback
 * decision tree:
 *   - Exa returns results → used, not degraded, client closed.
 *   - Exa throws → Tavily fallback used + degraded + note, both clients closed.
 *   - Exa empty → Tavily fallback used + degraded.
 *   - Both fail/empty → empty outcome, never throws, all clients closed.
 *
 * `@/lib/mcp` is mocked so a real `connectMcp` is loud and `getServer` returns a
 * stub config — same pattern as the analytics/publish dispatch tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/mcp', () => ({
  // The dispatcher resolves callTool from deps.callTool ?? callMcpTool; tests
  // inject scripted callTool, so this real one should never run.
  callMcpTool: vi.fn(() => {
    throw new Error('real callMcpTool should never be called in tests');
  }),
  connectMcp: vi.fn(() => {
    throw new Error('real connectMcp should never be called in tests');
  }),
  getServer: vi.fn(async (id: string) => ({
    id,
    name: `fake-${id}`,
    transport: 'http' as const,
    url: 'https://mcp.example.com',
    enabled: true,
    trusted: true,
    addedAt: 0,
  })),
}));

import type { callMcpTool } from '@/lib/mcp';
import { researchNiches } from '@/lib/research/research';
import type { ResearchDeps } from '@/lib/research/research';
import { EXA_SEARCH_TOOL, TAVILY_SEARCH_TOOL } from '@/lib/research/providers';

/**
 * A `callMcpTool`-typed mock so `.mock.calls[i][1]` (tool slug) and `[2]`
 * (args) are well-typed. `vi.fn(async () => x)` infers an empty-args tuple,
 * which makes those index accesses a type error.
 */
function callToolMock() {
  return vi.fn<typeof callMcpTool>();
}

/**
 * Build a fake `connect` that hands back a per-connection close spy. Every
 * connection's close spy is pushed onto `closes` so we can assert they all ran.
 */
function makeConnect(closes: ReturnType<typeof vi.fn>[]) {
  const connect = vi.fn(async () => {
    const close = vi.fn(async () => {});
    closes.push(close);
    return { client: { __fake: true }, close };
  });
  return connect as unknown as ResearchDeps['connect'];
}

const exaPayload = {
  results: [{ title: 'Exa hit', url: 'https://exa.test', text: 'exa snippet', score: 0.9 }],
};
const tavilyPayload = {
  results: [{ title: 'Tavily hit', url: 'https://tav.test', content: 'tavily snippet' }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('researchNiches — fallback decision tree', () => {
  it('Exa returns results → used, not degraded, never touches Tavily, client closed', async () => {
    const closes: ReturnType<typeof vi.fn>[] = [];
    const connect = makeConnect(closes);
    const callTool = callToolMock().mockResolvedValue(exaPayload);

    const outcome = await researchNiches(
      { query: 'master4never niches', maxResults: 5 },
      { exaConnectorId: 'exa-c', tavilyConnectorId: 'tav-c', connect, callTool },
    );

    expect(outcome.usedProvider).toBe('exa');
    expect(outcome.degraded).toBe(false);
    expect(outcome.suggestions).toHaveLength(1);
    expect(outcome.suggestions[0]).toMatchObject({ source: 'exa', title: 'Exa hit' });

    // Only Exa was called — Tavily never reached.
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[0]![1]).toBe(EXA_SEARCH_TOOL);
    // The query + a result cap were threaded through.
    const args = callTool.mock.calls[0]![2] as Record<string, unknown>;
    expect(args.query).toBe('master4never niches');
    expect(args.numResults).toBe(5);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toHaveBeenCalledTimes(1);
  });

  it('Exa throws → Tavily fallback used + degraded + note; BOTH clients closed', async () => {
    const closes: ReturnType<typeof vi.fn>[] = [];
    const connect = makeConnect(closes);
    const callTool = callToolMock()
      .mockRejectedValueOnce(new Error('exa boom'))
      .mockResolvedValueOnce(tavilyPayload);

    const outcome = await researchNiches(
      { query: 'trends' },
      { exaConnectorId: 'exa-c', tavilyConnectorId: 'tav-c', connect, callTool },
    );

    expect(outcome.usedProvider).toBe('tavily');
    expect(outcome.degraded).toBe(true);
    expect(outcome.suggestions[0]).toMatchObject({ source: 'tavily', title: 'Tavily hit' });
    expect(outcome.notes.join(' ')).toMatch(/exa failed: .*exa boom.*used tavily fallback/i);

    // Exa then Tavily.
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(callTool.mock.calls[0]![1]).toBe(EXA_SEARCH_TOOL);
    expect(callTool.mock.calls[1]![1]).toBe(TAVILY_SEARCH_TOOL);

    // Both connections closed.
    expect(closes).toHaveLength(2);
    for (const c of closes) expect(c).toHaveBeenCalledTimes(1);
  });

  it('Exa returns empty → Tavily fallback used + degraded', async () => {
    const closes: ReturnType<typeof vi.fn>[] = [];
    const connect = makeConnect(closes);
    const callTool = callToolMock()
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce(tavilyPayload);

    const outcome = await researchNiches(
      { query: 'q' },
      { exaConnectorId: 'exa-c', tavilyConnectorId: 'tav-c', connect, callTool },
    );

    expect(outcome.usedProvider).toBe('tavily');
    expect(outcome.degraded).toBe(true);
    expect(outcome.notes.join(' ')).toMatch(/no results.*used tavily fallback/i);
    expect(closes).toHaveLength(2);
    for (const c of closes) expect(c).toHaveBeenCalledTimes(1);
  });

  it('only Tavily configured → used + degraded (primary never tried)', async () => {
    const closes: ReturnType<typeof vi.fn>[] = [];
    const connect = makeConnect(closes);
    const callTool = callToolMock().mockResolvedValue(tavilyPayload);

    const outcome = await researchNiches(
      { query: 'q' },
      { tavilyConnectorId: 'tav-c', connect, callTool },
    );

    expect(outcome.usedProvider).toBe('tavily');
    expect(outcome.degraded).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[0]![1]).toBe(TAVILY_SEARCH_TOOL);
    expect(closes[0]).toHaveBeenCalledTimes(1);
  });

  it('both fail → empty outcome, never throws, all clients closed', async () => {
    const closes: ReturnType<typeof vi.fn>[] = [];
    const connect = makeConnect(closes);
    const callTool = callToolMock()
      .mockRejectedValueOnce(new Error('exa down'))
      .mockRejectedValueOnce(new Error('tavily down'));

    const outcome = await researchNiches(
      { query: 'q' },
      { exaConnectorId: 'exa-c', tavilyConnectorId: 'tav-c', connect, callTool },
    );

    expect(outcome.suggestions).toEqual([]);
    expect(outcome.usedProvider).toBeNull();
    expect(outcome.degraded).toBe(true);
    expect(outcome.notes.join(' ')).toMatch(/exa down/);
    expect(outcome.notes.join(' ')).toMatch(/tavily down/);
    expect(closes).toHaveLength(2);
    for (const c of closes) expect(c).toHaveBeenCalledTimes(1);
  });

  it('neither configured → empty outcome, degraded, never connects', async () => {
    const closes: ReturnType<typeof vi.fn>[] = [];
    const connect = makeConnect(closes);
    const callTool = callToolMock();

    const outcome = await researchNiches({ query: 'q' }, { connect, callTool });

    expect(outcome.suggestions).toEqual([]);
    expect(outcome.usedProvider).toBeNull();
    expect(outcome.degraded).toBe(true);
    expect(connect).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
    expect(closes).toHaveLength(0);
  });

  it('unknown connector (config resolves undefined) → falls through without throwing, closes nothing for that provider', async () => {
    const closes: ReturnType<typeof vi.fn>[] = [];
    const connect = makeConnect(closes);
    const callTool = callToolMock().mockResolvedValue(tavilyPayload);

    const outcome = await researchNiches(
      { query: 'q' },
      {
        exaConnectorId: 'missing-exa',
        tavilyConnectorId: 'tav-c',
        connect,
        callTool,
        getConnector: async (id) => (id === 'tav-c' ? ({ id, name: 't', transport: 'http', url: 'https://m', enabled: true, trusted: true, addedAt: 0 } as never) : undefined),
      },
    );

    // Exa connector unknown → recorded as a failure note, Tavily served.
    expect(outcome.usedProvider).toBe('tavily');
    expect(outcome.degraded).toBe(true);
    expect(outcome.notes.join(' ')).toMatch(/unknown exa connector/i);
    // Exa never opened a connection (config resolve failed first).
    expect(connect).toHaveBeenCalledTimes(1);
    expect(closes).toHaveLength(1);
  });

  it('honors custom tool-slug overrides', async () => {
    const closes: ReturnType<typeof vi.fn>[] = [];
    const connect = makeConnect(closes);
    const callTool = callToolMock().mockResolvedValue(exaPayload);

    await researchNiches(
      { query: 'q' },
      { exaConnectorId: 'exa-c', connect, callTool, exaSearchTool: 'web_search_exa_v2' },
    );

    expect(callTool.mock.calls[0]![1]).toBe('web_search_exa_v2');
  });
});
