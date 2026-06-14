import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  parseDdgHtml,
  parseBraveJson,
  parseSerperJson,
  validateQuery,
  clampCount,
  webSearch,
  webSearchBrave,
  webSearchSerper,
  extractTrendingTags,
} from '@/lib/web-search';

const SAMPLE_HTML = `
<html><body>
<div class="result results_links results_links_deep web-result">
  <div class="links_main">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=abc">Example <b>One</b></a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">First snippet &amp; more</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main">
    <a class="result__a" href="https://direct.example.org/b">Direct Link</a>
    <a class="result__snippet">Second snippet text</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.net%2Fc">Third &#x27;quoted&#x27;</a>
  </div>
</div>
</body></html>
`;

describe('parseDdgHtml', () => {
  it('extracts title, url, snippet from DDG redirector wrapper', () => {
    const results = parseDdgHtml(SAMPLE_HTML, 5);
    expect(results.length).toBe(3);
    expect(results[0]).toEqual({
      title: 'Example One',
      url: 'https://example.com/a',
      snippet: 'First snippet & more',
    });
  });

  it('passes through already-absolute hrefs unchanged', () => {
    const results = parseDdgHtml(SAMPLE_HTML, 5);
    expect(results[1].url).toBe('https://direct.example.org/b');
    expect(results[1].title).toBe('Direct Link');
  });

  it('decodes html entities in titles', () => {
    const results = parseDdgHtml(SAMPLE_HTML, 5);
    expect(results[2].title).toBe("Third 'quoted'");
  });

  it('tolerates missing snippet', () => {
    const results = parseDdgHtml(SAMPLE_HTML, 5);
    expect(results[2].snippet).toBe('');
  });

  it('honours count cap', () => {
    const results = parseDdgHtml(SAMPLE_HTML, 2);
    expect(results.length).toBe(2);
  });

  it('returns [] for unrelated html', () => {
    expect(parseDdgHtml('<html><body>nothing here</body></html>', 5)).toEqual([]);
  });

  it('returns [] for empty input', () => {
    expect(parseDdgHtml('', 5)).toEqual([]);
  });

  it('rejects non-http(s) redirect targets', () => {
    const bad = `
      <div class="result results_links results_links_deep web-result">
        <a class="result__a" href="javascript:alert(1)">Bad</a>
      </div>`;
    expect(parseDdgHtml(bad, 5)).toEqual([]);
  });
});

describe('validateQuery', () => {
  it('accepts a normal string', () => {
    expect(validateQuery('star wars warhammer')).toBe('star wars warhammer');
  });

  it('trims whitespace', () => {
    expect(validateQuery('  hello  ')).toBe('hello');
  });

  it('rejects non-string', () => {
    expect(validateQuery(42)).toBe(null);
    expect(validateQuery(null)).toBe(null);
    expect(validateQuery(undefined)).toBe(null);
    expect(validateQuery({ q: 'x' })).toBe(null);
  });

  it('rejects empty / whitespace-only', () => {
    expect(validateQuery('')).toBe(null);
    expect(validateQuery('    ')).toBe(null);
  });

  it('rejects > 200 chars', () => {
    expect(validateQuery('a'.repeat(201))).toBe(null);
    expect(validateQuery('a'.repeat(200))).toBe('a'.repeat(200));
  });
});

describe('clampCount', () => {
  it('defaults to 5 for undefined / non-finite', () => {
    expect(clampCount(undefined)).toBe(5);
    expect(clampCount(NaN)).toBe(5);
    expect(clampCount(Infinity)).toBe(5);
  });

  it('clamps to 1..20', () => {
    expect(clampCount(0)).toBe(1);
    expect(clampCount(-3)).toBe(1);
    expect(clampCount(21)).toBe(20);
    expect(clampCount(1000)).toBe(20);
  });

  it('floors fractional counts', () => {
    expect(clampCount(7.8)).toBe(7);
  });

  it('passes valid counts through', () => {
    expect(clampCount(10)).toBe(10);
  });
});

describe('parseBraveJson', () => {
  const bravePayload = {
    web: {
      results: [
        {
          title: 'Brave Result One',
          url: 'https://one.example.com/',
          description: 'Highlight-stripped <strong>description</strong>',
        },
        {
          title: 'Brave Result Two',
          url: 'https://two.example.com/',
          description: 'Second description',
        },
        {
          title: 'Third',
          url: 'javascript:alert(1)',
          description: 'Bad scheme, must be skipped',
        },
      ],
    },
  };

  it('extracts title/url/snippet and strips html', () => {
    const out = parseBraveJson(bravePayload, 5);
    expect(out.length).toBe(2);
    expect(out[0]).toEqual({
      title: 'Brave Result One',
      url: 'https://one.example.com/',
      snippet: 'Highlight-stripped description',
    });
  });

  it('honours count', () => {
    expect(parseBraveJson(bravePayload, 1).length).toBe(1);
  });

  it('returns [] for malformed payloads', () => {
    expect(parseBraveJson(null, 5)).toEqual([]);
    expect(parseBraveJson({}, 5)).toEqual([]);
    expect(parseBraveJson({ web: 'nope' }, 5)).toEqual([]);
    expect(parseBraveJson({ web: { results: 'nope' } }, 5)).toEqual([]);
  });
});

describe('webSearchBrave (fetch mocked)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns [] with no apiKey (no network call)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const out = await webSearchBrave('test', 5, undefined);
    expect(out).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('hits Brave endpoint with subscription header', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          web: { results: [{ title: 'T', url: 'https://x.example/', description: 'D' }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const out = await webSearchBrave('hello', 3, 'my-token');
    expect(out).toEqual([{ title: 'T', url: 'https://x.example/', snippet: 'D' }]);
    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain('api.search.brave.com');
    expect(String(url)).toContain('q=hello');
    expect(String(url)).toContain('count=3');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['X-Subscription-Token']).toBe('my-token');
  });

  it('returns [] on non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('rate limited', { status: 429 }),
    );
    expect(await webSearchBrave('q', 5, 'key')).toEqual([]);
  });

  it('returns [] on network rejection', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
    expect(await webSearchBrave('q', 5, 'key')).toEqual([]);
  });
});

describe('parseSerperJson', () => {
  it('maps organic[] (link/snippet) to the uniform shape', () => {
    const out = parseSerperJson(
      {
        organic: [
          { title: 'A', link: 'https://a.example/', snippet: 'sa' },
          { title: 'B', link: 'https://b.example/', snippet: 'sb' },
        ],
      },
      5,
    );
    expect(out).toEqual([
      { title: 'A', url: 'https://a.example/', snippet: 'sa' },
      { title: 'B', url: 'https://b.example/', snippet: 'sb' },
    ]);
  });

  it('skips entries without an http(s) link or title, and honours count', () => {
    const out = parseSerperJson(
      {
        organic: [
          { title: 'ok', link: 'https://ok.example/', snippet: 's' },
          { title: 'no-url', snippet: 's' },
          { title: '', link: 'https://empty.example/', snippet: 's' },
          { title: 'ftp', link: 'ftp://x/', snippet: 's' },
          { title: 'second', link: 'https://second.example/', snippet: 's' },
        ],
      },
      1,
    );
    expect(out).toEqual([{ title: 'ok', url: 'https://ok.example/', snippet: 's' }]);
  });

  it('returns [] for malformed payloads', () => {
    expect(parseSerperJson(null, 5)).toEqual([]);
    expect(parseSerperJson({}, 5)).toEqual([]);
    expect(parseSerperJson({ organic: 'nope' }, 5)).toEqual([]);
  });
});

describe('webSearchSerper (fetch mocked)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('POSTs to serper with the X-API-KEY header and parses organic[]', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ organic: [{ title: 'T', link: 'https://x.example/', snippet: 'D' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const out = await webSearchSerper('hello', 3, 'my-key');
    expect(out).toEqual([{ title: 'T', url: 'https://x.example/', snippet: 'D' }]);
    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain('google.serper.dev');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['X-API-KEY']).toBe('my-key');
    expect(String((init as RequestInit).body)).toContain('hello');
  });

  it('returns [] when no key is supplied (no fetch)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(await webSearchSerper('q', 5, undefined)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns [] on non-2xx and on network rejection', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 500 }));
    expect(await webSearchSerper('q', 5, 'key')).toEqual([]);
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network'));
    expect(await webSearchSerper('q', 5, 'key')).toEqual([]);
  });
});

describe('webSearch provider routing (fetch mocked)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const serperOk = () =>
    new Response(
      JSON.stringify({ organic: [{ title: 'Serper', link: 'https://s.example/', snippet: 'sdesc' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  const braveOk = () =>
    new Response(
      JSON.stringify({
        web: { results: [{ title: 'Brave', url: 'https://b.example/', description: 'bdesc' }] },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  const ddgOk = () =>
    new Response(
      `<div class="result results_links results_links_deep web-result">
         <a class="result__a" href="https://d.example/">DDG</a>
         <a class="result__snippet">ddesc</a>
       </div>`,
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    );

  it('prefers Serper when a serperApiKey is set (the new default)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(serperOk());
    const out = await webSearch('q', 5, undefined, { serperApiKey: 's', braveApiKey: 'b' });
    expect(out.length).toBe(1);
    expect(out[0].title).toBe('Serper');
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).toContain('google.serper.dev');
  });

  it('falls Serper → Brave → DDG, stopping at the first non-empty', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"organic":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(braveOk());
    const out = await webSearch('q', 5, undefined, { serperApiKey: 's', braveApiKey: 'b' });
    expect(out.length).toBe(1);
    expect(out[0].title).toBe('Brave');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[0][0])).toContain('google.serper.dev');
    expect(String(spy.mock.calls[1][0])).toContain('brave.com');
  });

  it('falls all the way to DDG when both Serper and Brave are empty', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"organic":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('{"web":{"results":[]}}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(ddgOk());
    const out = await webSearch('q', 5, undefined, { serperApiKey: 's', braveApiKey: 'b' });
    expect(out.length).toBe(1);
    expect(out[0].title).toBe('DDG');
    expect(spy).toHaveBeenCalledTimes(3);
    expect(String(spy.mock.calls[2][0])).toContain('duckduckgo.com');
  });

  it('prefers Brave when provider=brave and key set', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(braveOk());
    const out = await webSearch('q', 5, undefined, { provider: 'brave', braveApiKey: 'k' });
    expect(out.length).toBe(1);
    expect(out[0].title).toBe('Brave');
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).toContain('brave.com');
  });

  it('falls back to DDG when Brave fails (non-2xx)', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(ddgOk());
    const out = await webSearch('q', 5, undefined, { provider: 'brave', braveApiKey: 'k' });
    expect(out.length).toBe(1);
    expect(out[0].title).toBe('DDG');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[0][0])).toContain('brave.com');
    expect(String(spy.mock.calls[1][0])).toContain('duckduckgo.com');
  });

  it('uses DDG directly when provider=ddg', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ddgOk());
    const out = await webSearch('q', 5, undefined, { provider: 'ddg' });
    expect(out.length).toBe(1);
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).toContain('duckduckgo.com');
  });

  it('uses DDG when provider=brave but no key supplied', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ddgOk());
    const out = await webSearch('q', 5, undefined, { provider: 'brave' });
    expect(out.length).toBe(1);
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).toContain('duckduckgo.com');
  });

  it('uses DDG when options omitted (default behaviour preserved)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ddgOk());
    const out = await webSearch('q', 5);
    expect(out.length).toBe(1);
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).toContain('duckduckgo.com');
  });
});

describe('extractTrendingTags', () => {
  it('pulls explicit hashtags', () => {
    const tags = extractTrendingTags([
      {
        title: 'Neon street art #cyberpunk #StarWars',
        url: 'https://x.example/',
        snippet: 'also #grim-dark vibes',
      },
    ]);
    expect(tags).toContain('#cyberpunk');
    expect(tags).toContain('#StarWars');
    expect(tags).toContain('#grim-dark');
  });

  it('pulls Title-Case franchise phrases', () => {
    const tags = extractTrendingTags([
      {
        title: 'Star Wars meets Warhammer 40k in new fan art',
        url: 'https://x.example/',
        snippet: 'Darth Vader cosplays as an Inquisitor',
      },
    ]);
    expect(tags).toContain('Star Wars');
    expect(tags).toContain('Warhammer 40k');
    expect(tags).toContain('Darth Vader');
  });

  it('dedupes case-insensitively preserving first casing', () => {
    const tags = extractTrendingTags([
      { title: 'Star Wars news', url: 'https://a/', snippet: '' },
      { title: 'more STAR WARS coverage', url: 'https://b/', snippet: 'Star Wars fans say' },
    ]);
    const lowered = tags.map((t) => t.toLowerCase());
    const count = lowered.filter((t) => t === 'star wars').length;
    expect(count).toBe(1);
    expect(tags[0]).toBe('Star Wars');
  });

  it('ignores stopword-led Title-Case phrases', () => {
    const tags = extractTrendingTags([
      { title: 'The Latest Trends', url: 'https://x/', snippet: 'Top Tier content' },
    ]);
    expect(tags).not.toContain('The Latest Trends');
    expect(tags).not.toContain('Top Tier');
    expect(tags).not.toContain('Latest Trends');
  });

  it('returns [] for empty input', () => {
    expect(extractTrendingTags([])).toEqual([]);
  });

  it('handles missing snippet / title gracefully', () => {
    expect(() =>
      extractTrendingTags([
        { title: '', url: 'https://x/', snippet: '' },
        { title: 'Normal Title', url: 'https://x/', snippet: '' },
      ]),
    ).not.toThrow();
  });
});
