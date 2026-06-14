/**
 * v1.2 Tool Registry — `trending_search` tool tests.
 *
 * Strategy: stub the camofox/web-search wrappers via `vi.mock()`
 * so the tests don't require a sidecar or network. The real
 * `lib/camofox/client.ts` is the test target's neighbour, not
 * its dependency for unit-test purposes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.mock factories must NOT reference top-level variables (the
// call is hoisted to the top of the file, before any `const`/let
// declarations). We use factory-only patterns with vi.fn() inside.
vi.mock('@/lib/camofox', () => ({
  withCamofoxHealth: vi.fn(),
  camofoxSearch: vi.fn(),
  CamofoxUnavailableError: class extends Error {},
  scrubPii: (s: string) => s,
}));

vi.mock('@/lib/web-search', () => ({
  webSearch: vi.fn(),
}));

// Now import the module under test (after the mocks are wired).
import {
  executeTrendingSearch,
  trendingSearchTool,
  __test__,
} from '@/lib/agent-tools/trending-search';
import { ValidationError, ToolExecutionError } from '@/lib/agent-tools/errors';
import * as camofoxModule from '@/lib/camofox';
import * as webSearchModule from '@/lib/web-search';

// Typed aliases for the mocked modules so the test body can call
// `.mockImplementation` etc. with autocomplete.
const camofoxMock = {
  withCamofoxHealth: camofoxModule.withCamofoxHealth as ReturnType<typeof vi.fn>,
  camofoxSearch: camofoxModule.camofoxSearch as ReturnType<typeof vi.fn>,
};
const webSearchMock = {
  webSearch: webSearchModule.webSearch as ReturnType<typeof vi.fn>,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('executeTrendingSearch — input validation', () => {
  it('rejects when niches is missing', async () => {
    const r = await executeTrendingSearch({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ValidationError);
  });

  it('rejects when niches is empty', async () => {
    const r = await executeTrendingSearch({ niches: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ValidationError);
  });

  it('rejects when input is not an object', async () => {
    const r = await executeTrendingSearch('not-an-object');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ValidationError);
  });

  it('rejects niches over the 6-cap', async () => {
    const r = await executeTrendingSearch({
      niches: Array.from({ length: 7 }, (_, i) => `n${i}`),
    });
    expect(r.ok).toBe(false);
  });
});

describe('executeTrendingSearch — happy path', () => {
  it('runs a single niche through camofox when reachable', async () => {
    camofoxMock.withCamofoxHealth.mockImplementation(async (primary) => primary());
    camofoxMock.camofoxSearch.mockResolvedValue([
      { title: 'A', url: 'https://a.com', snippet: 'a snippet' },
      { title: 'B', url: 'https://b.com', snippet: '' },
    ]);
    webSearchMock.webSearch.mockResolvedValue([]);

    const r = await executeTrendingSearch({ niches: ['Mythic Legends'] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.results).toHaveLength(2);
      expect(r.value.results[0]?.niche).toBe('Mythic Legends');
      expect(r.value.results[0]?.source).toBe('@google_search');
      expect(r.value.nichesWithHits).toEqual(['Mythic Legends']);
    }
  });

  it('falls back to webSearch when camofox rejects', async () => {
    camofoxMock.withCamofoxHealth.mockImplementation(async (_primary, fallback) => fallback());
    webSearchMock.webSearch.mockResolvedValue([
      { title: 'fallback', url: 'https://fb.com', snippet: '' },
    ]);

    const r = await executeTrendingSearch({ niches: ['Sci-Fi & Fantasy'] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.results).toHaveLength(1);
      expect(r.value.results[0]?.title).toBe('fallback');
      expect(r.value.servedBy).toBe('web-search');
    }
  });

  it('dedupes by URL when niches overlap', async () => {
    camofoxMock.withCamofoxHealth.mockImplementation(async (primary) => primary());
    camofoxMock.camofoxSearch.mockResolvedValue([
      { title: 'shared', url: 'https://shared.com', snippet: '' },
    ]);
    webSearchMock.webSearch.mockResolvedValue([]);

    const r = await executeTrendingSearch({
      niches: ['Marvel', 'DC Comics'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Two niches but one URL → one row.
      expect(r.value.results).toHaveLength(1);
      expect(r.value.nichesWithHits).toEqual(['Marvel', 'DC Comics']);
    }
  });

  it('returns empty results + empty nichesWithHits when nothing matches', async () => {
    camofoxMock.withCamofoxHealth.mockImplementation(async (primary) => primary());
    camofoxMock.camofoxSearch.mockResolvedValue([]);
    webSearchMock.webSearch.mockResolvedValue([]);

    const r = await executeTrendingSearch({ niches: ['Mythic Legends'] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.results).toEqual([]);
      expect(r.value.nichesWithHits).toEqual([]);
    }
  });

  it('biases the search query with ideaConcept when supplied', async () => {
    camofoxMock.withCamofoxHealth.mockImplementation(async (primary) => primary());
    camofoxMock.camofoxSearch.mockResolvedValue([]);
    webSearchMock.webSearch.mockResolvedValue([]);

    await executeTrendingSearch({
      niches: ['Mythic Legends'],
      ideaConcept: 'Darth Vader meets Iron Man',
    });
    expect(camofoxMock.camofoxSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining('Darth Vader meets Iron Man'),
      }),
    );
  });
});

describe('executeTrendingSearch — error path', () => {
  it('wraps a per-niche rejection as a retryable ToolExecutionError', async () => {
    camofoxMock.withCamofoxHealth.mockImplementation(async (primary) => primary());
    camofoxMock.camofoxSearch.mockRejectedValue(new Error('boom'));
    webSearchMock.webSearch.mockResolvedValue([]);

    const r = await executeTrendingSearch({ niches: ['X'] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(ToolExecutionError);
      const te = r.error as ToolExecutionError;
      expect(te.retryable).toBe(true);
      expect(te.message).toContain('X');
    }
  });
});

describe('trendingSearchTool (Vercel AI SDK shape)', () => {
  it('has a description and an input/output schema', () => {
    const obj = trendingSearchTool as unknown as Record<string, unknown>;
    expect(typeof obj.description).toBe('string');
    expect((obj.description as string).length).toBeGreaterThan(20);
    expect(obj.inputSchema).toBeDefined();
    expect(obj.outputSchema).toBeDefined();
    expect(typeof obj.execute).toBe('function');
  });
});

describe('__test__ helpers', () => {
  it('pickMacroForNiche returns the @google_search macro for any input', () => {
    expect(__test__.pickMacroForNiche('Marvel')).toBe('@google_search');
    expect(__test__.pickMacroForNiche('Anything')).toBe('@google_search');
  });
});
