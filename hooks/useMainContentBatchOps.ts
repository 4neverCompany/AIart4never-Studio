/**
 * useMainContentBatchOps — M3.3-P4 Batch 1 extraction.
 *
 * Owns the gallery-batch operations: multi-select state + selection
 * predicates + bulk delete/animate/caption/post-ready/collection
 * handlers. Plus the auto-organize-by-tag handler that calls into
 * `useCollections.proposeTagGroups`.
 *
 * No behavior changes — this is a pure code-move.
 */

import { useState, useCallback } from 'react';
import { showToast } from '@/components/Toast';
import { proposeTagGroups } from '@/hooks/useCollections';
import type { Collection, GeneratedImage } from '@/components/MashupContext';
import type { ViewType } from '@/components/MashupContext';

export interface BatchOpsBag {
  selectedForBatch: Set<string>;
  setSelectedForBatch: React.Dispatch<React.SetStateAction<Set<string>>>;
  dragOverCollection: string | null;
  setDragOverCollection: React.Dispatch<React.SetStateAction<string | null>>;

  handleBatchAnimate: (animate: (img: GeneratedImage, isBatch?: boolean) => Promise<void>) => Promise<void>;
  handleBatchDelete: (deleteImage: (id: string, fromSaved: boolean) => void) => void;
  handleSelectAllGallery: (displayedImages: GeneratedImage[]) => void;
  handleClearGallerySelection: () => void;
  handleBatchAddToCollection: (
    collectionId: string,
    addImageToCollection: (imageId: string, collectionId: string) => void,
    collections: Collection[],
  ) => void;
  handleSelectApproved: (displayedImages: GeneratedImage[]) => void;
  handleSelectInCollection: (
    displayedImages: GeneratedImage[],
    selectedCollectionId: string,
  ) => void;
  handleInvertSelection: (displayedImages: GeneratedImage[]) => void;
  handleBatchCreateCollection: (setShowCollectionModal: (b: boolean) => void) => void;
  handleAutoOrganizeByTag: (
    savedImages: GeneratedImage[],
    createCollection: (
      name?: string,
      description?: string,
      imageIds?: string[],
      savedImages?: GeneratedImage[],
    ) => Promise<Collection | null | undefined>,
    addImageToCollection: (imageId: string, collectionId: string) => void,
  ) => Promise<void>;
}

export function useMainContentBatchOps(): BatchOpsBag {
  const [selectedForBatch, setSelectedForBatch] = useState<Set<string>>(new Set());
  const [dragOverCollection, setDragOverCollection] = useState<string | null>(null);

  const handleBatchAnimate = useCallback(
    async (animate: (img: GeneratedImage, isBatch?: boolean) => Promise<void>) => {
      // Caller passes a closure that already filtered by (selectedForBatch + animate-eligible).
      // We clear the selection AFTER the caller resolved its own async fan-out
      // (kept in original order so the previous per-batch behavior is preserved).
      // The caller is responsible for the actual filter & fan-out — see
      // `MainContent.handleBatchAnimate` for the original implementation
      // that depended on `savedImages` etc.
      // To keep the hook surface small we accept a closure that does the work.
      await animate({} as GeneratedImage, true);
      setSelectedForBatch(new Set());
    },
    [],
  );

  const handleBatchDelete = useCallback(
    (deleteImage: (id: string, fromSaved: boolean) => void) => {
      const ids = Array.from(selectedForBatch);
      if (ids.length === 0) return;
      for (const id of ids) deleteImage(id, true);
      setSelectedForBatch(new Set());
      showToast(`Deleted ${ids.length} image${ids.length === 1 ? '' : 's'}.`, 'success');
    },
    [selectedForBatch],
  );

  // handleBatchCaption + handleBatchPostReady live in MainContent because
  // they need setView + saveImage + savedImages in scope, which the hook
  // doesn't see. The hook just provides the selection-set primitives the
  // parent uses to bind the bound versions.

  const handleSelectAllGallery = useCallback(
    (displayedImages: GeneratedImage[]) => {
      setSelectedForBatch(new Set(displayedImages.map((img) => img.id)));
    },
    [],
  );

  const handleClearGallerySelection = useCallback(() => {
    setSelectedForBatch(new Set());
  }, []);

  const handleBatchAddToCollection = useCallback(
    (
      collectionId: string,
      addImageToCollection: (imageId: string, collectionId: string) => void,
      collections: Collection[],
    ) => {
      const ids = Array.from(selectedForBatch);
      if (ids.length === 0) return;
      for (const id of ids) addImageToCollection(id, collectionId);
      setSelectedForBatch(new Set());
      const collection = collections.find((c) => c.id === collectionId);
      showToast(
        `${ids.length} image${ids.length === 1 ? '' : 's'} added to ${collection?.name ?? 'collection'}.`,
        'success',
      );
    },
    [selectedForBatch],
  );

  const handleSelectApproved = useCallback((displayedImages: GeneratedImage[]) => {
    setSelectedForBatch(new Set(displayedImages.filter((img) => img.approved).map((img) => img.id)));
  }, []);

  const handleSelectInCollection = useCallback(
    (displayedImages: GeneratedImage[], selectedCollectionId: string) => {
      if (selectedCollectionId === 'all') return;
      setSelectedForBatch(
        new Set(
          displayedImages
            .filter((img) => img.collectionId === selectedCollectionId)
            .map((img) => img.id),
        ),
      );
    },
    [],
  );

  const handleInvertSelection = useCallback(
    (displayedImages: GeneratedImage[]) => {
      setSelectedForBatch(
        (prev) =>
          new Set(displayedImages.filter((img) => !prev.has(img.id)).map((img) => img.id)),
      );
    },
    [],
  );

  // V082-COLLECTION-FEATURES: open the collection modal in "batch" mode.
  const handleBatchCreateCollection = useCallback(
    (setShowCollectionModal: (b: boolean) => void) => {
      if (selectedForBatch.size === 0) return;
      setShowCollectionModal(true);
    },
    [selectedForBatch],
  );

  // V082-COLLECTION-FEATURES: scan saved images, bucket them by tag, and
  // for each bucket ≥ 3 images create a collection and assign every
  // matching image to it. Uses window.confirm for scope.
  const handleAutoOrganizeByTag = useCallback(
    async (
      savedImages: GeneratedImage[],
      createCollection: (
        name?: string,
        description?: string,
        imageIds?: string[],
        savedImages?: GeneratedImage[],
      ) => Promise<Collection | null | undefined>,
      addImageToCollection: (imageId: string, collectionId: string) => void,
    ) => {
      if (savedImages.length === 0) return;
      const proposals = proposeTagGroups(savedImages, 3);
      if (proposals.length === 0) {
        window.alert('No tag groups found. Tag at least 3 images with the same tag first.');
        return;
      }
      const preview = proposals
        .slice(0, 8)
        .map((g) => `  • ${g.displayName} (${g.imageIds.length})`)
        .join('\n');
      const more = proposals.length > 8 ? `\n  … +${proposals.length - 8} more` : '';
      const ok = window.confirm(
        `Auto-organize will create ${proposals.length} collection${proposals.length === 1 ? '' : 's'}:\n\n${preview}${more}\n\nContinue?`,
      );
      if (!ok) return;
      for (const group of proposals) {
        const collection = await createCollection(group.displayName, undefined, undefined, undefined);
        if (!collection) continue;
        for (const imageId of group.imageIds) {
          const img = savedImages.find((i) => i.id === imageId);
          if (img && !img.collectionId) addImageToCollection(imageId, collection.id);
        }
      }
    },
    [],
  );

  return {
    selectedForBatch,
    setSelectedForBatch,
    dragOverCollection,
    setDragOverCollection,
    handleBatchAnimate,
    handleBatchDelete,
    handleSelectAllGallery,
    handleClearGallerySelection,
    handleBatchAddToCollection,
    handleSelectApproved,
    handleSelectInCollection,
    handleInvertSelection,
    handleBatchCreateCollection,
    handleAutoOrganizeByTag,
  };
}
