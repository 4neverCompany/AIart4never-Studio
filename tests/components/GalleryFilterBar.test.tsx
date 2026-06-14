// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { GalleryFilterBar, type GalleryFilterBarProps } from '@/components/GalleryFilterBar';

beforeEach(() => {
  cleanup();
});

function makeProps(overrides: Partial<GalleryFilterBarProps> = {}): GalleryFilterBarProps {
  return {
    galleryStats: { total: 10, tagged: 4, captioned: 3 },
    postReadyCount: 2,
    displayedCount: 10,
    selectedForBatch: new Set(),
    searchQuery: '',
    sortBy: 'newest',
    filterModel: 'all',
    filterUniverse: 'all',
    selectedCollectionId: 'all',
    tagQuery: '',
    collections: [],
    onSearchChange: vi.fn(),
    onSortChange: vi.fn(),
    onFilterModelChange: vi.fn(),
    onFilterUniverseChange: vi.fn(),
    onCollectionChange: vi.fn(),
    onTagQueryChange: vi.fn(),
    onBulkTag: vi.fn(),
    onBatchPostReady: vi.fn(),
    onBatchCaption: vi.fn(),
    onBatchAnimate: vi.fn(),
    onBatchDelete: vi.fn(),
    onBatchCreateCollection: vi.fn(),
    onBatchAddToCollection: vi.fn(),
    onAutoOrganizeByTag: vi.fn(),
    onSelectAll: vi.fn(),
    onClearSelection: vi.fn(),
    onSelectApproved: vi.fn(),
    onSelectInCollection: vi.fn(),
    onInvertSelection: vi.fn(),
    ...overrides,
  };
}

describe('GalleryFilterBar', () => {
  it('renders the Gallery heading', () => {
    render(<GalleryFilterBar {...makeProps()} />);
    expect(screen.getByText('Gallery')).toBeInTheDocument();
  });

  it('shows correct stat counts in header', () => {
    render(<GalleryFilterBar {...makeProps()} />);
    expect(screen.getByText('10 images')).toBeInTheDocument();
    expect(screen.getByText('4 tagged')).toBeInTheDocument();
    expect(screen.getByText('3 captioned')).toBeInTheDocument();
    expect(screen.getByText('2 post-ready')).toBeInTheDocument();
  });

  it('calls onSearchChange when typing in search box', () => {
    const onSearchChange = vi.fn();
    render(<GalleryFilterBar {...makeProps({ onSearchChange })} />);
    fireEvent.change(screen.getByPlaceholderText('Search by prompt or tags...'), {
      target: { value: 'spider-man' },
    });
    expect(onSearchChange).toHaveBeenCalledWith('spider-man');
  });

  it('calls onSortChange when changing sort select', () => {
    const onSortChange = vi.fn();
    render(<GalleryFilterBar {...makeProps({ onSortChange })} />);
    fireEvent.change(screen.getByDisplayValue('Newest First'), {
      target: { value: 'oldest' },
    });
    expect(onSortChange).toHaveBeenCalledWith('oldest');
  });

  it('calls onFilterModelChange when clicking a model pill', () => {
    const onFilterModelChange = vi.fn();
    render(<GalleryFilterBar {...makeProps({ onFilterModelChange })} />);
    // "All" model pill is always present
    fireEvent.click(screen.getAllByRole('button', { name: 'All' })[0]);
    expect(onFilterModelChange).toHaveBeenCalledWith('all');
  });

  it('calls onFilterUniverseChange when changing universe select', () => {
    const onFilterUniverseChange = vi.fn();
    render(<GalleryFilterBar {...makeProps({ onFilterUniverseChange })} />);
    fireEvent.change(screen.getByDisplayValue('All Universes'), {
      target: { value: 'Marvel' },
    });
    expect(onFilterUniverseChange).toHaveBeenCalledWith('Marvel');
  });

  it('calls onCollectionChange when changing collection select', () => {
    const onCollectionChange = vi.fn();
    const collections = [{ id: 'c1', name: 'Favorites', createdAt: 0 }];
    render(<GalleryFilterBar {...makeProps({ onCollectionChange, collections })} />);
    fireEvent.change(screen.getByDisplayValue('All Collections'), {
      target: { value: 'c1' },
    });
    expect(onCollectionChange).toHaveBeenCalledWith('c1');
  });

  it('renders collection options from props', () => {
    const collections = [
      { id: 'c1', name: 'Marvels', createdAt: 0 },
      { id: 'c2', name: 'DC Villains', createdAt: 0 },
    ];
    render(<GalleryFilterBar {...makeProps({ collections })} />);
    expect(screen.getByRole('option', { name: 'Marvels' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'DC Villains' })).toBeInTheDocument();
  });

  it('shows Select All button when selection is empty and there are displayed images', () => {
    render(<GalleryFilterBar {...makeProps({ selectedForBatch: new Set(), displayedCount: 5 })} />);
    expect(screen.getByRole('button', { name: 'Select All' })).toBeInTheDocument();
  });

  it('hides Select All button when displayedCount is 0 and selection is empty', () => {
    render(<GalleryFilterBar {...makeProps({ selectedForBatch: new Set(), displayedCount: 0 })} />);
    expect(screen.queryByRole('button', { name: 'Select All' })).not.toBeInTheDocument();
  });

  it('calls onSelectAll when clicking Select All', () => {
    const onSelectAll = vi.fn();
    render(<GalleryFilterBar {...makeProps({ onSelectAll, displayedCount: 5 })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    expect(onSelectAll).toHaveBeenCalledOnce();
  });

  it('shows batch action bar when items are selected', () => {
    const selected = new Set(['img-1', 'img-2']);
    render(<GalleryFilterBar {...makeProps({ selectedForBatch: selected })} />);
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Post Ready/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Caption/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Animate/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Tag/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
  });

  it('calls onBatchPostReady when clicking Post Ready', () => {
    const onBatchPostReady = vi.fn();
    render(<GalleryFilterBar {...makeProps({ selectedForBatch: new Set(['a']), onBatchPostReady })} />);
    fireEvent.click(screen.getByRole('button', { name: /Post Ready/i }));
    expect(onBatchPostReady).toHaveBeenCalledOnce();
  });

  it('calls onBatchCaption when clicking Caption', () => {
    const onBatchCaption = vi.fn();
    render(<GalleryFilterBar {...makeProps({ selectedForBatch: new Set(['a']), onBatchCaption })} />);
    fireEvent.click(screen.getByRole('button', { name: /Caption/i }));
    expect(onBatchCaption).toHaveBeenCalledOnce();
  });

  it('calls onBatchDelete when clicking Delete', () => {
    const onBatchDelete = vi.fn();
    render(<GalleryFilterBar {...makeProps({ selectedForBatch: new Set(['a']), onBatchDelete })} />);
    fireEvent.click(screen.getByRole('button', { name: /Delete/i }));
    expect(onBatchDelete).toHaveBeenCalledOnce();
  });

  it('calls onClearSelection when clicking Clear', () => {
    const onClearSelection = vi.fn();
    render(<GalleryFilterBar {...makeProps({ selectedForBatch: new Set(['a']), onClearSelection })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClearSelection).toHaveBeenCalledOnce();
  });

  it('calls onBulkTag when clicking Tag', () => {
    const onBulkTag = vi.fn();
    render(<GalleryFilterBar {...makeProps({ selectedForBatch: new Set(['a']), onBulkTag })} />);
    fireEvent.click(screen.getByRole('button', { name: /^Tag$/i }));
    expect(onBulkTag).toHaveBeenCalledOnce();
  });

  it('shows tag query clear button only when tagQuery is non-empty', () => {
    const { rerender } = render(<GalleryFilterBar {...makeProps({ tagQuery: '' })} />);
    expect(screen.queryByRole('button', { name: 'Clear search query' })).not.toBeInTheDocument();

    rerender(<GalleryFilterBar {...makeProps({ tagQuery: 'Marvel' })} />);
    expect(screen.getByRole('button', { name: 'Clear search query' })).toBeInTheDocument();
  });

  it('calls onTagQueryChange with empty string when clicking tag clear button', () => {
    const onTagQueryChange = vi.fn();
    render(<GalleryFilterBar {...makeProps({ tagQuery: 'DC', onTagQueryChange })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search query' }));
    expect(onTagQueryChange).toHaveBeenCalledWith('');
  });

  describe('FEAT-3 — Batch add to collection dropdown', () => {
    const collections = [
      { id: 'c1', name: 'Marvels', createdAt: 0 },
      { id: 'c2', name: 'DC Villains', createdAt: 0 },
    ];

    it('opens menu and lists existing collections when Collection button clicked', () => {
      render(<GalleryFilterBar {...makeProps({ selectedForBatch: new Set(['a']), collections })} />);
      fireEvent.click(screen.getByRole('button', { name: /Collection/i }));
      expect(screen.getByRole('menu', { name: /add selected images to collection/i })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /Marvels/ })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /DC Villains/ })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /New collection/i })).toBeInTheDocument();
    });

    it('calls onBatchAddToCollection with collection id when an existing collection is picked', () => {
      const onBatchAddToCollection = vi.fn();
      render(
        <GalleryFilterBar
          {...makeProps({ selectedForBatch: new Set(['a']), collections, onBatchAddToCollection })}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Collection/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Marvels/ }));
      expect(onBatchAddToCollection).toHaveBeenCalledWith('c1');
    });

    it('calls onBatchCreateCollection when "New collection…" is picked', () => {
      const onBatchCreateCollection = vi.fn();
      render(
        <GalleryFilterBar
          {...makeProps({ selectedForBatch: new Set(['a']), collections, onBatchCreateCollection })}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Collection/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: /New collection/i }));
      expect(onBatchCreateCollection).toHaveBeenCalledOnce();
    });

    it('shows only "New collection…" when there are no existing collections', () => {
      render(<GalleryFilterBar {...makeProps({ selectedForBatch: new Set(['a']), collections: [] })} />);
      fireEvent.click(screen.getByRole('button', { name: /Collection/i }));
      expect(screen.getByRole('menuitem', { name: /New collection/i })).toBeInTheDocument();
      expect(screen.queryByText('Add to collection')).not.toBeInTheDocument();
    });
  });

  describe('Smart bulk select', () => {
    it('shows the Approved quick-select when there are displayed images', () => {
      render(<GalleryFilterBar {...makeProps({ displayedCount: 5 })} />);
      expect(screen.getByRole('button', { name: 'Approved' })).toBeInTheDocument();
    });

    it('hides quick-select cluster when there are no displayed images', () => {
      render(<GalleryFilterBar {...makeProps({ displayedCount: 0 })} />);
      expect(screen.queryByRole('button', { name: 'Approved' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'This Collection' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Invert' })).not.toBeInTheDocument();
    });

    it('hides "This Collection" when no collection is filtered', () => {
      render(<GalleryFilterBar {...makeProps({ displayedCount: 5, selectedCollectionId: 'all' })} />);
      expect(screen.queryByRole('button', { name: 'This Collection' })).not.toBeInTheDocument();
    });

    it('shows "This Collection" when a collection is filtered', () => {
      render(<GalleryFilterBar {...makeProps({ displayedCount: 5, selectedCollectionId: 'c1' })} />);
      expect(screen.getByRole('button', { name: 'This Collection' })).toBeInTheDocument();
    });

    it('hides Invert when nothing is selected', () => {
      render(<GalleryFilterBar {...makeProps({ displayedCount: 5, selectedForBatch: new Set() })} />);
      expect(screen.queryByRole('button', { name: 'Invert' })).not.toBeInTheDocument();
    });

    it('shows Invert when at least one item is selected', () => {
      render(<GalleryFilterBar {...makeProps({ displayedCount: 5, selectedForBatch: new Set(['a']) })} />);
      expect(screen.getByRole('button', { name: 'Invert' })).toBeInTheDocument();
    });

    it('calls onSelectApproved, onSelectInCollection, onInvertSelection on click', () => {
      const onSelectApproved = vi.fn();
      const onSelectInCollection = vi.fn();
      const onInvertSelection = vi.fn();
      render(
        <GalleryFilterBar
          {...makeProps({
            displayedCount: 5,
            selectedCollectionId: 'c1',
            selectedForBatch: new Set(['a']),
            onSelectApproved,
            onSelectInCollection,
            onInvertSelection,
          })}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Approved' }));
      fireEvent.click(screen.getByRole('button', { name: 'This Collection' }));
      fireEvent.click(screen.getByRole('button', { name: 'Invert' }));
      expect(onSelectApproved).toHaveBeenCalledOnce();
      expect(onSelectInCollection).toHaveBeenCalledOnce();
      expect(onInvertSelection).toHaveBeenCalledOnce();
    });
  });
});
