// @vitest-environment jsdom
//
// FEAT-2: Post-Ready DnD between carousels — unit tests for the
// move handler logic and DraggableSingleWrapper / DroppableImageStrip.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { CarouselGroup } from '@/types/mashup';

beforeEach(() => {
  cleanup();
});

function makeGroups(...specs: [string, string[]][]): CarouselGroup[] {
  return specs.map(([id, imageIds]) => ({ id, imageIds }));
}

describe('FEAT-2 — DnD move handler logic', () => {
  function buildHandler(initialGroups: CarouselGroup[]) {
    let groups = JSON.parse(JSON.stringify(initialGroups)) as CarouselGroup[];
    const updateSettings = vi.fn((patch: { carouselGroups: CarouselGroup[] }) => {
      groups = patch.carouselGroups;
    });

    const moveImageToCarousel = (
      imageId: string,
      sourceCarouselId: string | null,
      targetCarouselId: string,
    ) => {
      const working = groups.map((g) => ({ ...g, imageIds: [...g.imageIds] }));

      if (sourceCarouselId) {
        const src = working.find((g) => g.id === sourceCarouselId);
        if (src) src.imageIds = src.imageIds.filter((id) => id !== imageId);
      }

      if (targetCarouselId.startsWith('new-group-')) {
        const targetImageId = targetCarouselId.replace('new-group-', '');
        if (targetImageId === imageId) return;
        working.push({ id: `manual-${targetImageId}`, imageIds: [targetImageId, imageId] });
      } else {
        const tgt = working.find((g) => g.id === targetCarouselId);
        if (tgt) {
          if (tgt.imageIds.includes(imageId)) return;
          tgt.imageIds.push(imageId);
        } else {
          return;
        }
      }

      const cleaned = working.filter((g) => g.imageIds.length >= 2);
      updateSettings({ carouselGroups: cleaned });
    };

    return { moveImageToCarousel, updateSettings, getGroups: () => groups };
  }

  it('moves image from carousel A to carousel B', () => {
    const { moveImageToCarousel, getGroups } = buildHandler(
      makeGroups(['A', ['img1', 'img2', 'img3']], ['B', ['img4', 'img5']]),
    );
    moveImageToCarousel('img1', 'A', 'B');
    const groups = getGroups();
    expect(groups.find((g) => g.id === 'A')!.imageIds).toEqual(['img2', 'img3']);
    expect(groups.find((g) => g.id === 'B')!.imageIds).toEqual(['img4', 'img5', 'img1']);
  });

  it('auto-dissolves source carousel when it drops below 2 images', () => {
    const { moveImageToCarousel, getGroups } = buildHandler(
      makeGroups(['A', ['img1', 'img2']], ['B', ['img3', 'img4']]),
    );
    moveImageToCarousel('img1', 'A', 'B');
    const groups = getGroups();
    expect(groups.find((g) => g.id === 'A')).toBeUndefined();
    expect(groups.find((g) => g.id === 'B')!.imageIds).toEqual(['img3', 'img4', 'img1']);
  });

  it('creates new group when single dropped onto another single', () => {
    const { moveImageToCarousel, getGroups } = buildHandler([]);
    moveImageToCarousel('imgA', null, 'new-group-imgB');
    const groups = getGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe('manual-imgB');
    expect(groups[0].imageIds).toEqual(['imgB', 'imgA']);
  });

  it('same-source-target is guarded at the DndGrid level (handler removes + re-adds)', () => {
    const { moveImageToCarousel, getGroups } = buildHandler(
      makeGroups(['A', ['img1', 'img2']]),
    );
    moveImageToCarousel('img1', 'A', 'A');
    const g = getGroups().find((g) => g.id === 'A');
    expect(g).toBeDefined();
    expect(g!.imageIds).toContain('img1');
  });

  it('no-ops when image already in target', () => {
    const { moveImageToCarousel, updateSettings } = buildHandler(
      makeGroups(['A', ['img1', 'img2']], ['B', ['img1', 'img3']]),
    );
    moveImageToCarousel('img1', 'A', 'B');
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('no-ops when dropping a single onto itself', () => {
    const { moveImageToCarousel, updateSettings } = buildHandler([]);
    moveImageToCarousel('imgA', null, 'new-group-imgA');
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('no-ops when target carousel does not exist', () => {
    const { moveImageToCarousel, updateSettings } = buildHandler([]);
    moveImageToCarousel('img1', null, 'nonexistent');
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('handles moving from carousel to a new-group (single target)', () => {
    const { moveImageToCarousel, getGroups } = buildHandler(
      makeGroups(['A', ['img1', 'img2', 'img3']]),
    );
    moveImageToCarousel('img1', 'A', 'new-group-imgX');
    const groups = getGroups();
    expect(groups.find((g) => g.id === 'A')!.imageIds).toEqual(['img2', 'img3']);
    expect(groups.find((g) => g.id === 'manual-imgX')!.imageIds).toEqual(['imgX', 'img1']);
  });
});

describe('FEAT-2 — DraggableSingleWrapper rendering', () => {
  it('renders children and drag handle', async () => {
    const { DraggableSingleWrapper } = await import('@/components/postready/PostReadyDndGrid');
    const { DndContext } = await import('@dnd-kit/core');

    const { container } = render(
      <DndContext>
        <DraggableSingleWrapper imageId="img-1" imageUrl="https://cdn.example.com/1.jpg">
          <div data-testid="child">Card content</div>
        </DraggableSingleWrapper>
      </DndContext>,
    );

    expect(container.querySelector('[data-testid="child"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Drag to reorder"]')).not.toBeNull();
  });
});

describe('FEAT-2 — moveCarouselGroup reorder logic', () => {
  /**
   * Mirrors the implementation at MainContent.tsx:dndMoveHandler.moveCarouselGroup.
   * Pulled out for unit testing; the production handler also pushes the
   * pre-move snapshot to dndUndoStackRef and emits a toast — those are
   * exercised by component tests, not this pure-logic unit.
   */
  function reorder(
    groups: CarouselGroup[],
    groupId: string,
    beforeGroupId: string | null,
  ): CarouselGroup[] {
    const next = [...groups];
    const fromIdx = next.findIndex((g) => g.id === groupId);
    if (fromIdx === -1) return groups; // auto-detected — no-op
    const [moved] = next.splice(fromIdx, 1);
    // Mirrors MainContent: unknown beforeGroupId (e.g. slot before a
    // single-image card whose id is not in carouselGroups) falls through
    // to "insert at end" — never silently snaps to position 0.
    const beforeIdx = beforeGroupId === null
      ? -1
      : next.findIndex((g) => g.id === beforeGroupId);
    const insertIdx = beforeIdx === -1 ? next.length : beforeIdx;
    next.splice(insertIdx, 0, moved);
    return next;
  }

  it('moves a group to before another group', () => {
    const groups = makeGroups(
      ['A', ['1', '2']],
      ['B', ['3', '4']],
      ['C', ['5', '6']],
    );
    const next = reorder(groups, 'C', 'A');
    expect(next.map((g) => g.id)).toEqual(['C', 'A', 'B']);
  });

  it('moves a group to the end when beforeGroupId is null', () => {
    const groups = makeGroups(
      ['A', ['1', '2']],
      ['B', ['3', '4']],
      ['C', ['5', '6']],
    );
    const next = reorder(groups, 'A', null);
    expect(next.map((g) => g.id)).toEqual(['B', 'C', 'A']);
  });

  it('no-ops when the group is not in the explicit list', () => {
    const groups = makeGroups(['A', ['1', '2']]);
    const next = reorder(groups, 'auto-detected', 'A');
    expect(next).toBe(groups); // identity — same reference
  });

  it('preserves group contents during reorder', () => {
    const groups = makeGroups(
      ['A', ['1', '2', '3']],
      ['B', ['4', '5']],
    );
    const next = reorder(groups, 'B', 'A');
    expect(next.find((g) => g.id === 'B')!.imageIds).toEqual(['4', '5']);
    expect(next.find((g) => g.id === 'A')!.imageIds).toEqual(['1', '2', '3']);
  });

  it('falls through to end when beforeGroupId is not in the group list', () => {
    // Slots rendered before single-image cards pass an image id, not a
    // group id. Those drops should land at the end, not silently snap to
    // position 0.
    const groups = makeGroups(
      ['A', ['1', '2']],
      ['B', ['3', '4']],
      ['C', ['5', '6']],
    );
    const next = reorder(groups, 'A', 'image-not-in-groups');
    expect(next.map((g) => g.id)).toEqual(['B', 'C', 'A']);
  });
});

describe('FEAT-2 — DndUndoToast', () => {
  it('renders message + Undo button when message is non-null', async () => {
    const { DndUndoToast } = await import('@/components/postready/DndUndoToast');
    const { container, getByTestId } = render(
      <DndUndoToast message="Image moved" onUndo={() => {}} onDismiss={() => {}} />,
    );
    expect(getByTestId('dnd-undo-toast')).toBeTruthy();
    expect(container.textContent).toContain('Image moved');
    expect(container.textContent).toContain('Undo');
  });

  it('renders nothing when message is null', async () => {
    const { DndUndoToast } = await import('@/components/postready/DndUndoToast');
    const { container } = render(
      <DndUndoToast message={null} onUndo={() => {}} onDismiss={() => {}} />,
    );
    expect(container.querySelector('[data-testid="dnd-undo-toast"]')).toBeNull();
  });

  it('fires onUndo when the Undo button is clicked', async () => {
    const { DndUndoToast } = await import('@/components/postready/DndUndoToast');
    const { fireEvent } = await import('@testing-library/react');
    const onUndo = vi.fn();
    const { getByTestId } = render(
      <DndUndoToast message="Carousel reordered" onUndo={onUndo} onDismiss={() => {}} />,
    );
    fireEvent.click(getByTestId('dnd-undo-toast-button'));
    expect(onUndo).toHaveBeenCalledOnce();
  });

  it('self-dismisses after durationMs elapses', async () => {
    const { DndUndoToast } = await import('@/components/postready/DndUndoToast');
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <DndUndoToast message="Image moved" onUndo={() => {}} onDismiss={onDismiss} durationMs={100} />,
    );
    vi.advanceTimersByTime(150);
    expect(onDismiss).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
