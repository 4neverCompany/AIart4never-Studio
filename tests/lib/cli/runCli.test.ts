/**
 * 4NE-13 — headless CLI core tests.
 *
 * Every dependency is injected (no real LLM / network / storage). We assert key
 * output lines + exit codes per command, the publish-safety invariant (CliDeps
 * has NO publish function — stated and structurally enforced), and the
 * connector add/remove gating (`--yes` mints a token + installs; without it,
 * confirmAndInstall is never called).
 */
import { describe, it, expect, vi } from 'vitest';

import { runCli, type CliDeps } from '@/lib/cli';
import type { AutonomyConfig, AutonomyTickResult } from '@/lib/autonomy';
import { buildWeeklyContentPlan } from '@/lib/canon/content-plan';
import { canonTags } from '@/lib/canon/content-plan';
import type { ConnectorHealth } from '@/lib/connectors/health';
import type { ConnectorProposal } from '@/lib/connectors';
import type { McpServerConfig } from '@/lib/mcp';
import type { ApprovalToken } from '@/lib/approval';
import type { GeneratedImage } from '@/types/mashup';

const CFG: AutonomyConfig = {
  enabled: true,
  cadence: 'daily',
  activeCharacterId: 'kael',
  dailyBudgetUsd: 0.5,
  tickHourLocal: 9,
};

function srv(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'higgsfield',
    name: 'Higgsfield',
    transport: 'http',
    url: 'https://mcp.higgsfield.ai/sse',
    headers: { Authorization: 'Bearer sk-secret' },
    enabled: true,
    trusted: true,
    addedAt: 1,
    ...over,
  };
}

function health(over: Partial<ConnectorHealth> = {}): ConnectorHealth {
  return { id: 'higgsfield', name: 'Higgsfield', status: 'ok', toolCount: 12, latencyMs: 30, checkedAt: 1, ...over };
}

const FAKE_TOKEN: ApprovalToken = { kind: 'connector-activate', requestHash: 'h', grantedAt: 1, scope: 'x' };

/** A deps object whose every fn is a controllable spy, with sane defaults. */
function makeDeps(over: Partial<CliDeps> = {}): CliDeps {
  return {
    now: () => new Date(2026, 5, 19, 9, 0, 0, 0), // Friday (story-beat / generate)
    loadAutonomyConfig: vi.fn(async () => CFG),
    loadLibrary: vi.fn(async () => [] as GeneratedImage[]),
    runDirector: vi.fn(async () => {
      throw new Error('director should be injected per-test');
    }),
    persistAsset: vi.fn(async () => ({ assetId: 'image-x' })),
    runTick: vi.fn(async (): Promise<AutonomyTickResult> => ({
      at: 1,
      day: 'fri',
      pillarId: 'story-beat',
      decision: 'generate',
      assetId: 'image-gen-1',
      queued: true,
      note: 'generated + queued image for Story-Beat (story-beat)',
    })),
    buildPlan: (input) => buildWeeklyContentPlan(input),
    readQuota: vi.fn(async () => ({ tokensUsed: 1_250_000_000, allowance: 12_500_000_000, summary: '1.25B / 12.50B tokens this month (10%)' })),
    readBudget: vi.fn(async () => ({ dailyBudgetUsd: 0.5, creditsUsed: 40, creditCap: 200 })),
    readJournal: vi.fn(async () => [] as AutonomyTickResult[]),
    listServers: vi.fn(async () => [srv()]),
    redactConfig: vi.fn((c: McpServerConfig) => ({ ...c, headers: c.headers ? { Authorization: '***' } : undefined })),
    checkAllConnectors: vi.fn(async () => [health()]),
    checkConnectorHealth: vi.fn(async () => health()),
    proposeConnector: vi.fn(
      (input): ConnectorProposal => ({
        config: {
          id: 'new-mcp',
          name: input.name,
          transport: 'http',
          url: input.url,
          headers: input.headers,
          enabled: false,
          trusted: false,
          addedAt: 0,
        },
        redactedView: {
          id: 'new-mcp',
          name: input.name,
          transport: 'http',
          url: input.url,
          headers: input.headers ? { Authorization: '***' } : undefined,
          enabled: false,
          trusted: false,
          addedAt: 0,
        },
        warnings: [],
      }),
    ),
    confirmAndInstall: vi.fn(async () => ({ ok: true as const, server: srv({ id: 'new-mcp', name: 'New MCP' }), tools: [{ name: 't1' }, { name: 't2' }] })),
    uninstallConnector: vi.fn(async () => []),
    confirm: (yes: boolean) => ({ approved: yes, mintToken: vi.fn(async () => FAKE_TOKEN) }),
    ...over,
  };
}

describe('runCli — help / unknown', () => {
  it('--help → usage, exit 0', async () => {
    const r = await runCli(['--help'], makeDeps());
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toContain('Usage:');
  });

  it('no args → usage, exit 0', async () => {
    const r = await runCli([], makeDeps());
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toContain('aiart4never');
  });

  it('unknown command → usage, exit 2', async () => {
    const r = await runCli(['frobnicate'], makeDeps());
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).toContain("unknown command 'frobnicate'");
  });
});

describe('runCli — run-beat', () => {
  it('runs one tick and prints the approval-queue line (generate day)', async () => {
    const runTick = vi.fn(async (): Promise<AutonomyTickResult> => ({
      at: 1,
      day: 'fri',
      pillarId: 'story-beat',
      decision: 'generate',
      assetId: 'image-gen-1',
      queued: true,
      note: 'generated + queued image for Story-Beat (story-beat)',
    }));
    const r = await runCli(['run-beat'], makeDeps({ runTick }));

    expect(r.code).toBe(0);
    expect(runTick).toHaveBeenCalledTimes(1);
    const out = r.lines.join('\n');
    expect(out).toContain('decision: generate');
    expect(out).toContain('queued asset: image-gen-1');
    expect(out.toLowerCase()).toContain('approval queue');
    expect(out.toLowerCase()).toContain('never published');
  });

  it('run-beat threads the injected director + persist into the tick deps', async () => {
    const runDirector = vi.fn(async () => {
      throw new Error('unused');
    });
    const persistAsset = vi.fn(async () => ({ assetId: 'image-x' }));
    const runTick = vi.fn(async (_cfg, tickDeps): Promise<AutonomyTickResult> => {
      // The CLI must hand the director + persist into the tick deps so generation
      // is gated by the director's own HIL (no separate generation path).
      expect(tickDeps.runDirector).toBe(runDirector);
      expect(tickDeps.persistAsset).toBe(persistAsset);
      return { at: 1, day: 'fri', decision: 'skip', queued: false, note: 'n' };
    });
    await runCli(['run-beat'], makeDeps({ runDirector, persistAsset, runTick }));
    expect(runTick).toHaveBeenCalledTimes(1);
  });

  it('--character validates the id (unknown → exit 2)', async () => {
    const r = await runCli(['run-beat', '--character', 'nope'], makeDeps());
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).toContain("unknown character 'nope'");
  });

  it('an errored tick → exit 1', async () => {
    const runTick = vi.fn(async (): Promise<AutonomyTickResult> => ({
      at: 1, day: 'fri', decision: 'skip', queued: false, note: 'autonomy tick failed', error: 'boom',
    }));
    const r = await runCli(['run-beat'], makeDeps({ runTick }));
    expect(r.code).toBe(1);
    expect(r.lines.join('\n')).toContain('error: boom');
  });
});

describe('runCli — run-week', () => {
  it('prints each slot + a credit estimate (reuse names the asset)', async () => {
    // A library with a kael+variant-reveal asset so Monday reuses it by name.
    const lib: GeneratedImage[] = [
      { id: 'reuse-me', url: 'u', prompt: 'p', tags: canonTags('kael', 'variant-reveal'), savedAt: 1 },
    ];
    const r = await runCli(['run-week'], makeDeps({ loadLibrary: vi.fn(async () => lib) }));
    expect(r.code).toBe(0);
    const out = r.lines.join('\n');
    expect(out).toContain('Weekly content plan');
    expect(out).toContain('fri'); // the guaranteed-new-gen story beat
    expect(out).toContain('credit estimate:');
    // reuse slot names the concrete library asset id.
    expect(out).toContain('reuse reuse-me');
  });

  it('--execute does NOT spend (prints the safe-stub notice)', async () => {
    const r = await runCli(['run-week', '--execute'], makeDeps());
    expect(r.code).toBe(0);
    const out = r.lines.join('\n');
    expect(out).toContain('--execute: not run');
    expect(out.toLowerCase()).toContain('spends credits');
  });
});

describe('runCli — status', () => {
  it('prints quota, budget ceiling, connector health, and recent ticks', async () => {
    const journal: AutonomyTickResult[] = [
      { at: 2, day: 'fri', decision: 'generate', queued: true, note: 'queued image' },
    ];
    const r = await runCli(['status'], makeDeps({ readJournal: vi.fn(async () => journal) }));
    expect(r.code).toBe(0);
    const out = r.lines.join('\n');
    expect(out).toContain('MiniMax quota: 1.25B');
    expect(out).toContain('Autonomy daily budget: $0.50');
    expect(out).toContain('Higgsfield credits: 40 / 200');
    expect(out).toContain('Connectors: 1 total');
    expect(out).toContain('[ok] Higgsfield');
    expect(out).toContain('Recent ticks:');
    expect(out).toContain('queued image');
  });

  it('reports quota "unavailable" when no quota source', async () => {
    const r = await runCli(['status'], makeDeps({ readQuota: vi.fn(async () => null) }));
    expect(r.lines.join('\n')).toContain('MiniMax quota: unavailable');
  });
});

describe('runCli — connectors list / test', () => {
  it('connectors list shows redacted rows + health', async () => {
    const redactConfig = vi.fn((c: McpServerConfig) => ({ ...c, headers: { Authorization: '***' } }));
    const r = await runCli(['connectors', 'list'], makeDeps({ redactConfig }));
    expect(r.code).toBe(0);
    expect(redactConfig).toHaveBeenCalled();
    const out = r.lines.join('\n');
    expect(out).toContain('higgsfield — Higgsfield');
    expect(out).toContain('[ok] Higgsfield');
    // No raw secret leaks into the output.
    expect(out).not.toContain('sk-secret');
  });

  it('connectors test <id> checks one connector', async () => {
    const checkConnectorHealth = vi.fn(async () => health({ status: 'auth-error', error: 'HTTP 401' }));
    const r = await runCli(['connectors', 'test', 'higgsfield'], makeDeps({ checkConnectorHealth }));
    expect(r.code).toBe(0);
    expect(checkConnectorHealth).toHaveBeenCalledTimes(1);
    expect(r.lines.join('\n')).toContain('[auth-error]');
  });

  it('connectors test with an unknown id → exit 1', async () => {
    const r = await runCli(['connectors', 'test', 'ghost'], makeDeps());
    expect(r.code).toBe(1);
    expect(r.lines.join('\n')).toContain("no connector with id 'ghost'");
  });

  it('connectors test with no id → exit 2', async () => {
    const r = await runCli(['connectors', 'test'], makeDeps());
    expect(r.code).toBe(2);
  });
});

describe('runCli — connectors add (FR-22 gating)', () => {
  it('without --yes prints the redacted proposal and does NOT install', async () => {
    const confirmAndInstall = vi.fn();
    const proposeConnector = makeDeps().proposeConnector;
    const r = await runCli(
      ['connectors', 'add', '--name', 'New MCP', '--url', 'https://new.example/sse', '--header', 'Authorization=Bearer sk-xyz'],
      makeDeps({ confirmAndInstall, proposeConnector }),
    );
    expect(r.code).toBe(0);
    const out = r.lines.join('\n');
    expect(out).toContain('Proposed connector');
    expect(out).toContain('re-run with --yes to install');
    // The whole point: no install without --yes.
    expect(confirmAndInstall).not.toHaveBeenCalled();
    // Secret never leaks (redacted view only).
    expect(out).not.toContain('sk-xyz');
  });

  it('with --yes mints a token and installs', async () => {
    const mintToken = vi.fn(async () => FAKE_TOKEN);
    const confirmAndInstall = vi.fn<CliDeps['confirmAndInstall']>(async () => ({
      ok: true as const,
      server: srv({ id: 'new-mcp', name: 'New MCP' }),
      tools: [{ name: 't1' }, { name: 't2' }],
    }));
    const confirm = (yes: boolean) => ({ approved: yes, mintToken });

    const r = await runCli(
      ['connectors', 'add', '--name', 'New MCP', '--url', 'https://new.example/sse', '--yes'],
      makeDeps({ confirm, confirmAndInstall }),
    );
    expect(r.code).toBe(0);
    expect(mintToken).toHaveBeenCalledTimes(1);
    expect(confirmAndInstall).toHaveBeenCalledTimes(1);
    // The token minted is the one passed to confirmAndInstall.
    expect(confirmAndInstall.mock.calls[0]![1]).toBe(FAKE_TOKEN);
    expect(r.lines.join('\n')).toContain('installed:');
  });

  it('add without --name/--url → exit 2', async () => {
    const r = await runCli(['connectors', 'add', '--url', 'https://x.example/sse'], makeDeps());
    expect(r.code).toBe(2);
  });
});

describe('runCli — connectors remove (gating)', () => {
  it('without --yes does NOT remove', async () => {
    const uninstallConnector = vi.fn(async () => []);
    const r = await runCli(['connectors', 'remove', 'higgsfield'], makeDeps({ uninstallConnector }));
    expect(r.code).toBe(0);
    expect(uninstallConnector).not.toHaveBeenCalled();
    expect(r.lines.join('\n')).toContain('re-run with --yes');
  });

  it('with --yes removes', async () => {
    const uninstallConnector = vi.fn(async () => []);
    const r = await runCli(['connectors', 'remove', 'higgsfield', '--yes'], makeDeps({ uninstallConnector }));
    expect(r.code).toBe(0);
    expect(uninstallConnector).toHaveBeenCalledWith('higgsfield');
    expect(r.lines.join('\n')).toContain("Removed connector 'higgsfield'");
  });
});

// ---------------------------------------------------------------------------
// PROOF: the CLI can NEVER publish.
// ---------------------------------------------------------------------------
describe('publish-safety invariant', () => {
  it('CliDeps has no publish function (the CLI cannot publish)', () => {
    // The absence is the proof: build the full real-shaped deps and assert there
    // is no key that looks like a publish hook. run-beat exercises the whole
    // generate path through runTick → persistAsset (approved:false), never publish.
    const deps = makeDeps();
    const keys = Object.keys(deps);
    expect(keys.some((k) => /publish/i.test(k))).toBe(false);
    // The deps that DO exist are queue/registry/read-only — none publishes.
    expect(keys).toContain('persistAsset');
    expect(keys).not.toContain('publish');
    expect(keys).not.toContain('dispatchPublish');
  });

  it('the cli source imports nothing from lib/publish', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(process.cwd(), 'lib/cli/index.ts'), 'utf8');
    const importLines = src
      .split('\n')
      .filter((l) => /^\s*import\b/.test(l) || /\bimport\s*\(/.test(l) || /\brequire\s*\(/.test(l));
    for (const line of importLines) {
      expect(line).not.toMatch(/publish/);
    }
    expect(src).not.toMatch(/from\s+['"][^'"]*lib\/publish/);
  });
});
