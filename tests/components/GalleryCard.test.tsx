// @vitest-environment jsdom
//
// V080-DEV-001 regression: gallery batch checkbox must be clickable.
//
// Bug: the top-action overlay div (line ~297) spans the full top of
// the card at z-30 and was rendered LATER in the DOM than the
// checkbox container at the same z-30. With equal z-index, later DOM
// wins both the paint and the hit test — so the (invisible while
// not hovering) action overlay's empty left area ate every click on
// the checkbox, making batch selection silently unusable.
//
// Fix: bump the checkbox container to z-40 so it always wins the
// hit test against the top action overlay. This test pins the
// click contract so a future restyle can't silently regress it.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { GalleryCard } from '@/components/GalleryCard';
import type { GeneratedImage, UserSettings } from '@/types/mashup';

beforeEach(() => {
  cleanup();
});

function makeImage(overrides: Partial<GeneratedImage> = {}): GeneratedImage {
  return {
    id: 'img-1',
    prompt: 'Batman vs Darth Vader in neon Tokyo',
    url: 'https://cdn.example.com/img-1.jpg',
    status: 'ready',
    // imageId required for the checkbox branch (`view === 'gallery' &&
    // !img.isVideo && img.imageId`).
    imageId: 'leo-img-1',
    isVideo: false,
    ...overrides,
  };
}

function makeSettings(): UserSettings {
  return {} as UserSettings;
}

function makeProps(overrides: Partial<React.ComponentProps<typeof GalleryCard>> = {}) {
  const img = overrides.image ?? makeImage();
  return {
    image: img,
    index: 0,
    view: 'gallery' as const,
    isSaved: true,
    settings: makeSettings(),
    collections: [],
    selectedForBatch: new Set<string>(),
    taggingId: null,
    preparingPostId: null,
    isGenerating: false,
    dragOverCollection: null,
    onOpen: vi.fn(),
    onToggleBatch: vi.fn(),
    setDragOverCollection: vi.fn(),
    setTaggingId: vi.fn(),
    setPreparingPostId: vi.fn(),
    setShowCollectionModal: vi.fn(),
    setView: vi.fn(),
    handleAnimate: vi.fn(),
    rerollImage: vi.fn(),
    toggleApproveImage: vi.fn(),
    addImageToCollection: vi.fn(),
    removeImageFromCollection: vi.fn(),
    saveImage: vi.fn(),
    deleteImage: vi.fn(),
    generatePostContent: vi.fn().mockResolvedValue(undefined),
    autoTagImage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('V080-DEV-001 — Gallery batch checkbox', () => {
  it('renders the checkbox in the gallery view for non-video images with an imageId', () => {
    const { container } = render(<GalleryCard {...makeProps()} />);
    const checkbox = container.querySelector('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
  });

  it('does NOT render the checkbox in studio view', () => {
    const { container } = render(<GalleryCard {...makeProps({ view: 'studio' })} />);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('does NOT render the checkbox for videos', () => {
    const { container } = render(
      <GalleryCard {...makeProps({ image: makeImage({ isVideo: true }) })} />,
    );
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('clicking an unchecked checkbox calls onToggleBatch with the image id added', () => {
    const onToggleBatch = vi.fn();
    const { container } = render(
      <GalleryCard {...makeProps({ onToggleBatch })} />,
    );
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);

    expect(onToggleBatch).toHaveBeenCalledTimes(1);
    const next = onToggleBatch.mock.calls[0]![0] as Set<string>;
    expect(next.has('img-1')).toBe(true);
  });

  it('clicking a checked checkbox calls onToggleBatch with the image id removed', () => {
    const onToggleBatch = vi.fn();
    const { container } = render(
      <GalleryCard {...makeProps({
        selectedForBatch: new Set(['img-1']),
        onToggleBatch,
      })} />,
    );
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);

    expect(onToggleBatch).toHaveBeenCalledTimes(1);
    const next = onToggleBatch.mock.calls[0]![0] as Set<string>;
    expect(next.has('img-1')).toBe(false);
  });

  it('checkbox click does NOT propagate to the card open handler', () => {
    const onOpen = vi.fn();
    const onToggleBatch = vi.fn();
    const { container } = render(
      <GalleryCard {...makeProps({ onOpen, onToggleBatch })} />,
    );
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);

    expect(onToggleBatch).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('checkbox container sits above the top action overlay (z-40 vs z-30) so click hit-tests reach it', () => {
    const { container } = render(<GalleryCard {...makeProps()} />);
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    // Walk up to the absolute-positioned wrapper that owns the z-class.
    const wrapper = checkbox.closest('div.absolute.top-4.left-4');
    expect(wrapper).not.toBeNull();
    // The bug shape: z-30 on this wrapper === z-30 on the action overlay
    // (rendered later in DOM) → action overlay wins the hit test.
    // Pin the higher z so a future restyle has to consciously break it.
    expect(wrapper!.className).toMatch(/\bz-40\b/);
    expect(wrapper!.className).not.toMatch(/\bz-30\b/);
  });
});

describe('QOL-FE01 — Collection badge', () => {
  it('renders collection badge when image has a valid collectionId', () => {
    const { container } = render(
      <GalleryCard {...makeProps({
        image: makeImage({ collectionId: 'col-1' }),
        collections: [{ id: 'col-1', name: 'Favorites', createdAt: 0 }],
      })} />,
    );
    expect(container.textContent).toContain('Favorites');
  });

  it('does not render badge when collectionId is absent', () => {
    const { container } = render(
      <GalleryCard {...makeProps({
        image: makeImage({ collectionId: undefined }),
        collections: [{ id: 'col-1', name: 'Favorites', createdAt: 0 }],
      })} />,
    );
    expect(container.textContent).not.toContain('Favorites');
  });

  it('does not render badge for orphan collectionId (collection deleted)', () => {
    const { container } = render(
      <GalleryCard {...makeProps({
        image: makeImage({ collectionId: 'deleted-col' }),
        collections: [],
      })} />,
    );
    const folderIcons = container.querySelectorAll('[class*="w-2.5"][class*="h-2.5"]');
    const hasBadgeWrapper = container.querySelector('.bottom-9');
    expect(hasBadgeWrapper).toBeNull();
  });

  it('truncates long collection names to 12 chars', () => {
    const { container } = render(
      <GalleryCard {...makeProps({
        image: makeImage({ collectionId: 'col-long' }),
        collections: [{ id: 'col-long', name: 'Extraordinarily Long Name', createdAt: 0 }],
      })} />,
    );
    expect(container.textContent).toContain('Extraordinar…');
    expect(container.textContent).not.toContain('Extraordinarily');
  });
});
