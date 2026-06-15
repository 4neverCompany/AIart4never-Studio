/**
 * M2 — FR-22 agentic-install flow tests.
 *
 * `@/lib/mcp` (both the registry CRUD and the client wrapper) is mocked with
 * `vi.mock`, mirroring the pattern in tests/lib/mcp/registry.test.ts, so no
 * test touches persistence or the network. We assert the two FR-22 guarantees
 * directly: the operator-source guard, and trust-only-on-confirmed-probe.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the whole `@/lib/mcp` surface. `redactConfig` and `validateServerConfig`
// keep real-ish behaviour so the proposal assertions exercise true logic;
// everything stateful is a spy we inject via `deps` anyway.
vi.mock('@/lib/mcp', () => {
  return {
    saveServer: vi.fn(),
    removeServer: vi.fn(),
    markTrusted: vi.fn(),
    setEnabled: vi.fn(),
    connectMcp: vi.fn(),
    listMcpTools: vi.fn(),
    validateServerConfig: vi.fn((cfg: { id?: string; name?: string; transport?: string; url?: string; command?: string }) => {
      const errors: string[] = [];
      if (!cfg.id) errors.push('id is required');
      if (!cfg.name) errors.push('name is required');
      if (cfg.transport !== 'http' && cfg.transport !== 'stdio') errors.push('transport invalid');
      if (cfg.transport === 'http' && !cfg.url) errors.push('http transport requires a url');
      if (cfg.transport === 'stdio' && !cfg.command) errors.push('stdio transport requires a command');
      return { ok: errors.length === 0, errors };
    }),
    redactConfig: vi.fn((cfg: { headers?: Record<string, string>; env?: Record<string, string> } & Record<string, unknown>) => {
      const out = { ...cfg };
      const mask = (rec?: Record<string, string>) => {
        if (!rec) return rec;
        const m: Record<string, string> = {};
        for (const [k, v] of Object.entries(rec)) {
          m[k] = /authorization|token|key|secret/i.test(k) ? '***' : v;
        }
        return m;
      };
      if (cfg.headers) out.headers = mask(cfg.headers);
      if (cfg.env) out.env = mask(cfg.env);
      return out;
    }),
  };
});

import {
  proposeConnector,
  confirmAndInstall,
  uninstallConnector,
  slugifyName,
  ApprovalRequiredError,
  buildConnectorActivateRequest,
  type ProposeConnectorInput,
} from '@/lib/connectors/install';
import type { ConnectorProposal } from '@/lib/connectors/types';
import { requestApproval } from '@/lib/approval';
import type { ApprovalToken } from '@/lib/approval';
import * as mcp from '@/lib/mcp';

const mocks = {
  saveServer: mcp.saveServer as ReturnType<typeof vi.fn>,
  removeServer: mcp.removeServer as ReturnType<typeof vi.fn>,
  markTrusted: mcp.markTrusted as ReturnType<typeof vi.fn>,
  setEnabled: mcp.setEnabled as ReturnType<typeof vi.fn>,
  connectMcp: mcp.connectMcp as ReturnType<typeof vi.fn>,
  listMcpTools: mcp.listMcpTools as ReturnType<typeof vi.fn>,
};

function operatorInput(over: Partial<ProposeConnectorInput> = {}): ProposeConnectorInput {
  return {
    source: 'operator',
    name: 'Example MCP',
    transport: 'http',
    url: 'https://mcp.example.com/sse',
    headers: { Authorization: 'Bearer sk-super-secret-token', Accept: 'application/json' },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// proposeConnector — FR-22 source guard + redacted view
// ---------------------------------------------------------------------------

describe('proposeConnector', () => {
  it('FR-22: throws when source is not "operator"', () => {
    const bad = { ...operatorInput(), source: 'scraped' } as unknown as ProposeConnectorInput;
    expect(() => proposeConnector(bad)).toThrow(/FR-22/);
  });

  it('FR-22: throws for a missing/undefined source too', () => {
    const bad = { name: 'x', transport: 'http', url: 'https://x.com' } as unknown as ProposeConnectorInput;
    expect(() => proposeConnector(bad)).toThrow(/operator/);
  });

  it('returns a config that is untrusted and disabled', () => {
    const p = proposeConnector(operatorInput());
    expect(p.config.trusted).toBe(false);
    expect(p.config.enabled).toBe(false);
  });

  it('derives a slug id from the name', () => {
    const p = proposeConnector(operatorInput({ name: 'My Cool Server!!' }));
    expect(p.config.id).toBe('my-cool-server');
  });

  it('stamps addedAt from the injected now (deterministic)', () => {
    const p = proposeConnector(operatorInput(), 1234);
    expect(p.config.addedAt).toBe(1234);
  });

  it('redactedView masks the secret Authorization header (raw config keeps it)', () => {
    const p = proposeConnector(operatorInput());
    expect(p.redactedView.headers?.Authorization).toBe('***');
    // Non-secret header preserved.
    expect(p.redactedView.headers?.Accept).toBe('application/json');
    // Raw config still carries the real secret (needed to actually connect).
    expect(p.config.headers?.Authorization).toBe('Bearer sk-super-secret-token');
  });

  it('warns about plain-http urls', () => {
    const p = proposeConnector(operatorInput({ url: 'http://insecure.example.com/sse' }));
    expect(p.warnings.some((w) => /http/.test(w))).toBe(true);
  });

  it('throws when the derived config is structurally invalid', () => {
    expect(() => proposeConnector(operatorInput({ transport: 'http', url: undefined }))).toThrow(
      /invalid connector config/,
    );
  });
});

// ---------------------------------------------------------------------------
// confirmAndInstall — trust ONLY on a successful operator-confirmed probe
// ---------------------------------------------------------------------------

describe('confirmAndInstall', () => {
  function proposalFixture(): ConnectorProposal {
    return proposeConnector(operatorInput(), 1000);
  }

  /**
   * Mint a REAL `connector-activate` token for a proposal's config via the
   * unified chokepoint, using an auto-approving operator stub. This is exactly
   * how a production caller obtains the token before activation.
   */
  async function tokenFor(proposal: ConnectorProposal): Promise<ApprovalToken> {
    const decision = await requestApproval(
      buildConnectorActivateRequest(proposal.config),
      { askOperator: async () => ({ verdict: 'approved' }) },
    );
    if (!decision.token) throw new Error('test setup: expected an approval token');
    return decision.token;
  }

  it('on a successful probe: saves, lists tools, then markTrusted + setEnabled(true)', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const fakeClient = { id: 'client' };
    mocks.connectMcp.mockResolvedValue({ client: fakeClient, close });
    mocks.listMcpTools.mockResolvedValue([{ name: 'do_thing' }, { name: 'other' }]);
    mocks.setEnabled.mockImplementation(async (id: string, on: boolean) => ({
      id,
      name: 'Example MCP',
      transport: 'http',
      url: 'https://mcp.example.com/sse',
      enabled: on,
      trusted: true,
      addedAt: 1000,
    }));

    const proposal = proposalFixture();
    const outcome = await confirmAndInstall(proposal, await tokenFor(proposal));

    // (1) persisted first, untrusted + disabled
    expect(mocks.saveServer).toHaveBeenCalledTimes(1);
    const persisted = mocks.saveServer.mock.calls[0][0];
    expect(persisted.trusted).toBe(false);
    expect(persisted.enabled).toBe(false);

    // (2) probed
    expect(mocks.connectMcp).toHaveBeenCalledTimes(1);
    expect(mocks.listMcpTools).toHaveBeenCalledWith(fakeClient);

    // (3) trust + activation, in that order
    expect(mocks.markTrusted).toHaveBeenCalledWith(proposal.config.id);
    expect(mocks.setEnabled).toHaveBeenCalledWith(proposal.config.id, true);

    // outcome
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.tools.map((t) => t.name)).toEqual(['do_thing', 'other']);
      expect(outcome.server.trusted).toBe(true);
      expect(outcome.server.enabled).toBe(true);
    }

    // probe client always closed
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('on a probe that throws: does NOT enable/trust, returns {ok:false, stage:"probe"}, closes client', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.connectMcp.mockResolvedValue({ client: {}, close });
    mocks.listMcpTools.mockRejectedValue(new Error('handshake failed'));

    const proposal = proposalFixture();
    const outcome = await confirmAndInstall(proposal, await tokenFor(proposal));

    // saved (still disabled/untrusted) but NOT trusted/enabled
    expect(mocks.saveServer).toHaveBeenCalledTimes(1);
    expect(mocks.markTrusted).not.toHaveBeenCalled();
    expect(mocks.setEnabled).not.toHaveBeenCalled();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.stage).toBe('probe');
      expect(outcome.error).toBeInstanceOf(Error);
    }

    // client closed even on failure
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('when connect itself throws: stage is "probe", no trust/enable, no client to close', async () => {
    mocks.connectMcp.mockRejectedValue(new Error('connect-failed'));

    const proposal = proposalFixture();
    const outcome = await confirmAndInstall(proposal, await tokenFor(proposal));

    expect(mocks.markTrusted).not.toHaveBeenCalled();
    expect(mocks.setEnabled).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.stage).toBe('probe');
  });

  it('when saveServer throws: stage is "validate" and no probe is attempted', async () => {
    mocks.saveServer.mockRejectedValue(new Error('storage down'));

    const proposal = proposalFixture();
    const outcome = await confirmAndInstall(proposal, await tokenFor(proposal));

    expect(mocks.connectMcp).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.stage).toBe('validate');
  });

  it('4NE-26: a MISSING token returns {ok:false, stage:"validate"} and does NOT save/probe/enable', async () => {
    const proposal = proposalFixture();
    const outcome = await confirmAndInstall(
      proposal,
      // No valid token (simulate a bypass attempt).
      undefined as unknown as ApprovalToken,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.stage).toBe('validate');
      expect(outcome.error).toBeInstanceOf(ApprovalRequiredError);
    }
    // Fail-closed BEFORE any side effect: nothing persisted, probed, trusted, or enabled.
    expect(mocks.saveServer).not.toHaveBeenCalled();
    expect(mocks.connectMcp).not.toHaveBeenCalled();
    expect(mocks.markTrusted).not.toHaveBeenCalled();
    expect(mocks.setEnabled).not.toHaveBeenCalled();
  });

  it('4NE-26: a token for a DIFFERENT connector is rejected and does NOT enable', async () => {
    // Token bound to a different connector id.
    const otherProposal = proposeConnector(operatorInput({ name: 'Other Server' }), 1000);
    const otherToken = await tokenFor(otherProposal);

    const proposal = proposalFixture();
    const outcome = await confirmAndInstall(proposal, otherToken);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.stage).toBe('validate');
      expect(outcome.error).toBeInstanceOf(ApprovalRequiredError);
    }
    expect(mocks.saveServer).not.toHaveBeenCalled();
    expect(mocks.markTrusted).not.toHaveBeenCalled();
    expect(mocks.setEnabled).not.toHaveBeenCalled();
  });

  it('respects fully-injected deps (no default registry/client touched)', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const injected = {
      connect: vi.fn().mockResolvedValue({ client: {}, close }),
      list: vi.fn().mockResolvedValue([{ name: 't' }]),
      registry: {
        saveServer: vi.fn().mockResolvedValue([]),
        markTrusted: vi.fn().mockResolvedValue(undefined),
        setEnabled: vi.fn().mockResolvedValue(undefined),
      },
    };

    const proposal = proposalFixture();
    const outcome = await confirmAndInstall(proposal, await tokenFor(proposal), injected);

    expect(injected.registry.saveServer).toHaveBeenCalledTimes(1);
    expect(injected.connect).toHaveBeenCalledTimes(1);
    expect(injected.registry.markTrusted).toHaveBeenCalledTimes(1);
    expect(injected.registry.setEnabled).toHaveBeenCalledWith(expect.any(String), true);
    // The default mocked registry/client were never used.
    expect(mocks.saveServer).not.toHaveBeenCalled();
    expect(mocks.connectMcp).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// uninstallConnector + slugifyName
// ---------------------------------------------------------------------------

describe('uninstallConnector', () => {
  it('delegates to removeServer', async () => {
    mocks.removeServer.mockResolvedValue([]);
    await uninstallConnector('some-id');
    expect(mocks.removeServer).toHaveBeenCalledWith('some-id');
  });

  it('uses an injected removeServer when provided', async () => {
    const removeServer = vi.fn().mockResolvedValue([]);
    await uninstallConnector('x', { registry: { removeServer } });
    expect(removeServer).toHaveBeenCalledWith('x');
    expect(mocks.removeServer).not.toHaveBeenCalled();
  });
});

describe('slugifyName', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifyName('Hello World')).toBe('hello-world');
  });
  it('collapses runs and trims', () => {
    expect(slugifyName('  A!!__B  ')).toBe('a-b');
  });
  it('falls back to "connector" for an all-symbol name', () => {
    expect(slugifyName('!!!')).toBe('connector');
  });
});
