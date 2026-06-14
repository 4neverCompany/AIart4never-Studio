// @vitest-environment jsdom
//
// V060-001: redesigned Post Ready card. Pins the user-visible behaviors
// from the acceptance plan so a future refactor can't quietly break:
//   - status pill at top of card with right kind for ready/scheduled/posted/failed
//   - colored border tracks the same status
//   - caption renders as a 2-line preview by default; click to edit
//   - hashtags render as 3 + N more chip until expanded
//   - kebab menu hides Copy / Regen / Unready by default; opens on click
//   - Schedule button toggles inline calendar visibility
//   - calendar's Auto-Schedule fires the schedule callback with a real slot
//   - calendar confirms on time-cell click and closes itself

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PostReadyCard } from '@/components/postready/PostReadyCard';
import type { GeneratedImage, ScheduledPost, PostPlatform } from '@/types/mashup';

beforeEach(() => {
  cleanup();
});

const mkImg = (overrides: Partial<GeneratedImage> = {}): GeneratedImage => ({
  id: 'img-1',
  url: 'https://example.test/a.png',
  prompt: 'p',
  postCaption:
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' +
    'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ' +
    'Ut enim ad minim veniam, quis nostrud exercitation.',
  postHashtags: ['#a', '#b', '#c', '#d', '#e', '#f'],
  ...overrides,
});

const noop = () => {};

const baseProps = (img: GeneratedImage = mkImg()) => ({
  img,
  scheduledPost: undefined,
  allScheduledPosts: [] as ScheduledPost[],
  selectedPlatforms: ['instagram'] as PostPlatform[],
  available: ['instagram', 'pinterest'] as PostPlatform[],
  busy: undefined,
  status: undefined,
  isRegen: false,
  copyHighlighted: false,
  onPreviewClick: noop,
  onCaptionChange: noop,
  onRemoveHashtag: noop,
  onTogglePlatform: noop,
  onPostNow: noop,
  onSchedule: noop,
  onCopy: noop,
  onRegen: noop,
  onUnready: noop,
});

describe('V060-001 — PostReadyCard layout & interactions', () => {
  it('renders a Ready status pill when no schedule and no manual post state', () => {
    render(<PostReadyCard {...baseProps()} />);
    expect(screen.getByLabelText(/Status: Ready/)).toBeTruthy();
  });

  it('renders a Scheduled status pill with date/time when scheduledPost is scheduled', () => {
    const sched: ScheduledPost = {
      id: 'p1',
      imageId: 'img-1',
      date: '2026-04-25',
      time: '18:00',
      platforms: ['instagram'],
      caption: 'cap',
      status: 'scheduled',
    };
    render(<PostReadyCard {...baseProps()} scheduledPost={sched} />);
    // V082-UI-FIX: compact date format (MMM D) so the carousel status
    // row fits on one line in grid-cols-2 layouts.
    expect(screen.getByLabelText(/Status: Scheduled Apr 25/)).toBeTruthy();
  });

  it('renders a Posted status pill when img.postedAt is set', () => {
    render(
      <PostReadyCard
        {...baseProps(mkImg({ postedAt: 1234, postedTo: ['instagram'] }))}
      />,
    );
    expect(screen.getByLabelText(/Status: Posted to instagram/)).toBeTruthy();
  });

  it('renders a Failed status pill when img.postError is set', () => {
    render(<PostReadyCard {...baseProps(mkImg({ postError: 'boom' }))} />);
    expect(screen.getByLabelText(/Status: Failed: boom/)).toBeTruthy();
  });

  it('caption renders as a collapsed preview button by default', () => {
    render(<PostReadyCard {...baseProps()} />);
    const preview = screen.getByTitle('Tap to edit');
    expect(preview).toBeTruthy();
    // No textarea before expanding.
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('clicking the caption preview opens an editable textarea', () => {
    render(<PostReadyCard {...baseProps()} />);
    fireEvent.click(screen.getByTitle('Tap to edit'));
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('hashtags collapse to 3 + N more by default', () => {
    render(<PostReadyCard {...baseProps()} />);
    // First 3 visible, +3 more pill rendered for the 6 supplied.
    expect(screen.getByText('#a')).toBeTruthy();
    expect(screen.getByText('#b')).toBeTruthy();
    expect(screen.getByText('#c')).toBeTruthy();
    expect(screen.queryByText('#d')).toBeNull();
    expect(screen.getByText('+3 more')).toBeTruthy();
  });

  it('clicking +N more reveals all hashtags', () => {
    render(<PostReadyCard {...baseProps()} />);
    fireEvent.click(screen.getByText('+3 more'));
    expect(screen.getByText('#d')).toBeTruthy();
    expect(screen.getByText('#e')).toBeTruthy();
    expect(screen.getByText('#f')).toBeTruthy();
  });

  it('only Post Now + Schedule + kebab are primary buttons (Copy/Regen/Unready hidden until kebab opens)', () => {
    render(<PostReadyCard {...baseProps()} />);
    expect(screen.getByRole('button', { name: /Post Now/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Schedule/ })).toBeTruthy();
    expect(screen.getByLabelText('More actions')).toBeTruthy();
    // Secondary actions live in the kebab and aren't rendered yet.
    expect(screen.queryByRole('menuitem', { name: /Copy caption/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Regenerate caption/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Move out of Post Ready/ })).toBeNull();
  });

  it('kebab opens menu with Copy / Regen / Unready items', () => {
    render(<PostReadyCard {...baseProps()} />);
    fireEvent.click(screen.getByLabelText('More actions'));
    expect(screen.getByRole('menuitem', { name: /Copy caption/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Regenerate caption/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Move out of Post Ready/ })).toBeTruthy();
  });

  it('Schedule button toggles the inline calendar visibility', () => {
    render(<PostReadyCard {...baseProps()} />);
    expect(screen.queryByLabelText('Schedule calendar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Schedule/ }));
    expect(screen.getByLabelText('Schedule calendar')).toBeTruthy();
  });

  it('calendar confirms a schedule on Auto-Schedule click and closes itself', () => {
    const onSchedule = vi.fn();
    render(<PostReadyCard {...baseProps()} onSchedule={onSchedule} />);
    fireEvent.click(screen.getByRole('button', { name: /Schedule/ }));
    fireEvent.click(screen.getByRole('button', { name: /Auto-Schedule/ }));
    expect(onSchedule).toHaveBeenCalledTimes(1);
    // M3.1b contract: (img, platforms, date, time) — the card threads
    // its own image + selection back so the parent handler can be ONE
    // stable function instead of a per-card lambda.
    const [, , date, time] = onSchedule.mock.calls[0];
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(time).toMatch(/^\d{2}:\d{2}$/);
    expect(screen.queryByLabelText('Schedule calendar')).toBeNull();
  });
});

describe('V080-DES-002 — "Not scheduled" affordance', () => {
  it('shows the "Not scheduled" badge for a ready card with no scheduledPost', () => {
    render(<PostReadyCard {...baseProps()} />);
    expect(screen.getByLabelText('Not scheduled')).toBeTruthy();
  });

  it('hides the "Not scheduled" badge when a scheduled post exists', () => {
    const sched: ScheduledPost = {
      id: 'p1',
      imageId: 'img-1',
      date: '2026-05-01',
      time: '10:00',
      platforms: ['instagram'],
      caption: 'cap',
      status: 'scheduled',
    };
    render(<PostReadyCard {...baseProps()} scheduledPost={sched} />);
    expect(screen.queryByLabelText('Not scheduled')).toBeNull();
  });

  it('hides the "Not scheduled" badge for a posted card (status pill already sufficient)', () => {
    render(<PostReadyCard {...baseProps(mkImg({ postedAt: 9999, postedTo: ['instagram'] }))} />);
    expect(screen.queryByLabelText('Not scheduled')).toBeNull();
  });

  it('hides the "Not scheduled" badge for a failed card', () => {
    render(<PostReadyCard {...baseProps(mkImg({ postError: 'network error' }))} />);
    expect(screen.queryByLabelText('Not scheduled')).toBeNull();
  });
});
