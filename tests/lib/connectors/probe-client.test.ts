/**
 * probe-client adapter tests — the CLIENT-side seam that routes the MCP
 * connect-probe through the SERVER (`POST /api/mcp/probe`) instead of connecting
 * from the browser (the public-web CORS fix).
 *
 * `serverProbeDeps.connect`/`list` must have the SAME shapes the lib's
 * `confirmAndInstall` / `checkConnectorHealth` inject, so they drop in as the
 * `connect`/`list` deps. We mock `globalThis.fetch` (the probe endpoint) and
 * assert:
 *   - ok path: POSTs `{ config }` to `/api/mcp/probe`; `connect` returns a fake
 *     connection whose `list` yields the server's tools and whose `close` is a
 *     no-op;
 *   - `{ ok:false }` → `connect` throws an McpError carrying the server's code;
 *   - a non-2xx / non-JSON / network error → `connect` throws an McpError so the
 *     lib's existing failure handling fires.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { serverProbeDeps } from '@/lib/connectors';
import { McpError } from '@/lib/mcp';

const CONNECTOR = {
  id: 'notion-mcp',
  name: 'Notion MCP',
  transport: 'http' as const,
  url: 'https://mcp.notion.example/mcp',
  headers: { Authorization: 'Bearer secret' },
  enabled: true,
  trusted: true,
  addedAt: 0,
};

const TOOLS = [
  { name: 'search', description: 'search pages' },
  { name: 'fetch_page', description: 'fetch a page' },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('serverProbeDeps — server-backed connect/list', () => {
  it('connect POSTs the config to /api/mcp/probe and returns a connection carrying the tools', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ ok: true, tools: TOOLS }),
    );

    const conn = await serverProbeDeps.connect(CONNECTOR);

    // Posted to the probe endpoint with { config }.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/mcp/probe');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ config: CONNECTOR });

    // list reads the tools the server returned.
    const tools = await serverProbeDeps.list(conn.client);
    expect(tools).toEqual(TOOLS);

    // close is a no-op and must not throw.
    await expect(conn.close()).resolves.toBeUndefined();
  });

  it('throws an McpError carrying the server code on { ok:false }', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ ok: false, error: 'failed to connect: ECONNREFUSED', code: 'connect-failed' }, 502),
    );

    await expect(serverProbeDeps.connect(CONNECTOR)).rejects.toMatchObject({
      code: 'connect-failed',
    });
    await expect(serverProbeDeps.connect(CONNECTOR)).rejects.toBeInstanceOf(McpError);
  });

  it('maps an unknown server code to connect-failed (so health classifies it as unreachable)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ ok: false, error: 'boom', code: 'stdio-unsupported' }, 400),
    );

    await expect(serverProbeDeps.connect(CONNECTOR)).rejects.toMatchObject({
      code: 'connect-failed',
    });
  });

  it('throws an McpError when the network request itself fails', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'));
    await expect(serverProbeDeps.connect(CONNECTOR)).rejects.toBeInstanceOf(McpError);
  });

  it('throws an McpError when the response is not JSON', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('<html>502</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }),
    );
    await expect(serverProbeDeps.connect(CONNECTOR)).rejects.toBeInstanceOf(McpError);
  });
});
