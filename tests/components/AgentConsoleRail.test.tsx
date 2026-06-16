/**
 * AGENTIC-CORE / PHASE 2 — AgentConsoleRail test.
 *
 * Verifies the additive console rail reads REAL approval + canon data:
 *   - the Approval Deck renders the pending queue (filtered to
 *     'pending_approval') with thumbnail + caption + a live count, and
 *     Approve/Reject call the REAL context actions with the post id;
 *   - a non-pending post never shows in the deck;
 *   - an empty queue shows the quiet empty state;
 *   - the Canon Panel renders the ACTIVE character (name + reality), the locked
 *     Higgsfield Element token, the 4 content pillars, and the realities — all
 *     from `lib/canon` (no mocked canon).
 *
 * `@/components/MashupContext` (useMashup) is mocked so the rail renders without
 * the full provider; canon is the real module.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import type { GeneratedImage, ScheduledPost } from '@/types/mashup';
import { CONTENT_PILLARS, getElementRef } from '@/lib/canon';

// ── Mock state the useMashup mock reads ─────────────────────────────────────

let scheduledPosts: ScheduledPost[] = [];
let savedImages: GeneratedImage[] = [];
const approveSpy = vi.fn();
const rejectSpy = vi.fn();

vi.mock('@/components/MashupContext', () => ({
  useMashup: () => ({
    settings: { scheduledPosts },
    savedImages,
    images: [],
    approveScheduledPost: approveSpy,
    rejectScheduledPost: rejectSpy,
  }),
}));

import { AgentConsoleRail } from '@/components/agent/AgentConsoleRail';

const IMG: GeneratedImage = {
  id: 'img_1',
  url: 'https://img.example/beat.png',
  prompt: 'Kael steps through a reality rift.',
};

const PENDING: ScheduledPost = {
  id: 'post_1',
  imageId: 'img_1',
  date: '2026-06-20',
  time: '18:00',
  platforms: ['instagram'],
  caption: 'A storm-wreathed sky-temple beat.',
  status: 'pending_approval',
  viralityScore: 72,
};

const SCHEDULED: ScheduledPost = {
  ...PENDING,
  id: 'post_2',
  status: 'scheduled',
  caption: 'Already approved.',
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  scheduledPosts = [];
  savedImages = [];
});

describe('AgentConsoleRail — Approval Deck (real approval data)', () => {
  it('renders a quiet empty state when nothing is pending', () => {
    scheduledPosts = [SCHEDULED]; // present but NOT pending
    render(<AgentConsoleRail characterId="kael" />);
    expect(screen.getByTestId('approval-empty')).toBeInTheDocument();
    expect(screen.getByTestId('approval-count')).toHaveTextContent('0');
    expect(screen.queryByTestId('approval-item')).not.toBeInTheDocument();
  });

  it('renders the pending queue with caption + thumbnail + live count', () => {
    scheduledPosts = [PENDING, SCHEDULED];
    savedImages = [IMG];
    render(<AgentConsoleRail characterId="kael" />);

    // Only the pending post shows; the scheduled one is filtered out.
    const items = screen.getAllByTestId('approval-item');
    expect(items).toHaveLength(1);
    expect(screen.getByTestId('approval-count')).toHaveTextContent('1');
    expect(screen.getByText('A storm-wreathed sky-temple beat.')).toBeInTheDocument();
    expect(screen.queryByText('Already approved.')).not.toBeInTheDocument();

    const img = within(items[0]).getByAltText('Pending beat') as HTMLImageElement;
    expect(img.src).toBe('https://img.example/beat.png');
  });

  it('Approve / Reject call the real context actions with the post id', () => {
    scheduledPosts = [PENDING];
    savedImages = [IMG];
    render(<AgentConsoleRail characterId="kael" />);

    fireEvent.click(screen.getByTestId('approve-btn'));
    expect(approveSpy).toHaveBeenCalledWith('post_1');

    fireEvent.click(screen.getByTestId('reject-btn'));
    expect(rejectSpy).toHaveBeenCalledWith('post_1');
  });

  it('states the publish gate is human-owned', () => {
    render(<AgentConsoleRail characterId="kael" />);
    expect(screen.getByText(/publish gated — human decides/i)).toBeInTheDocument();
  });
});

describe('AgentConsoleRail — Canon Panel (real canon data)', () => {
  it('renders the active character, its reality, the Element token, pillars + realities', () => {
    render(<AgentConsoleRail characterId="kael" />);

    // Active character (real canon).
    expect(screen.getByTestId('canon-character-name')).toHaveTextContent(
      'Master4never (Kael)',
    );

    // Locked Higgsfield Element token (real getElementRef).
    const element = getElementRef('kael');
    expect(element).toBeDefined();
    expect(screen.getByTestId('canon-element')).toHaveTextContent(element!);

    // All 4 content pillars render as tags.
    const pillars = screen.getByTestId('canon-pillars');
    for (const p of CONTENT_PILLARS) {
      expect(within(pillars).getByText(p.name)).toBeInTheDocument();
    }

    // Realities listed (PRIME + the W40K family).
    const realities = screen.getByTestId('canon-realities');
    expect(within(realities).getByText('Cyberpunk PRIME')).toBeInTheDocument();
  });

  it('reflects a different active character (Kaelus Vorne)', () => {
    render(<AgentConsoleRail characterId="kaelus-vorne" />);
    expect(screen.getByTestId('canon-character-name')).toHaveTextContent(
      'Kaelus Vorne (The Iron Halo)',
    );
    const element = getElementRef('kaelus-vorne');
    expect(screen.getByTestId('canon-element')).toHaveTextContent(element!);
  });
});
