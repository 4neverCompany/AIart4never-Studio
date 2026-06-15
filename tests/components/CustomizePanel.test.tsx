/**
 * 4NE-12 + 4NE-27 — CustomizePanel component test.
 *
 * Verifies the panel wires the EXISTING service layers correctly:
 *   - the connectors list renders a row + a status pill per configured server;
 *   - the enabled toggle calls `setEnabled`;
 *   - Test calls `checkConnectorHealth`;
 *   - Remove requires a confirm before `uninstallConnector` fires;
 *   - the Add form calls `proposeConnector`, renders the REDACTED config, and
 *     (after Confirm) mints an approval token via `assertApproved` then calls
 *     `confirmAndInstall` WITH that token;
 *   - the Skills add path validates via `validateSkill` then calls `saveSkill`.
 *
 * `@/lib/connectors`, `@/lib/mcp`, and `@/lib/approval` are mocked so nothing
 * touches persistence or the network. Same `vi.mock('@/lib/…')` pattern as
 * `tests/lib/analytics/insights-source.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { McpServerConfig } from '@/lib/mcp';
import type { ConnectorHealth, ConnectorProposal, Skill } from '@/lib/connectors';

// ── Fixtures ──────────────────────────────────────────────────────────────

const SERVER_OK: McpServerConfig = {
  id: 'notion-mcp',
  name: 'Notion MCP',
  transport: 'http',
  url: 'https://mcp.notion.example/sse',
  enabled: true,
  trusted: true,
  addedAt: 0,
};

const HEALTH_OK: ConnectorHealth = {
  id: 'notion-mcp',
  name: 'Notion MCP',
  status: 'ok',
  toolCount: 7,
  latencyMs: 42,
  checkedAt: 0,
};

const PROPOSAL: ConnectorProposal = {
  config: {
    id: 'my-mcp',
    name: 'My MCP',
    transport: 'http',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer secret-token-value-1234567890' },
    enabled: false,
    trusted: false,
    addedAt: 1,
  },
  redactedView: {
    id: 'my-mcp',
    name: 'My MCP',
    transport: 'http',
    url: 'https://example.com/mcp',
    headers: { Authorization: '***' },
    enabled: false,
    trusted: false,
    addedAt: 1,
  },
  warnings: ['stdio transport is not yet connectable'],
};

const ACTIVATE_TOKEN = {
  kind: 'connector-activate' as const,
  requestHash: 'hash-abc',
  grantedAt: 0,
  scope: 'my-mcp',
};

// ── Mocks ─────────────────────────────────────────────────────────────────

let serversList: McpServerConfig[] = [];

const setEnabledSpy = vi.fn(async () => SERVER_OK);
const redactConfigSpy = vi.fn((cfg: McpServerConfig) => cfg);

vi.mock('@/lib/mcp', () => ({
  listServers: vi.fn(async () => serversList),
  setEnabled: (...a: unknown[]) => setEnabledSpy(...(a as [])),
  redactConfig: (cfg: McpServerConfig) => redactConfigSpy(cfg),
}));

const proposeConnectorSpy = vi.fn((_input: unknown): ConnectorProposal => PROPOSAL);
const confirmAndInstallSpy = vi.fn(async (_proposal: unknown, _token: unknown) => ({
  ok: true as const,
  server: { ...PROPOSAL.config, enabled: true, trusted: true },
  tools: [],
}));
const uninstallConnectorSpy = vi.fn(async () => [] as McpServerConfig[]);
const checkConnectorHealthSpy = vi.fn(async () => HEALTH_OK);
const checkAllConnectorsSpy = vi.fn(async () => serversList.map(() => HEALTH_OK));

let skillsList: Skill[] = [];
const saveSkillSpy = vi.fn(async (s: Skill) => {
  skillsList = [...skillsList, s];
  return skillsList;
});
const removeSkillSpy = vi.fn(async () => skillsList);
const validateSkillSpy = vi.fn((partial: Partial<Skill>) => {
  const errors: string[] = [];
  if (!partial.name) errors.push('name is required');
  if (!partial.connectorId) errors.push('connectorId is required');
  if (!partial.toolNames || partial.toolNames.length === 0) {
    errors.push('toolNames must be a non-empty array');
  }
  return { ok: errors.length === 0, errors };
});

vi.mock('@/lib/connectors', () => ({
  proposeConnector: (input: unknown) => proposeConnectorSpy(input),
  confirmAndInstall: (proposal: unknown, token: unknown) => confirmAndInstallSpy(proposal, token),
  uninstallConnector: (...a: unknown[]) => uninstallConnectorSpy(...(a as [])),
  checkConnectorHealth: (...a: unknown[]) => checkConnectorHealthSpy(...(a as [])),
  checkAllConnectors: (...a: unknown[]) => checkAllConnectorsSpy(...(a as [])),
  buildConnectorActivateRequest: (cfg: McpServerConfig) => ({
    kind: 'connector-activate',
    summary: `Activate ${cfg.id}`,
    target: cfg.id,
  }),
  listSkills: vi.fn(async () => skillsList),
  saveSkill: (...a: unknown[]) => saveSkillSpy(...(a as [Skill])),
  removeSkill: (...a: unknown[]) => removeSkillSpy(...(a as [])),
  validateSkill: (...a: unknown[]) => validateSkillSpy(...(a as [Partial<Skill>])),
  slugifyName: (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
}));

const assertApprovedSpy = vi.fn(async () => ACTIVATE_TOKEN);

vi.mock('@/lib/approval', () => ({
  assertApproved: (...a: unknown[]) => assertApprovedSpy(...(a as [])),
  ApprovalDeniedError: class ApprovalDeniedError extends Error {},
}));

// Toast is a side-channel; stub it so it doesn't spawn timers/portals.
const showToastSpy = vi.fn();
vi.mock('@/components/Toast', () => ({
  showToast: (...a: unknown[]) => showToastSpy(...a),
}));

import { CustomizePanel } from '@/components/Settings/CustomizePanel';

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  serversList = [SERVER_OK];
  skillsList = [];
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('CustomizePanel — connectors list', () => {
  it('renders a row per configured connector with a status pill', async () => {
    render(<CustomizePanel />);
    const rows = await screen.findAllByTestId('connector-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Notion MCP');
    const pill = await screen.findByTestId('status-pill');
    expect(pill).toHaveAttribute('data-status', 'ok');
    expect(pill).toHaveTextContent('Connected');
  });

  it('runs the health sweep (checkAllConnectors) on mount', async () => {
    render(<CustomizePanel />);
    await waitFor(() => expect(checkAllConnectorsSpy).toHaveBeenCalled());
  });

  it('toggling a connector calls setEnabled', async () => {
    render(<CustomizePanel />);
    await screen.findAllByTestId('connector-row');
    // The enabled connector renders a "Disable {name}" toggle (Switch aria).
    const toggle = screen.getByLabelText('Disable Notion MCP');
    fireEvent.click(toggle);
    await waitFor(() => expect(setEnabledSpy).toHaveBeenCalledWith('notion-mcp', false));
  });

  it('Test button calls checkConnectorHealth', async () => {
    render(<CustomizePanel />);
    await screen.findAllByTestId('connector-row');
    fireEvent.click(screen.getByRole('button', { name: /test/i }));
    await waitFor(() => expect(checkConnectorHealthSpy).toHaveBeenCalled());
  });

  it('Remove requires a confirm before uninstalling', async () => {
    render(<CustomizePanel />);
    await screen.findAllByTestId('connector-row');
    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    // Not removed yet — needs the confirm.
    expect(uninstallConnectorSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(uninstallConnectorSpy).toHaveBeenCalledWith('notion-mcp'));
  });
});

describe('CustomizePanel — add connector (FR-22)', () => {
  it('Propose calls proposeConnector with source:operator and renders the redacted config', async () => {
    render(<CustomizePanel />);
    await screen.findAllByTestId('connector-row');

    fireEvent.change(screen.getByPlaceholderText('e.g. My Notion MCP'), {
      target: { value: 'My MCP' },
    });
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'https://example.com/mcp' },
    });
    fireEvent.click(screen.getByRole('button', { name: /propose/i }));

    expect(proposeConnectorSpy).toHaveBeenCalledTimes(1);
    const input = proposeConnectorSpy.mock.calls[0][0] as { source: string; name: string };
    expect(input.source).toBe('operator');
    expect(input.name).toBe('My MCP');

    // The redacted view is shown; the bearer token is masked, never raw.
    const redacted = await screen.findByTestId('redacted-config');
    expect(redacted).toHaveTextContent('***');
    expect(redacted).not.toHaveTextContent('secret-token-value');
  });

  it('Confirm mints a token via assertApproved then calls confirmAndInstall with it', async () => {
    render(<CustomizePanel />);
    await screen.findAllByTestId('connector-row');

    fireEvent.change(screen.getByPlaceholderText('e.g. My Notion MCP'), {
      target: { value: 'My MCP' },
    });
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'https://example.com/mcp' },
    });
    fireEvent.click(screen.getByRole('button', { name: /propose/i }));

    await screen.findByTestId('redacted-config');
    fireEvent.click(screen.getByRole('button', { name: /confirm & install/i }));

    await waitFor(() => expect(assertApprovedSpy).toHaveBeenCalled());
    await waitFor(() => expect(confirmAndInstallSpy).toHaveBeenCalled());
    // confirmAndInstall(proposal, token) — the second arg is the minted token.
    const [proposalArg, tokenArg] = confirmAndInstallSpy.mock.calls[0];
    expect(proposalArg).toBe(PROPOSAL);
    expect(tokenArg).toEqual(ACTIVATE_TOKEN);
  });
});

describe('CustomizePanel — skills (4NE-27)', () => {
  it('Add skill validates then calls saveSkill on a valid bundle', async () => {
    render(<CustomizePanel />);
    await screen.findAllByTestId('connector-row');

    fireEvent.change(screen.getByPlaceholderText('e.g. Notion read-only'), {
      target: { value: 'Notion read-only' },
    });
    fireEvent.change(screen.getByLabelText('Connector'), { target: { value: 'notion-mcp' } });
    fireEvent.change(screen.getByLabelText(/tool names/i), {
      target: { value: 'search, fetch_page' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add skill/i }));

    await waitFor(() => expect(validateSkillSpy).toHaveBeenCalled());
    await waitFor(() => expect(saveSkillSpy).toHaveBeenCalled());
    const saved = saveSkillSpy.mock.calls[0][0] as Skill;
    expect(saved.connectorId).toBe('notion-mcp');
    expect(saved.toolNames).toEqual(['search', 'fetch_page']);
  });

  it('Add skill surfaces validation errors and does NOT save an invalid bundle', async () => {
    render(<CustomizePanel />);
    await screen.findAllByTestId('connector-row');

    // Only fill the name; no connector, no tools → validateSkill fails.
    fireEvent.change(screen.getByPlaceholderText('e.g. Notion read-only'), {
      target: { value: 'Broken' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add skill/i }));

    expect(validateSkillSpy).toHaveBeenCalled();
    expect(saveSkillSpy).not.toHaveBeenCalled();
    expect(await screen.findByText(/connectorId is required/i)).toBeInTheDocument();
  });
});
