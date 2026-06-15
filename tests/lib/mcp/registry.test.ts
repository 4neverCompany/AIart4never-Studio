/**
 * M2 — MCP connector registry tests.
 *
 * Persistence is mocked via `vi.mock('@/lib/persistence', ...)` with an
 * in-memory backing store (modelled on
 * tests/lib/agent-tools/persist-asset.test.ts) so the CRUD paths exercise real
 * read/modify/write logic without idb-keyval / tauri-plugin-store. The pure
 * helpers (`validateServerConfig`, `redactConfig`) are tested directly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/persistence', () => ({
  get: vi.fn(),
  set: vi.fn(),
  __resetStoreForTests: vi.fn(),
}));

import {
  MCP_SERVERS_KEY,
  listServers,
  getServer,
  saveServer,
  removeServer,
  setEnabled,
  markTrusted,
  validateServerConfig,
  redactConfig,
} from '@/lib/mcp/registry';
import type { McpServerConfig } from '@/lib/mcp/types';
import * as persistenceModule from '@/lib/persistence';

const persistenceMock = {
  get: persistenceModule.get as ReturnType<typeof vi.fn>,
  set: persistenceModule.set as ReturnType<typeof vi.fn>,
};

/** In-memory store the mocked get/set read & write, keyed like real storage. */
let store: Record<string, unknown>;

function makeServer(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'srv-1',
    name: 'Test Server',
    transport: 'http',
    url: 'https://mcp.example.com/sse',
    enabled: true,
    trusted: false,
    addedAt: 1700000000000,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  store = {};
  persistenceMock.get.mockImplementation(async (k: string) => store[k]);
  persistenceMock.set.mockImplementation(async (k: string, v: unknown) => {
    store[k] = v;
  });
});

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

describe('registry CRUD', () => {
  it('listServers returns [] when nothing stored', async () => {
    expect(await listServers()).toEqual([]);
  });

  it('listServers tolerates a non-array stored value', async () => {
    store[MCP_SERVERS_KEY] = 'corrupted';
    expect(await listServers()).toEqual([]);
  });

  it('saveServer appends a new connector and persists under the right key', async () => {
    const cfg = makeServer();
    await saveServer(cfg);
    expect(persistenceMock.set).toHaveBeenCalledWith(MCP_SERVERS_KEY, [cfg]);
    expect(await listServers()).toEqual([cfg]);
  });

  it('saveServer upserts in place when the id already exists', async () => {
    await saveServer(makeServer());
    await saveServer(makeServer({ name: 'Renamed' }));
    const all = await listServers();
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe('Renamed');
  });

  it('getServer finds by id and returns undefined when absent', async () => {
    await saveServer(makeServer());
    expect((await getServer('srv-1'))?.name).toBe('Test Server');
    expect(await getServer('nope')).toBeUndefined();
  });

  it('removeServer drops the matching connector', async () => {
    await saveServer(makeServer());
    await saveServer(makeServer({ id: 'srv-2' }));
    const next = await removeServer('srv-1');
    expect(next.map((s) => s.id)).toEqual(['srv-2']);
    expect(await getServer('srv-1')).toBeUndefined();
  });

  it('removeServer is a no-op for an unknown id', async () => {
    await saveServer(makeServer());
    const next = await removeServer('ghost');
    expect(next).toHaveLength(1);
  });

  it('setEnabled flips the flag and returns the updated config', async () => {
    await saveServer(makeServer({ enabled: true }));
    const updated = await setEnabled('srv-1', false);
    expect(updated?.enabled).toBe(false);
    expect((await getServer('srv-1'))?.enabled).toBe(false);
  });

  it('setEnabled returns undefined for an unknown id and does not write', async () => {
    await saveServer(makeServer());
    persistenceMock.set.mockClear();
    expect(await setEnabled('ghost', false)).toBeUndefined();
    expect(persistenceMock.set).not.toHaveBeenCalled();
  });

  it('markTrusted sets trusted=true (operator-confirmed trust)', async () => {
    await saveServer(makeServer({ trusted: false }));
    const updated = await markTrusted('srv-1');
    expect(updated?.trusted).toBe(true);
    expect((await getServer('srv-1'))?.trusted).toBe(true);
  });

  it('markTrusted returns undefined for an unknown id', async () => {
    expect(await markTrusted('ghost')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateServerConfig (pure)
// ---------------------------------------------------------------------------

describe('validateServerConfig', () => {
  it('accepts a valid http config', () => {
    const r = validateServerConfig(makeServer());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('accepts a valid stdio config', () => {
    const r = validateServerConfig({
      id: 'x',
      name: 'Local',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
    });
    expect(r.ok).toBe(true);
  });

  it('requires id and name', () => {
    const r = validateServerConfig({ transport: 'http', url: 'https://x.com' });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('id is required');
    expect(r.errors).toContain('name is required');
  });

  it('rejects an unknown transport', () => {
    const r = validateServerConfig({ id: 'x', name: 'n', transport: 'ftp' as never });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('transport'))).toBe(true);
  });

  it('requires a url for http transport', () => {
    const r = validateServerConfig({ id: 'x', name: 'n', transport: 'http' });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('http transport requires a url');
  });

  it('rejects an unparseable http url', () => {
    const r = validateServerConfig({ id: 'x', name: 'n', transport: 'http', url: 'not a url' });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('url is not a valid URL');
  });

  it('requires a command for stdio transport', () => {
    const r = validateServerConfig({ id: 'x', name: 'n', transport: 'stdio' });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('stdio transport requires a command');
  });
});

// ---------------------------------------------------------------------------
// redactConfig (pure)
// ---------------------------------------------------------------------------

describe('redactConfig', () => {
  it('masks secret-ish header values by key name', () => {
    const cfg = makeServer({
      headers: { Authorization: 'Bearer sk-abc', 'X-Api-Key': 'k123', Accept: 'application/json' },
    });
    const r = redactConfig(cfg);
    expect(r.headers?.Authorization).toBe('***');
    expect(r.headers?.['X-Api-Key']).toBe('***');
    // Non-secret short value is preserved.
    expect(r.headers?.Accept).toBe('application/json');
  });

  it('masks long opaque header values even with an innocuous key', () => {
    const cfg = makeServer({
      headers: { 'X-Trace': 'a'.repeat(40) },
    });
    expect(redactConfig(cfg).headers?.['X-Trace']).toBe('***');
  });

  it('masks secret-ish env values', () => {
    const cfg = makeServer({
      transport: 'stdio',
      command: 'node',
      url: undefined,
      env: { OPENAI_API_KEY: 'sk-live-xyz', LOG_LEVEL: 'debug' },
    });
    const r = redactConfig(cfg);
    expect(r.env?.OPENAI_API_KEY).toBe('***');
    expect(r.env?.LOG_LEVEL).toBe('debug');
  });

  it('does not mutate the original config', () => {
    const cfg = makeServer({ headers: { Authorization: 'Bearer secret' } });
    redactConfig(cfg);
    expect(cfg.headers?.Authorization).toBe('Bearer secret');
  });

  it('leaves a config without headers/env untouched', () => {
    const cfg = makeServer({ headers: undefined });
    expect(redactConfig(cfg)).toEqual(cfg);
  });
});
