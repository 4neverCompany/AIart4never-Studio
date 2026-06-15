/**
 * 4NE-16 — Provider mapper tests (PURE).
 *
 * `mapExaResult` / `mapTavilyResult` are the thing we pin hardest: realistic
 * raw rows (incl. the MCP `content:[{type:'text',text:'<json>'}]` envelope) →
 * correct NicheSuggestion[] with the right `source` tag; garbage → [].
 */
import { describe, it, expect } from 'vitest';

import { mapExaResult, mapTavilyResult } from '@/lib/research/providers';

describe('mapExaResult', () => {
  it('maps a realistic Exa { results: [...] } payload', () => {
    const raw = {
      results: [
        {
          title: 'Grimdark cosplay is trending',
          url: 'https://example.com/a',
          text: 'A surge in grimdark armor builds...',
          score: 0.91,
          publishedDate: '2026-05-01',
        },
        {
          title: 'Cyberpunk netrunner aesthetics',
          url: 'https://example.com/b',
          text: 'Neon circuit-line looks dominate...',
          score: 0.84,
        },
      ],
    };
    const got = mapExaResult(raw);
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual({
      title: 'Grimdark cosplay is trending',
      summary: 'A surge in grimdark armor builds...',
      url: 'https://example.com/a',
      source: 'exa',
      score: 0.91,
      publishedAt: '2026-05-01',
    });
    expect(got[1]).toMatchObject({ source: 'exa', url: 'https://example.com/b' });
    expect(got[1].publishedAt).toBeUndefined();
    expect(got.every((s) => s.source === 'exa')).toBe(true);
  });

  it('unwraps an MCP text-part envelope containing JSON', () => {
    const raw = [
      {
        type: 'text',
        text: JSON.stringify({
          results: [{ title: 'T', url: 'https://x.test', text: 'snippet' }],
        }),
      },
    ];
    const got = mapExaResult(raw);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ title: 'T', summary: 'snippet', source: 'exa' });
  });

  it('accepts a bare array of rows', () => {
    const got = mapExaResult([{ title: 'Bare', url: 'https://bare.test' }]);
    expect(got).toEqual([{ title: 'Bare', summary: '', url: 'https://bare.test', source: 'exa' }]);
  });

  it('falls back to the URL when a row has no title', () => {
    const got = mapExaResult({ results: [{ url: 'https://only-url.test', snippet: 's' }] });
    expect(got[0]).toMatchObject({ title: 'https://only-url.test', summary: 's', source: 'exa' });
  });

  it('returns [] for garbage', () => {
    expect(mapExaResult(null)).toEqual([]);
    expect(mapExaResult(undefined)).toEqual([]);
    expect(mapExaResult(42)).toEqual([]);
    expect(mapExaResult('nope')).toEqual([]);
    expect(mapExaResult({})).toEqual([]);
    expect(mapExaResult({ results: 'not-an-array' })).toEqual([]);
    expect(mapExaResult({ results: [{ noTitleNoUrl: true }] })).toEqual([]);
  });
});

describe('mapTavilyResult', () => {
  it("maps a realistic Tavily payload using `content` + `published_date`", () => {
    const raw = {
      results: [
        {
          title: 'Warhammer-inspired art blows up',
          url: 'https://example.com/t1',
          content: 'Original chapter designs are hot...',
          score: 0.77,
          published_date: '2026-04-20',
        },
      ],
    };
    const got = mapTavilyResult(raw);
    expect(got).toEqual([
      {
        title: 'Warhammer-inspired art blows up',
        summary: 'Original chapter designs are hot...',
        url: 'https://example.com/t1',
        source: 'tavily',
        score: 0.77,
        publishedAt: '2026-04-20',
      },
    ]);
  });

  it('unwraps an MCP text-part envelope and tags source tavily', () => {
    const raw = [
      { type: 'text', text: JSON.stringify({ results: [{ title: 'Y', url: 'https://y.test', content: 'c' }] }) },
    ];
    const got = mapTavilyResult(raw);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ title: 'Y', summary: 'c', source: 'tavily' });
  });

  it('returns [] for garbage', () => {
    expect(mapTavilyResult(null)).toEqual([]);
    expect(mapTavilyResult([{ type: 'text', text: 'not json' }])).toEqual([]);
    expect(mapTavilyResult({ results: [] })).toEqual([]);
    expect(mapTavilyResult({ results: [123, 'x', null] })).toEqual([]);
  });
});
