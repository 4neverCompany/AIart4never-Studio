/**
 * 4NE-28 — per-connector health-check tests.
 *
 * `@/lib/mcp` is mocked (mirroring tests/lib/mcp/registry.test.ts and
 * tests/lib/connectors/install.test.ts) so no test touches persistence or the
 * network. We exercise every status path, the disabled short-circuit (connect
 * NEVER called), the McpError classification, and the always-close invariant.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Real McpError so `instanceof` classification works; everything stateful is a
// spy injected via `deps`, so the registry CRUD bodies are irrelevant here.
vi.mock('@/lib/mcp', async () => {
  class McpError extends Error {
    readonly code: string;
    readonly cause?: unknown;
    constructor(code: string, message: string, cause?: unknown) {
      super(message);
      this.name = 'McpError';
      this.code = code;
      if (cause !== undefined) this.cause = cause;
      Object.setPrototypeOf(this, McpError.prototype);
    }
  }
  return {
    McpError,
    connectMcp: vi.fn(),
    listMcpTools: vi.fn(),
    listServers: vi.fn(),
  };
});

import {
  checkConnectorHealth,
  checkAllConnectors,
  type HealthDeps,
} from '@/lib/connectors/health';
import type { McpServerConfig } from '@/lib/mcp/types';
import { McpError } from '@/lib/mcp';

function cfg(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'srv-1',
    name: 'Test Server',
    transport: 'http',
    url: 'https://mcp.example.com/sse',
    enabled: true,
    trusted: true,
    addedAt: 1_700_000_000_000,
    ...over,
  };
}

/** A monotonic injected clock so latencyMs is deterministic. */
function clock(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkConnectorHealth — enabled + reachable', () => {
  it('connects, lists tools, returns ok + toolCount + latencyMs', async () => {
    const close = vi.fn(async () => {});
    const connect = vi.fn(async () => ({ client: {} as never, close }));
    const list = vi.fn(async () => [{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    // now() called: checkedAt, startedAt, then end → 1000, 1000, 1042.
    const deps: HealthDeps = { connect, list, now: clock([1000, 1000, 1042]) };

    const health = await checkConnectorHealth(cfg(), deps);

    expect(health.status).toBe('ok');
    expect(health.toolCount).toBe(3);
    expect(health.latencyMs).toBe(42);
    expect(health.checkedAt).toBe(1000);
    expect(health.id).toBe('srv-1');
    expect(connect).toHaveBeenCalledTimes(1);
    // The client is closed even on the success path.
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('checkConnectorHealth — disabled', () => {
  it("reports 'disabled' and NEVER connects", async () => {
    const connect = vi.fn();
    const list = vi.fn();
    const health = await checkConnectorHealth(cfg({ enabled: false }), {
      connect,
      list,
      now: clock([2000]),
    });

    expect(health.status).toBe('disabled');
    expect(health.checkedAt).toBe(2000);
    expect(health.toolCount).toBeUndefined();
    // The whole point: a switched-off connector is not probed.
    expect(connect).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });
});

describe('checkConnectorHealth — failure classification', () => {
  it("classifies an auth McpError as 'auth-error' and closes the client", async () => {
    const close = vi.fn(async () => {});
    // connect succeeds; listTools throws an auth error (401).
    const connect = vi.fn(async () => ({ client: {} as never, close }));
    const list = vi.fn(async () => {
      throw new McpError('list-tools-failed', 'listTools failed: HTTP 401 Unauthorized');
    });

    const health = await checkConnectorHealth(cfg(), { connect, list });

    expect(health.status).toBe('auth-error');
    expect(health.error).toContain('401');
    // Always-close invariant on the failure path.
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("classifies a transport/connect McpError as 'unreachable' and closes nothing it never opened", async () => {
    // connect itself throws a transport failure → no connection to close.
    const connect = vi.fn(async () => {
      throw new McpError('connect-failed', 'failed to connect to MCP server "Test Server": ECONNREFUSED');
    });
    const list = vi.fn();

    const health = await checkConnectorHealth(cfg(), { connect, list });

    expect(health.status).toBe('unreachable');
    expect(health.error).toContain('ECONNREFUSED');
    expect(list).not.toHaveBeenCalled();
  });

  it("closes the client when listTools throws a transport McpError ('unreachable' path)", async () => {
    const close = vi.fn(async () => {});
    const connect = vi.fn(async () => ({ client: {} as never, close }));
    const list = vi.fn(async () => {
      throw new McpError('list-tools-failed', 'listTools failed: socket hang up');
    });

    const health = await checkConnectorHealth(cfg(), { connect, list });

    expect(health.status).toBe('unreachable');
    // Client opened by connect → must be closed on the listTools-failure path.
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("classifies a non-McpError throw as generic 'error'", async () => {
    const close = vi.fn(async () => {});
    const connect = vi.fn(async () => ({ client: {} as never, close }));
    const list = vi.fn(async () => {
      throw new Error('something weird happened');
    });

    const health = await checkConnectorHealth(cfg(), { connect, list });

    expect(health.status).toBe('error');
    expect(health.error).toContain('something weird');
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('checkAllConnectors', () => {
  it('lists servers and checks each one', async () => {
    const close = vi.fn(async () => {});
    const connect = vi.fn(async () => ({ client: {} as never, close }));
    const list = vi.fn(async () => [{ name: 'only' }]);
    const listServers = vi.fn(async () => [
      cfg({ id: 'a', name: 'A', enabled: true }),
      cfg({ id: 'b', name: 'B', enabled: false }),
    ]);

    const results = await checkAllConnectors({ connect, list, listServers, now: clock([1, 1, 2, 3]) });

    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe('a');
    expect(results[0]?.status).toBe('ok');
    expect(results[1]?.id).toBe('b');
    expect(results[1]?.status).toBe('disabled');
    // Only the enabled connector was probed.
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
