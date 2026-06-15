/**
 * /api/mcp/probe route tests — the server-side MCP connect-probe primitive.
 *
 * This route fixes the public-web CORS bug: the connector add/test/health probe
 * now runs SERVER-SIDE (Node runtime) instead of in the browser. `@/lib/mcp` is
 * mocked so `connectMcp`/`listMcpTools` are fully controllable and never hit the
 * network (mirrors `tests/api/higgsfield-image.test.ts`).
 *
 * We assert:
 *   - ok path: connect → list → `{ ok:true, tools }` AND the client is closed;
 *   - connect failure → `{ ok:false }` with the right status, client never leaks;
 *   - auth-ish failure → 401;
 *   - list failure → 502 AND still closes the client;
 *   - `transport:'stdio'` → 400 with the desktop-only message, never connects;
 *   - missing/invalid config → 400, never connects;
 *   - invalid JSON body → 400;
 *   - tokens in the config never leak into the response.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mock the MCP primitive --------------------------------------------------
const connectSpy = vi.fn();
const listMcpToolsSpy = vi.fn();
const closeSpy = vi.fn();

// A minimal McpError stand-in so the route's `instanceof McpError` checks work.
// Defined INSIDE the vi.mock factory (hoisted above top-level declarations).
vi.mock('@/lib/mcp', () => {
  class McpError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'McpError';
      this.code = code;
      Object.setPrototypeOf(this, McpError.prototype);
    }
  }
  return {
    connectMcp: (...args: unknown[]) => connectSpy(...args),
    listMcpTools: (...args: unknown[]) => listMcpToolsSpy(...args),
    // The real redactConfig shape isn't exercised by the route's response, but
    // it's imported, so provide a pass-through identity.
    redactConfig: (cfg: unknown) => cfg,
    McpError,
  };
});

import { POST } from '@/app/api/mcp/probe/route';
import { McpError as FakeMcpError } from '@/lib/mcp';

const CONNECTOR = {
  id: 'notion-mcp',
  name: 'Notion MCP',
  transport: 'http' as const,
  url: 'https://mcp.notion.example/mcp',
  headers: { Authorization: 'Bearer secret-token-value-1234567890' },
  enabled: true,
  trusted: true,
  addedAt: 0,
};

const TOOLS = [
  { name: 'search', description: 'search pages' },
  { name: 'fetch_page', description: 'fetch a page' },
];

function postReq(body: unknown): Request {
  return new Request('http://x/api/mcp/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  closeSpy.mockResolvedValue(undefined);
  connectSpy.mockResolvedValue({ client: { __fake: true }, close: closeSpy });
  listMcpToolsSpy.mockResolvedValue(TOOLS);
});

describe('POST /api/mcp/probe', () => {
  it('400s on invalid JSON body, never connects', async () => {
    const res = await POST(postReq('{not json'));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(false);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('400s when config is missing, never connects', async () => {
    const res = await POST(postReq({}));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/config is required/i);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('400s a stdio connector with the desktop-only message, never connects', async () => {
    const res = await POST(postReq({ config: { ...CONNECTOR, transport: 'stdio' } }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error: string; code: string };
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/stdio connectors can't run in the hosted web; desktop only/i);
    expect(json.code).toBe('stdio-unsupported');
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('ok path: connects, lists tools, returns them, and closes the client', async () => {
    const res = await POST(postReq({ config: CONNECTOR }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; tools: typeof TOOLS };
    expect(json.ok).toBe(true);
    expect(json.tools).toEqual(TOOLS);

    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(connectSpy).toHaveBeenCalledWith(CONNECTOR);
    expect(listMcpToolsSpy).toHaveBeenCalledTimes(1);
    // ALWAYS close.
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('never leaks the bearer token into the response', async () => {
    const res = await POST(postReq({ config: CONNECTOR }));
    const text = await res.text();
    expect(text).not.toContain('secret-token-value');
  });

  it('connect failure → ok:false + 502, and never leaks a connection', async () => {
    connectSpy.mockRejectedValue(
      new FakeMcpError('connect-failed', 'failed to connect to MCP server "Notion MCP": ECONNREFUSED'),
    );
    const res = await POST(postReq({ config: CONNECTOR }));
    expect(res.status).toBe(502);
    const json = (await res.json()) as { ok: boolean; code: string; error: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('connect-failed');
    expect(json.error).toMatch(/failed to connect/i);
    // connect threw before returning a connection → nothing to close.
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('auth-ish failure → 401', async () => {
    connectSpy.mockRejectedValue(
      new FakeMcpError('connect-failed', 'failed to connect: 401 Unauthorized'),
    );
    const res = await POST(postReq({ config: CONNECTOR }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('auth-error');
  });

  it('list-tools failure → 502 AND still closes the client', async () => {
    listMcpToolsSpy.mockRejectedValue(
      new FakeMcpError('list-tools-failed', 'listTools failed: boom'),
    );
    const res = await POST(postReq({ config: CONNECTOR }));
    expect(res.status).toBe(502);
    const json = (await res.json()) as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('list-tools-failed');
    // Connected then failed to list → client still closed.
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
