/**
 * M2 — MCP client wrapper tests.
 *
 * The MCP SDK is mocked at its import specifiers so the tests never hit the
 * network: `@modelcontextprotocol/sdk/client/index.js` (the `Client`) and
 * `@modelcontextprotocol/sdk/client/streamableHttp.js` (the transport). We
 * assert that:
 *   - connectMcp builds a StreamableHTTP transport from the http config
 *     (url + headers) and calls client.connect with it,
 *   - stdio throws a clear `not-yet-supported` McpError,
 *   - listMcpTools maps the SDK tool shape to McpToolInfo,
 *   - callMcpTool forwards { name, arguments }, returns content, and surfaces
 *     both thrown errors and `isError: true` results as McpError.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- SDK mocks --------------------------------------------------------------
// Spies the constructors capture so assertions can inspect ctor args.
const connectSpy = vi.fn();
const closeSpy = vi.fn();
const listToolsSpy = vi.fn();
const callToolSpy = vi.fn();
const clientCtorSpy = vi.fn();
const transportCtorSpy = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = connectSpy;
    close = closeSpy;
    listTools = listToolsSpy;
    callTool = callToolSpy;
    constructor(info: unknown, opts: unknown) {
      clientCtorSpy(info, opts);
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    __kind = 'streamable-http-transport';
    url: URL;
    opts: unknown;
    constructor(url: URL, opts: unknown) {
      transportCtorSpy(url, opts);
      this.url = url;
      this.opts = opts;
    }
  },
}));

import {
  connectMcp,
  listMcpTools,
  callMcpTool,
  buildHeaders,
  McpError,
} from '@/lib/mcp/client';
import type { McpServerConfig } from '@/lib/mcp/types';

function httpCfg(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'srv-1',
    name: 'Example',
    transport: 'http',
    url: 'https://mcp.example.com/sse',
    headers: { Authorization: 'Bearer tok' },
    enabled: true,
    trusted: false,
    addedAt: 1700000000000,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  connectSpy.mockResolvedValue(undefined);
  closeSpy.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// connectMcp
// ---------------------------------------------------------------------------

describe('connectMcp', () => {
  it('builds a StreamableHTTP transport from url + headers and connects', async () => {
    const { client, close } = await connectMcp(httpCfg());

    // Transport ctor got a URL and the headers via requestInit.
    expect(transportCtorSpy).toHaveBeenCalledTimes(1);
    const [urlArg, optsArg] = transportCtorSpy.mock.calls[0]!;
    expect(urlArg).toBeInstanceOf(URL);
    expect((urlArg as URL).href).toBe('https://mcp.example.com/sse');
    expect(optsArg).toEqual({ requestInit: { headers: { Authorization: 'Bearer tok' } } });

    // Client.connect was handed the transport instance.
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(connectSpy.mock.calls[0]![0]).toMatchObject({ __kind: 'streamable-http-transport' });

    expect(client).toBeDefined();
    expect(typeof close).toBe('function');
  });

  it('omits requestInit when no headers are configured', async () => {
    await connectMcp(httpCfg({ headers: undefined }));
    const [, optsArg] = transportCtorSpy.mock.calls[0]!;
    expect(optsArg).toEqual({ requestInit: undefined });
  });

  it('forwards an AbortSignal to client.connect', async () => {
    const ctrl = new AbortController();
    await connectMcp(httpCfg(), { signal: ctrl.signal });
    expect(connectSpy.mock.calls[0]![1]).toEqual({ signal: ctrl.signal });
  });

  it('throws a not-yet-supported McpError for stdio transport', async () => {
    await expect(
      connectMcp(httpCfg({ transport: 'stdio', command: 'node', url: undefined })),
    ).rejects.toMatchObject({ code: 'not-yet-supported' });
    // Never even touched the transport/client for stdio.
    expect(transportCtorSpy).not.toHaveBeenCalled();
  });

  it('throws connect-failed for an http config with no url', async () => {
    await expect(
      connectMcp(httpCfg({ url: undefined })),
    ).rejects.toMatchObject({ code: 'connect-failed' });
  });

  it('throws connect-failed for an invalid url', async () => {
    await expect(
      connectMcp(httpCfg({ url: 'not a url' })),
    ).rejects.toMatchObject({ code: 'connect-failed' });
  });

  it('wraps a connect failure as McpError and closes the half-open client', async () => {
    connectSpy.mockRejectedValueOnce(new Error('handshake refused'));
    await expect(connectMcp(httpCfg())).rejects.toMatchObject({ code: 'connect-failed' });
    expect(closeSpy).toHaveBeenCalled(); // best-effort cleanup
  });

  it('close() delegates to client.close()', async () => {
    const { close } = await connectMcp(httpCfg());
    await close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('sends oauth.accessToken as an Authorization: Bearer header', async () => {
    await connectMcp(
      httpCfg({
        headers: undefined,
        oauth: { accessToken: 'oauth-access-token' },
      }),
    );
    const [, optsArg] = transportCtorSpy.mock.calls[0]!;
    expect(optsArg).toEqual({
      requestInit: { headers: { Authorization: 'Bearer oauth-access-token' } },
    });
  });

  it('keeps an explicit Authorization header over the oauth bearer (Composio path unchanged)', async () => {
    await connectMcp(
      httpCfg({
        headers: { Authorization: 'Bearer static-key', 'x-api-key': 'composio' },
        oauth: { accessToken: 'oauth-access-token' },
      }),
    );
    const [, optsArg] = transportCtorSpy.mock.calls[0]! as [unknown, { requestInit: { headers: Record<string, string> } }];
    expect(optsArg.requestInit.headers.Authorization).toBe('Bearer static-key');
    expect(optsArg.requestInit.headers['x-api-key']).toBe('composio');
  });
});

// ---------------------------------------------------------------------------
// buildHeaders (pure)
// ---------------------------------------------------------------------------

describe('buildHeaders', () => {
  it('returns undefined when there are no headers and no oauth', () => {
    expect(buildHeaders(httpCfg({ headers: undefined }))).toBeUndefined();
  });

  it('synthesises a Bearer from oauth.accessToken when no Authorization header exists', () => {
    const h = buildHeaders(httpCfg({ headers: { Accept: 'application/json' }, oauth: { accessToken: 'tok' } }));
    expect(h).toEqual({ Accept: 'application/json', Authorization: 'Bearer tok' });
  });

  it('never clobbers an existing Authorization header (case-insensitive)', () => {
    const h = buildHeaders(httpCfg({ headers: { authorization: 'Bearer static' }, oauth: { accessToken: 'tok' } }));
    // The lowercase static header is preserved; no second Authorization added.
    const authKeys = Object.keys(h ?? {}).filter((k) => k.toLowerCase() === 'authorization');
    expect(authKeys).toEqual(['authorization']);
    expect(h?.authorization).toBe('Bearer static');
  });
});

// ---------------------------------------------------------------------------
// listMcpTools
// ---------------------------------------------------------------------------

describe('listMcpTools', () => {
  it('maps the SDK tool shape to McpToolInfo', async () => {
    listToolsSpy.mockResolvedValue({
      tools: [
        { name: 'generate_image', description: 'make art', inputSchema: { type: 'object' }, extra: 'dropped' },
        { name: 'noop' },
      ],
    });
    const { client } = await connectMcp(httpCfg());
    const tools = await listMcpTools(client);
    expect(tools).toEqual([
      { name: 'generate_image', description: 'make art', inputSchema: { type: 'object' } },
      { name: 'noop', description: undefined, inputSchema: undefined },
    ]);
  });

  it('returns [] when the server has no tools array', async () => {
    listToolsSpy.mockResolvedValue({});
    const { client } = await connectMcp(httpCfg());
    expect(await listMcpTools(client)).toEqual([]);
  });

  it('wraps a listTools throw as list-tools-failed McpError', async () => {
    listToolsSpy.mockRejectedValue(new Error('boom'));
    const { client } = await connectMcp(httpCfg());
    await expect(listMcpTools(client)).rejects.toMatchObject({ code: 'list-tools-failed' });
  });
});

// ---------------------------------------------------------------------------
// callMcpTool
// ---------------------------------------------------------------------------

describe('callMcpTool', () => {
  it('forwards { name, arguments } and returns the content array', async () => {
    callToolSpy.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const { client } = await connectMcp(httpCfg());
    const out = await callMcpTool(client, 'generate_image', { prompt: 'cat' });
    expect(callToolSpy).toHaveBeenCalledWith({ name: 'generate_image', arguments: { prompt: 'cat' } });
    expect(out).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('returns the whole result for the compatibility { toolResult } shape', async () => {
    callToolSpy.mockResolvedValue({ toolResult: 42 });
    const { client } = await connectMcp(httpCfg());
    expect(await callMcpTool(client, 't', {})).toEqual({ toolResult: 42 });
  });

  it('throws tool-error when the result has isError: true', async () => {
    callToolSpy.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'nope' }] });
    const { client } = await connectMcp(httpCfg());
    await expect(callMcpTool(client, 't', {})).rejects.toMatchObject({ code: 'tool-error' });
  });

  it('wraps a callTool throw as call-tool-failed McpError', async () => {
    callToolSpy.mockRejectedValue(new Error('network'));
    const { client } = await connectMcp(httpCfg());
    await expect(callMcpTool(client, 't', {})).rejects.toMatchObject({ code: 'call-tool-failed' });
  });

  it('surfaces a McpError instance (not a bare Error)', async () => {
    callToolSpy.mockRejectedValue(new Error('x'));
    const { client } = await connectMcp(httpCfg());
    await expect(callMcpTool(client, 't', {})).rejects.toBeInstanceOf(McpError);
  });
});
