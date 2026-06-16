/**
 * AGENTIC-CORE / PHASE 2 — StudioTopbar test.
 *
 * Verifies the Cyberforge command bar:
 *   - the segmented Chat↔Gallery toggle reflects the active surface and calls
 *     onChange with the other surface when clicked (Chat = 'agent',
 *     Gallery = 'studio');
 *   - the character switcher lists the REAL canon characters, shows the active
 *     one, and writes the operator's pick back via updateSettings
 *     (settings.activeCharacterId — the field the agent loop reads);
 *   - the connector dots light cyan ONLY for a connector that is present,
 *     enabled, AND health 'ok' (real health-sweep shape), ashen otherwise.
 *
 * The hooks (useSettings / useConnectors) + the budget readout's credit source
 * are mocked; canon is the real module.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import type { McpServerConfig } from '@/lib/mcp';
import { listCharacters } from '@/lib/canon';

// ── Mock state ──────────────────────────────────────────────────────────────

const updateSettingsSpy = vi.fn();
let activeCharacterId = 'kael';
let servers: McpServerConfig[] = [];
let health: Record<string, { id: string; name: string; status: string; checkedAt: number }> = {};

vi.mock('@/hooks/useSettings', () => ({
  useSettings: () => ({
    settings: { activeCharacterId, higgsfieldMonthlyCreditCap: undefined },
    updateSettings: updateSettingsSpy,
  }),
}));

vi.mock('@/hooks/useConnectors', () => ({
  useConnectors: () => ({ servers, health }),
}));

// Keep the budget readout deterministic + network-free.
vi.mock('@/lib/credit-budget', () => ({
  CREDIT_USAGE_CHANGED_EVENT: 'mashup:credit-usage-changed',
  loadCreditUsage: () => Promise.resolve({ used: 3, cycleStartMs: 0, override: false }),
}));

import { StudioTopbar } from '@/components/StudioTopbar';
// The connector dots are dynamically imported inside StudioTopbar (to keep the
// MCP-SDK weight out of the /studio first-load bundle), so they're asserted
// directly against the extracted unit rather than through the lazy boundary.
import { ConnectorDots } from '@/components/ConnectorDots';

const HIGGS: McpServerConfig = {
  id: 'higgs-1',
  name: 'Higgsfield MCP',
  transport: 'http',
  url: 'https://h.example/sse',
  enabled: true,
  trusted: true,
  addedAt: 0,
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  activeCharacterId = 'kael';
  servers = [];
  health = {};
});

describe('StudioTopbar — Chat↔Gallery surface toggle', () => {
  it('marks the active surface and switches on click', () => {
    const onChange = vi.fn();
    render(<StudioTopbar surface="agent" onChange={onChange} />);

    const chat = screen.getByTestId('surface-tab-chat');
    const gallery = screen.getByTestId('surface-tab-gallery');
    expect(chat).toHaveAttribute('aria-selected', 'true');
    expect(gallery).toHaveAttribute('aria-selected', 'false');

    fireEvent.click(gallery);
    expect(onChange).toHaveBeenCalledWith('studio');
  });

  it('switches from Gallery to Chat', () => {
    const onChange = vi.fn();
    render(<StudioTopbar surface="studio" onChange={onChange} />);
    expect(screen.getByTestId('surface-tab-gallery')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByTestId('surface-tab-chat'));
    expect(onChange).toHaveBeenCalledWith('agent');
  });
});

describe('StudioTopbar — character switcher (real canon + persistence)', () => {
  it('lists the canon characters, shows the active one, and persists a change', () => {
    render(<StudioTopbar surface="agent" onChange={vi.fn()} />);

    const select = screen.getByLabelText('Active character') as HTMLSelectElement;
    // The select offers every real canon character.
    expect(select.options).toHaveLength(listCharacters().length);
    expect(select.value).toBe('kael');

    fireEvent.change(select, { target: { value: 'kaelus-vorne' } });
    expect(updateSettingsSpy).toHaveBeenCalledWith({ activeCharacterId: 'kaelus-vorne' });
  });
});

describe('ConnectorDots — connector status (real health shape)', () => {
  it('lights Higgsfield cyan only when present + enabled + health ok', () => {
    servers = [HIGGS];
    health = { 'higgs-1': { id: 'higgs-1', name: 'Higgsfield MCP', status: 'ok', checkedAt: 0 } };
    render(<ConnectorDots />);

    expect(screen.getByTestId('connector-dot-higgsfield')).toHaveAttribute('data-on', 'true');
    // Composio absent → ashen.
    expect(screen.getByTestId('connector-dot-composio')).toHaveAttribute('data-on', 'false');
  });

  it('keeps a connector ashen when health is not ok', () => {
    servers = [HIGGS];
    health = { 'higgs-1': { id: 'higgs-1', name: 'Higgsfield MCP', status: 'unreachable', checkedAt: 0 } };
    render(<ConnectorDots />);
    expect(screen.getByTestId('connector-dot-higgsfield')).toHaveAttribute('data-on', 'false');
  });
});
