/**
 * AGENTIC-CORE / PHASE 1 — AgentConsole component test.
 *
 * Verifies the new agentic chat console wires the tool-loop agent correctly:
 *   - renders the intro/empty state + the resolved character;
 *   - sending a message calls the agentic client entry (`streamAgent`) WITH
 *     the operator's resolved Higgsfield connector + active character;
 *   - a streamed tool-call event renders a cyan tool-call chip;
 *   - a streamed `done` event with a final prompt closes the agent bubble;
 *   - the "no Higgsfield connector" hint shows when none is configured, and the
 *     client is still called with `higgsfieldConnector: undefined`.
 *
 * `@/lib/aiClient`, `@/hooks/useConnectors`, `@/hooks/useSkills`, and
 * `@/hooks/useSettings` are mocked so nothing touches the network or
 * persistence. Same `vi.mock('@/…')` + Testing-Library pattern as
 * tests/components/CustomizePanel.test.tsx.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { McpServerConfig } from '@/lib/mcp';
import type { AgentEvent } from '@/lib/aiClient';

// ── Fixtures ──────────────────────────────────────────────────────────────

const HIGGSFIELD_CONNECTOR: McpServerConfig = {
  id: 'higgsfield-mcp',
  name: 'Higgsfield MCP',
  transport: 'http',
  url: 'https://mcp.higgsfield.example/sse',
  enabled: true,
  trusted: true,
  addedAt: 0,
};

// ── Mocks ─────────────────────────────────────────────────────────────────

let serversList: McpServerConfig[] = [];

vi.mock('@/hooks/useConnectors', () => ({
  useConnectors: () => ({
    servers: serversList,
    health: {},
    loading: false,
    refresh: vi.fn(),
    toggle: vi.fn(),
    test: vi.fn(),
    remove: vi.fn(),
    propose: vi.fn(),
    install: vi.fn(),
  }),
}));

vi.mock('@/hooks/useSkills', () => ({
  useSkills: () => ({
    skills: [],
    loading: false,
    refresh: vi.fn(),
    validate: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
  }),
}));

vi.mock('@/hooks/useSettings', () => ({
  useSettings: () => ({
    settings: {
      activeCharacterId: 'kael',
      agentNiches: ['Variant Reveal'],
      agentGenres: ['Cinematic'],
      activeSkills: [],
      activeTextModel: 'MiniMax-M3',
    },
  }),
}));

// PHASE 2: the console now mounts the additive right rail, whose Approval Deck
// reads the real approval queue from MashupContext. Mock useMashup with an
// empty queue so the console renders standalone (the chat assertions below are
// unaffected); the rail's own behaviour is covered by AgentConsoleRail.test.tsx.
vi.mock('@/components/MashupContext', () => ({
  useMashup: () => ({
    settings: { scheduledPosts: [] },
    savedImages: [],
    images: [],
    approveScheduledPost: vi.fn(),
    rejectScheduledPost: vi.fn(),
  }),
}));

// The agentic client entry — a vi.fn returning an async generator of
// AgentEvents. Each test sets `eventScript` to drive the stream.
const streamAgentSpy = vi.fn();
let eventScript: AgentEvent[] = [];

vi.mock('@/lib/aiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/aiClient')>();
  return {
    ...actual,
    streamAgent: (...args: unknown[]) => {
      streamAgentSpy(...args);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (async function* (): AsyncGenerator<AgentEvent> {
        for (const ev of eventScript) yield ev;
      })();
    },
  };
});

import { AgentConsole } from '@/components/agent/AgentConsole';

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  serversList = [HIGGSFIELD_CONNECTOR];
  eventScript = [];
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('AgentConsole — intro + connector resolution', () => {
  it('renders the intro state and the resolved Higgsfield connector pill', async () => {
    render(<AgentConsole />);
    expect(await screen.findByTestId('agent-intro')).toBeInTheDocument();
    expect(screen.getByTestId('connector-pill')).toHaveTextContent('Higgsfield MCP');
    // No missing-connector hint when one is configured.
    expect(screen.queryByTestId('no-connector-hint')).not.toBeInTheDocument();
  });

  it('shows the no-connector hint when no Higgsfield connector is configured', async () => {
    serversList = [];
    render(<AgentConsole />);
    expect(await screen.findByTestId('no-connector-hint')).toBeInTheDocument();
    expect(screen.getByTestId('connector-pill-missing')).toBeInTheDocument();
  });
});

describe('AgentConsole — send drives the tool-loop agent', () => {
  it('sending a message calls streamAgent on the agent-core path (messages-in + connector + character)', async () => {
    eventScript = [{ type: 'done', prompt: 'A forged beat.', text: 'A forged beat.', cost: 0.01 }];
    render(<AgentConsole />);

    const textarea = await screen.findByLabelText('Message the agent');
    fireEvent.change(textarea, { target: { value: 'Forge a Kael reveal' } });
    fireEvent.click(screen.getByLabelText('Send to agent'));

    await waitFor(() => expect(streamAgentSpy).toHaveBeenCalled());
    const [msg, opts] = streamAgentSpy.mock.calls[0] as [
      string,
      {
        agentCore?: boolean;
        messages?: Array<{ role: string; content: string }>;
        higgsfieldConnector?: McpServerConfig;
        characterId?: string;
      },
    ];
    expect(msg).toBe('Forge a Kael reveal');
    // AGENTIC-HARNESS: the clean conversational path — messages-in, no brief.
    expect(opts.agentCore).toBe(true);
    expect(opts.messages).toEqual([{ role: 'user', content: 'Forge a Kael reveal' }]);
    expect(opts.higgsfieldConnector).toEqual(HIGGSFIELD_CONNECTOR);
    expect(opts.characterId).toBe('kael');

    // The operator's message renders in the thread.
    expect(await screen.findByText('Forge a Kael reveal')).toBeInTheDocument();
  });

  it('builds the messages array from prior turns (operator→user, agent→assistant), excluding the in-flight turn', async () => {
    // First turn: a complete exchange.
    eventScript = [{ type: 'text', text: 'Sure — what beat?' }, { type: 'done', prompt: '', text: 'Sure — what beat?', cost: 0 }];
    render(<AgentConsole />);
    const textarea = await screen.findByLabelText('Message the agent');
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.click(screen.getByLabelText('Send to agent'));
    await screen.findByText('Sure — what beat?');

    // Second turn: the prior exchange must be replayed as messages.
    eventScript = [{ type: 'done', prompt: '', text: 'ok', cost: 0 }];
    fireEvent.change(textarea, { target: { value: 'a Kael reveal' } });
    fireEvent.click(screen.getByLabelText('Send to agent'));
    await waitFor(() => expect(streamAgentSpy).toHaveBeenCalledTimes(2));

    const [, opts] = streamAgentSpy.mock.calls[1] as [
      string,
      { messages?: Array<{ role: string; content: string }> },
    ];
    expect(opts.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Sure — what beat?' },
      { role: 'user', content: 'a Kael reveal' },
    ]);
  });

  it('renders a tool-call chip + an assistant message from the streamed events', async () => {
    eventScript = [
      { type: 'text', text: 'Planning the variant reveal.' },
      { type: 'tool-call', tool: 'generate_image', args: { model: 'nano_banana_2' }, idx: 2 },
      {
        type: 'tool-result',
        tool: 'generate_image',
        assetRef: { provider: 'higgsfield', id: 'job_1', url: 'https://img.example/1.png' },
        idx: 3,
      },
      { type: 'done', prompt: 'Final on-canon prompt.', cost: 0.02, truncatedBy: 'natural' },
    ];
    render(<AgentConsole />);

    const textarea = await screen.findByLabelText('Message the agent');
    fireEvent.change(textarea, { target: { value: 'Make a beat' } });
    fireEvent.click(screen.getByLabelText('Send to agent'));

    // Assistant reasoning bubble.
    expect(await screen.findByText('Planning the variant reveal.')).toBeInTheDocument();
    // Tool-call chip (cyan, mono) labelled with the tool name + model.
    const chip = await screen.findByTestId('tool-call-chip');
    expect(chip).toHaveTextContent('generate_image');
    expect(chip).toHaveTextContent('nano_banana_2');
    // Produced beat thumbnail.
    expect(await screen.findByTestId('agent-assets')).toBeInTheDocument();
    const img = screen.getByAltText('Generated beat (higgsfield)') as HTMLImageElement;
    expect(img.src).toBe('https://img.example/1.png');
  });

  it('does NOT render the internal plan scaffold in the thread (chat suppression)', async () => {
    const SCAFFOLD =
      'Director plan (executed in this order)\n1. Determine the beat\n6. Finalize\nBeat: "hey"';
    eventScript = [
      // The bare plan marker (no text) — the stream layer strips the scaffold.
      { type: 'plan', stepType: 'plan', idx: 0 },
      // Defense in depth: even a stray plan-step TEXT event must be dropped.
      { type: 'text', text: SCAFFOLD, stepType: 'plan', idx: 1 },
      { type: 'text', text: 'hey! want me to forge a beat?', stepType: 'final', idx: 2 },
      { type: 'done', prompt: 'hey! want me to forge a beat?', cost: 0.001, truncatedBy: 'natural' },
    ];
    render(<AgentConsole />);

    const textarea = await screen.findByLabelText('Message the agent');
    fireEvent.change(textarea, { target: { value: 'hey' } });
    fireEvent.click(screen.getByLabelText('Send to agent'));

    // The conversational reply renders…
    expect(await screen.findByText('hey! want me to forge a beat?')).toBeInTheDocument();
    // …but the internal director-plan scaffold NEVER does.
    expect(screen.queryByText(/Director plan \(executed in this order\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Determine the beat/)).not.toBeInTheDocument();
  });

  it('surfaces a streamed error event in-thread', async () => {
    eventScript = [{ type: 'error', error: 'No AI provider configured. Set MINIMAX_API_KEY.' }];
    render(<AgentConsole />);

    const textarea = await screen.findByLabelText('Message the agent');
    fireEvent.change(textarea, { target: { value: 'Go' } });
    fireEvent.click(screen.getByLabelText('Send to agent'));

    const err = await screen.findByTestId('agent-error');
    expect(err).toHaveTextContent(/No AI provider configured/);
  });

  it('still calls streamAgent with higgsfieldConnector undefined when none configured', async () => {
    serversList = [];
    eventScript = [{ type: 'done', prompt: 'ok', cost: 0 }];
    render(<AgentConsole />);

    const textarea = await screen.findByLabelText('Message the agent');
    fireEvent.change(textarea, { target: { value: 'plan only' } });
    fireEvent.click(screen.getByLabelText('Send to agent'));

    await waitFor(() => expect(streamAgentSpy).toHaveBeenCalled());
    const [, opts] = streamAgentSpy.mock.calls[0] as [string, { higgsfieldConnector?: McpServerConfig }];
    expect(opts.higgsfieldConnector).toBeUndefined();
  });
});
