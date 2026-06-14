/**
 * Tests for POST /api/higgsfield/oauth/reset-client.
 *
 * The route handler reads+writes the desktop config.json via
 * lib/desktop-env. We point MASHUPFORGE_CONFIG_DIR at a temp dir
 * per-test so the writes stay isolated. Two cases are meaningful:
 *   1. A client_id is cached → POST clears it, response says cleared=true.
 *   2. No client_id is cached → POST is a no-op, response says cleared=false.
 *
 * Plus a sanity check that the route can be called twice without
 * throwing (idempotency is part of the contract).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mashupforge-reset-client-'));
  process.env.MASHUPFORGE_CONFIG_DIR = tempDir;
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  delete process.env.MASHUPFORGE_CONFIG_DIR;
});

describe('POST /api/higgsfield/oauth/reset-client', () => {
  it('clears a previously cached client_id and reports cleared=true', async () => {
    // Seed config.json with a fake client_id.
    writeFileSync(
      join(tempDir, 'config.json'),
      JSON.stringify({ HIGGSFIELD_OAUTH_CLIENT_ID: 'cached-client-123' }, null, 2),
      'utf8',
    );

    const { POST } = await import('@/app/api/higgsfield/oauth/reset-client/route');
    const res = await POST();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; cleared: boolean };
    expect(body.ok).toBe(true);
    expect(body.cleared).toBe(true);

    // The key must be gone from the file (empty-string-write == delete).
    const after = JSON.parse(readFileSync(join(tempDir, 'config.json'), 'utf8'));
    expect(after.HIGGSFIELD_OAUTH_CLIENT_ID).toBeUndefined();
  });

  it('is a no-op when no client_id is cached and reports cleared=false', async () => {
    // Empty config.json.
    writeFileSync(join(tempDir, 'config.json'), '{}', 'utf8');

    const { POST } = await import('@/app/api/higgsfield/oauth/reset-client/route');
    const res = await POST();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; cleared: boolean };
    expect(body.ok).toBe(true);
    expect(body.cleared).toBe(false);
  });

  it('is idempotent: calling twice does not throw and stays 200', async () => {
    writeFileSync(
      join(tempDir, 'config.json'),
      JSON.stringify({ HIGGSFIELD_OAUTH_CLIENT_ID: 'cached-client-456' }, null, 2),
      'utf8',
    );

    const { POST } = await import('@/app/api/higgsfield/oauth/reset-client/route');
    const first = await POST();
    expect(first.status).toBe(200);
    const second = await POST();
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { cleared: boolean };
    // Second call has nothing to clear.
    expect(secondBody.cleared).toBe(false);
  });

  it('preserves unrelated keys in config.json', async () => {
    // The route must not nuke sibling keys when it deletes one.
    writeFileSync(
      join(tempDir, 'config.json'),
      JSON.stringify(
        {
          HIGGSFIELD_OAUTH_CLIENT_ID: 'cached-client-789',
          LEONARDO_API_KEY: 'leon-xyz',
          ANOTHER_SETTING: '42',
        },
        null,
        2,
      ),
      'utf8',
    );

    const { POST } = await import('@/app/api/higgsfield/oauth/reset-client/route');
    const res = await POST();
    expect(res.status).toBe(200);

    const after = JSON.parse(readFileSync(join(tempDir, 'config.json'), 'utf8'));
    expect(after.HIGGSFIELD_OAUTH_CLIENT_ID).toBeUndefined();
    expect(after.LEONARDO_API_KEY).toBe('leon-xyz');
    expect(after.ANOTHER_SETTING).toBe('42');
  });
});
