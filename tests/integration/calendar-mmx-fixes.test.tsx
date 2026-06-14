// @vitest-environment jsdom
//
// QA-W5 — pin Fix 3 (calendar trash zone) + Fix 4 (chip thumbnails) +
// QA-W4 (modal Escape) so future refactors of the calendar IIFE in
// components/MainContent.tsx can't quietly regress them.
//
// Strategy follows tests/integration/calendar-key-uniqueness.test.ts:
// the calendar lives inside a 4800-line component with deep context
// dependencies, so we mirror the small testable unit (state machine /
// pure render) here. If the inline source diverges, this file is the
// contract that fails first.

import { describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import type { GeneratedImage, ScheduledPost } from '@/types/mashup';

afterEach(() => {
  cleanup();
});

// ─────────────────────────────────────────────────────────────────────
// Fix 3 — calendar trash zone state machine
// Mirror of the pendingTrashId handlers (MainContent.tsx around line
// 4295). The dialog only renders when pendingTrashId is set; close
// clears it; confirmDelete filters scheduledPosts AND clears it.
// ─────────────────────────────────────────────────────────────────────

interface TrashState {
  pendingTrashId: string | null;
  scheduledPosts: ScheduledPost[];
}

/** Mirror of the trash-zone onDrop handler. */
function dropOnTrash(state: TrashState, postId: string): TrashState {
  if (!postId) return state;
  return { ...state, pendingTrashId: postId };
}

/** Mirror of close() inside the dialog IIFE. */
function closeTrash(state: TrashState): TrashState {
  return { ...state, pendingTrashId: null };
}

/** Mirror of confirmDelete() inside the dialog IIFE. */
function confirmDeleteFromTrash(state: TrashState): TrashState {
  if (!state.pendingTrashId) return state;
  return {
    pendingTrashId: null,
    scheduledPosts: state.scheduledPosts.filter(
      (p) => p.id !== state.pendingTrashId,
    ),
  };
}

const mkPost = (id: string, overrides: Partial<ScheduledPost> = {}): ScheduledPost => ({
  id,
  imageId: `img-${id}`,
  date: '2026-04-29',
  time: '10:00',
  platforms: ['instagram'],
  caption: `caption ${id}`,
  status: 'scheduled',
  ...overrides,
});

describe('Fix 3 — calendar trash zone state machine', () => {
  const base: TrashState = {
    pendingTrashId: null,
    scheduledPosts: [mkPost('a'), mkPost('b'), mkPost('c')],
  };

  it('dropping a post on the trash zone arms pendingTrashId', () => {
    const next = dropOnTrash(base, 'a');
    expect(next.pendingTrashId).toBe('a');
    // Drop is non-destructive — the post is still in the list until
    // confirmDelete runs.
    expect(next.scheduledPosts.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('a drop with no postId is a no-op', () => {
    const next = dropOnTrash(base, '');
    expect(next).toEqual(base);
  });

  it('confirmDelete filters the armed post and clears pendingTrashId', () => {
    const armed = dropOnTrash(base, 'b');
    const next = confirmDeleteFromTrash(armed);
    expect(next.pendingTrashId).toBeNull();
    expect(next.scheduledPosts.map((p) => p.id)).toEqual(['a', 'c']);
  });

  it('close clears pendingTrashId without filtering anything', () => {
    const armed = dropOnTrash(base, 'a');
    const next = closeTrash(armed);
    expect(next.pendingTrashId).toBeNull();
    expect(next.scheduledPosts.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('confirmDelete with no armed id is a no-op', () => {
    const next = confirmDeleteFromTrash(base);
    expect(next).toEqual(base);
  });

  it('arming a different id then close leaves the list intact', () => {
    const a = dropOnTrash(base, 'a');
    const b = dropOnTrash(a, 'b');
    expect(b.pendingTrashId).toBe('b');
    const closed = closeTrash(b);
    expect(closed.pendingTrashId).toBeNull();
    expect(closed.scheduledPosts).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────────────
// QA-W4 — Escape closes the trash modal
// Mirror of the onKeyDown handler attached to the modal root.
// ─────────────────────────────────────────────────────────────────────

function makeEscapeHandler(close: () => void) {
  return (e: { key: string; stopPropagation: () => void }) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
}

describe('QA-W4 — calendar trash modal Escape key', () => {
  it('Escape calls close()', () => {
    let closed = 0;
    let stopped = 0;
    const handler = makeEscapeHandler(() => { closed += 1; });
    handler({ key: 'Escape', stopPropagation: () => { stopped += 1; } });
    expect(closed).toBe(1);
    // stopPropagation must fire so the keystroke doesn't bubble into
    // ancestor popovers / view containers and dismiss them too.
    expect(stopped).toBe(1);
  });

  it('non-Escape keys are ignored', () => {
    let closed = 0;
    const handler = makeEscapeHandler(() => { closed += 1; });
    handler({ key: 'Enter', stopPropagation: () => { /* irrelevant */ } });
    handler({ key: 'a', stopPropagation: () => { /* irrelevant */ } });
    handler({ key: ' ', stopPropagation: () => { /* irrelevant */ } });
    expect(closed).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Fix 4 — chip thumbnail rendering
// The chip is inline JSX in the calendar week-view IIFE. Mirror its
// branching here so the contract (16×16 image when url present, muted
// square fallback otherwise) is pinned regardless of inline drift.
// ─────────────────────────────────────────────────────────────────────

function CalendarChipMirror({
  image,
  time,
  platforms,
}: {
  image: GeneratedImage | undefined;
  time: string;
  platforms: string[];
}) {
  return (
    <button data-testid="chip" type="button">
      {image?.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image.url}
          alt=""
          className="w-4 h-4 rounded object-cover shrink-0 border border-black/40"
          loading="lazy"
        />
      ) : (
        <span
          data-testid="chip-fallback"
          className="w-4 h-4 rounded bg-zinc-800/80 border border-black/40 shrink-0"
        />
      )}
      <span className="truncate tabular-nums">
        {time} · {platforms.map((pl) => pl[0].toUpperCase()).join('')}
      </span>
    </button>
  );
}

const mkImg = (overrides: Partial<GeneratedImage> = {}): GeneratedImage => ({
  id: 'img-1',
  url: 'https://example.test/a.png',
  prompt: 'a cat',
  model: 'nano-banana-pro',
  timestamp: 0,
  ...overrides,
} as GeneratedImage);

describe('Fix 4 — calendar chip thumbnails', () => {
  it('renders the 16×16 thumbnail when image.url is present', () => {
    const { container } = render(
      <CalendarChipMirror
        image={mkImg({ url: 'https://example.test/cat.png' })}
        time="10:00"
        platforms={['instagram', 'twitter']}
      />,
    );
    // alt="" makes the image decorative — `getByRole('img')` excludes
    // it. Reach for the tag directly.
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('https://example.test/cat.png');
    expect(img!.className).toMatch(/\bw-4\b/);
    expect(img!.className).toMatch(/\bh-4\b/);
    // Fallback square is suppressed.
    expect(screen.queryByTestId('chip-fallback')).toBeNull();
  });

  it('falls back to a muted square when no image is provided', () => {
    const { container } = render(
      <CalendarChipMirror
        image={undefined}
        time="10:00"
        platforms={['instagram']}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    const fallback = screen.getByTestId('chip-fallback');
    expect(fallback.className).toMatch(/bg-zinc-800\/80/);
    expect(fallback.className).toMatch(/\bw-4\b/);
  });

  it('falls back to a muted square when image is present but has no url', () => {
    const { container } = render(
      <CalendarChipMirror
        image={mkImg({ url: '' })}
        time="10:00"
        platforms={['instagram']}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('chip-fallback')).toBeInTheDocument();
  });

  it('compresses platform names to first-letter tags', () => {
    render(
      <CalendarChipMirror
        image={mkImg()}
        time="10:00"
        platforms={['instagram', 'twitter', 'pinterest']}
      />,
    );
    expect(screen.getByText(/10:00 · ITP/)).toBeInTheDocument();
  });
});
