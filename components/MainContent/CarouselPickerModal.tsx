'use client';

/**
 * CarouselPickerModal — M3.3-P4 Batch 1 extraction.
 *
 * The multi-source image-picker modal used to live inline in
 * `components/MainContent.tsx` (lines 4934-5059). Lifted out so the
 * Captioning AND Post-Ready tabs (and any future tab) can trigger
 * it without MainContent growing further.
 *
 * Owns its own `pickerSelected` Set. Source pool is every approved
 * OR post-ready saved image so users can mix both stages into one
 * carousel. Backed by the parent's `onConfirm` callback.
 *
 * No behavior changes — this is a pure code-move.
 */

import { useState, useEffect } from 'react';
import { Check, ImageOff, LayoutGrid, X } from 'lucide-react';
import { motion } from 'motion/react';
import { LazyImg } from '../LazyImg';
import type { CarouselGroup, GeneratedImage } from '@/types/mashup';

export interface CarouselPickerModalProps {
  open: boolean;
  onClose: () => void;
  pickerTargetGroupId: string | null;
  savedImages: GeneratedImage[];
  carouselGroups: CarouselGroup[];
  /** Called with the chosen image ids (≥ 2). */
  onConfirm: (imageIds: string[]) => void;
}

export function CarouselPickerModal({
  open,
  onClose,
  pickerTargetGroupId,
  savedImages,
  carouselGroups,
  onConfirm,
}: CarouselPickerModalProps) {
  // Seed selection with the group's current members when editing.
  // Re-seed whenever the modal opens (or the target changes) so
  // closing + re-opening with a different target gets a fresh
  // initial state, matching the original in-MainContent behavior
  // where `openCarouselPicker` reset `pickerSelected` before showing.
  const [pickerSelected, setPickerSelected] = useState<Set<string>>(new Set());

  // Sync the picker selection from the target group on an OPEN
  // transition (guarded by `if (!open) return`) — the original
  // in-MainContent reset behavior. Not a pure derived value:
  // pickerSelected is also mutated by user clicks while open.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    if (pickerTargetGroupId) {
      const g = (carouselGroups || []).find((x) => x.id === pickerTargetGroupId);
      setPickerSelected(new Set(g?.imageIds || []));
    } else {
      setPickerSelected(new Set());
    }
  }, [open, pickerTargetGroupId, carouselGroups]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!open) return null;

  const pickerSource = savedImages.filter((i) => i.approved || i.isPostReady);

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900/95 backdrop-blur-xl border-0 sm:border border-[#c5a062]/25 rounded-none sm:rounded-2xl w-full sm:max-w-4xl h-full sm:h-auto max-h-[100dvh] sm:max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-zinc-800/60">
          <div className="flex items-center gap-3">
            <div className="icon-box-blue">
              <LayoutGrid className="w-5 h-5 text-[#00e6ff]" />
            </div>
            <div>
              <h3 className="type-title">
                {pickerTargetGroupId ? 'Edit Carousel' : 'Create Carousel'}
              </h3>
              <p className="text-xs text-zinc-500">
                Pick 2 or more images to group them into a single multi-image post.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-full"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {pickerSource.length === 0 ? (
            <p className="text-sm text-zinc-500 text-center py-8">
              No approved saved images yet.
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {pickerSource.map((img) => {
                const inAnotherGroup = (carouselGroups || []).some(
                  (g) => g.id !== pickerTargetGroupId && g.imageIds.includes(img.id),
                );
                const selected = pickerSelected.has(img.id);
                return (
                  <motion.button
                    key={img.id}
                    whileHover={
                      inAnotherGroup
                        ? undefined
                        : { scale: 1.03, transition: { type: 'spring', stiffness: 300, damping: 25 } }
                    }
                    whileTap={inAnotherGroup ? undefined : { scale: 0.9 }}
                    onClick={() => {
                      if (inAnotherGroup) return;
                      const next = new Set(pickerSelected);
                      if (next.has(img.id)) next.delete(img.id);
                      else next.add(img.id);
                      setPickerSelected(next);
                    }}
                    disabled={inAnotherGroup}
                    className={`relative aspect-square rounded-xl overflow-hidden border-2 transition-all ${
                      inAnotherGroup
                        ? 'border-zinc-800/40 opacity-30 cursor-not-allowed'
                        : selected
                          ? 'border-emerald-500 ring-2 ring-emerald-500/30'
                          : 'border-zinc-800/60 hover:border-zinc-600'
                    }`}
                    title={inAnotherGroup ? 'Already in another carousel' : img.prompt}
                  >
                    {img.url ? (
                      <LazyImg
                        src={img.url}
                        alt={img.prompt}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-zinc-950">
                        <ImageOff className="w-6 h-6 text-zinc-700" />
                      </div>
                    )}
                    {img.isPostReady && (
                      <span className="absolute bottom-1 left-1 px-1.5 py-0.5 bg-emerald-600/90 text-[8px] font-medium text-white rounded">
                        Post Ready
                      </span>
                    )}
                    {selected && (
                      <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center">
                        <Check className="w-3 h-3" />
                      </div>
                    )}
                  </motion.button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between p-4 border-t border-zinc-800/60">
          <span className="text-xs text-zinc-500">
            {pickerSelected.size} selected
            {pickerSelected.size < 2 && (
              <span className="text-amber-400 ml-2">
                Pick at least 2 images to form a carousel.
              </span>
            )}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl"
            >
              Cancel
            </button>
            <button
              onClick={() => onConfirm(Array.from(pickerSelected))}
              disabled={pickerSelected.size < 2}
              className="btn-blue-sm"
            >
              <Check className="w-3.5 h-3.5" />
              {pickerTargetGroupId ? 'Update Carousel' : 'Create Carousel'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
