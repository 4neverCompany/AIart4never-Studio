'use client';

/**
 * CaptioningView — M3.3-P4 Batch 1 extraction.
 *
 * The Captioning Studio tab used to live inline in
 * `components/MainContent.tsx` (lines 3011-3463). It was a single
 * 450-LOC IIFE rendering both the grouped-carousel cards and the
 * per-image single cards, plus the per-tab filter / group-similar /
 * batch-caption action bar.
 *
 * Extracted as a presentational sub-component. Owns its own per-tab
 * UI state (filter / grouped-toggle / selection / pending-remove
 * confirmation / batch-progress / preparing-id). Receives every
 * behaviour call from the parent (patchImage, fanCaptionToGroup,
 * computeCarouselView, etc.) so the view remains a pure props-bag.
 *
 * No behavior changes — this is a pure code-move.
 */

import { useState } from 'react';
import {
  Check,
  CheckCircle2,
  Columns,
  Edit3,
  ImageIcon,
  ImageOff,
  LayoutGrid,
  Loader2,
  Plus,
  Sparkles,
  Stamp,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { LazyImg } from '../LazyImg';
import { AutoTextarea } from '../AutoTextarea';
import type { CarouselGroup, GeneratedImage, ViewType } from '@/types/mashup';
import type { PostItem } from '@/lib/carouselView';

export interface CaptioningViewProps {
  savedImages: GeneratedImage[];
  setView: (v: ViewType) => void;
  setSelectedImage: (img: GeneratedImage) => void;

  // Caption generation + image patch helpers
  generatePostContent: (img: GeneratedImage) => Promise<GeneratedImage | undefined>;
  patchImage: (img: GeneratedImage, patch: Partial<GeneratedImage>) => void;
  removeHashtag: (img: GeneratedImage, index: number) => void;
  handleReapplyWatermark: (img: GeneratedImage) => Promise<void>;

  // Carousel-aware captioning
  computeCarouselView: (images: GeneratedImage[]) => PostItem[];
  propagateCaptionToGroup: (
    group: GeneratedImage[],
    caption: string,
    hashtags: string[] | undefined,
    opts?: { skipExisting?: boolean; excludeId?: string },
  ) => void;
  fanCaptionToGroup: (
    anchor: GeneratedImage,
    rest: GeneratedImage[],
    opts?: { force?: boolean },
  ) => Promise<GeneratedImage | undefined>;
  persistCarouselGroup: (id: string, imageIds: string[], patch?: Partial<CarouselGroup>) => void;
  separateCarousel: (groupId: string) => void;
  openCarouselPicker: (targetGroupId: string | null) => void;
  setPreparingPostId: (id: string | null) => void;
}

export function CaptioningView({
  savedImages,
  setView,
  setSelectedImage,
  generatePostContent,
  patchImage,
  removeHashtag,
  handleReapplyWatermark,
  computeCarouselView,
  propagateCaptionToGroup,
  fanCaptionToGroup,
  persistCarouselGroup,
  separateCarousel,
  openCarouselPicker,
  setPreparingPostId,
}: CaptioningViewProps) {
  // Captioning Studio tab state
  const [captioningFilter, setCaptioningFilter] = useState<'all' | 'captioned' | 'uncaptioned'>('all');
  // Whether the tab auto-groups similar images into carousel cards
  // (reuses the Post Ready computeCarouselView logic). Default ON.
  const [captioningGrouped, setCaptioningGrouped] = useState(true);
  // When grouping is OFF, users can check individual cards and manually
  // promote a selection to a carousel group.
  const [captioningSelected, setCaptioningSelected] = useState<Set<string>>(new Set());
  // Captioning tab "remove" confirmation — tracks which image id is pending
  // confirmation so we can show an inline ✓/✗ pair instead of window.confirm.
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  // Track which image is currently having its caption generated so we can
  // show a per-card spinner while the pi caption request runs. Keyed by
  // image id.
  const [preparingPostId, setLocalPreparingPostId] = useState<string | null>(null);
  const [batchCaptioning, setBatchCaptioning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);

  // Source of truth: savedImages (persisted). Captioning is a
  // curated workflow — ephemeral gallery images shouldn't
  // pollute this tab. Images promoted to Post Ready are
  // excluded so the two tabs form a clean pipeline.
  const all = savedImages.filter((i) => !i.isPostReady && i.approved);
  const captioned = all.filter((i) => !!i.postCaption);
  const uncaptioned = all.filter((i) => !i.postCaption);
  const visible =
    captioningFilter === 'captioned'
      ? captioned
      : captioningFilter === 'uncaptioned'
        ? uncaptioned
        : all;

  // Run the batch caption flow. Local wrapper that drives the spinner
  // state + progress display; the actual fan-out is identical to the
  // previous in-MainContent implementation.
  const runBatchCaption = async (candidates: GeneratedImage[]) => {
    type Entry =
      | { kind: 'single'; img: GeneratedImage }
      | { kind: 'carousel'; anchor: GeneratedImage; rest: GeneratedImage[] };

    const entries: Entry[] = [];
    if (captioningGrouped) {
      for (const v of computeCarouselView(candidates)) {
        if (v.kind === 'carousel') {
          if (v.images.every((i) => i.postCaption)) continue;
          const [anchor, ...rest] = v.images;
          entries.push({ kind: 'carousel', anchor, rest });
        } else if (!v.img.postCaption) {
          entries.push({ kind: 'single', img: v.img });
        }
      }
    } else {
      for (const img of candidates) {
        if (!img.postCaption) entries.push({ kind: 'single', img });
      }
    }

    if (entries.length === 0) return;
    const total = entries.length;
    setBatchCaptioning(true);
    setBatchProgress({ done: 0, total });
    try {
      const CONCURRENCY = 3;
      let cursor = 0;
      let done = 0;
      const runWorker = async () => {
        while (true) {
          const i = cursor++;
          if (i >= total) return;
          const entry = entries[i];
          const anchor = entry.kind === 'single' ? entry.img : entry.anchor;
          setLocalPreparingPostId(anchor.id);
          try {
            if (entry.kind === 'carousel') {
              await fanCaptionToGroup(anchor, entry.rest);
            } else {
              await generatePostContent(anchor);
            }
          } catch {
            // individual batch failure — continue to next entry
          }
          done++;
          setBatchProgress({ done, total });
        }
      };
      const workerCount = Math.min(CONCURRENCY, total);
      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    } finally {
      setLocalPreparingPostId(null);
      setBatchCaptioning(false);
      // Leave the final progress on screen briefly so the user sees "N/N".
      setTimeout(() => setBatchProgress(null), 2000);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="icon-box-blue">
            <Edit3 className="w-5 h-5 text-[#00e6ff]" />
          </div>
          <div>
            <h2 className="type-title">Captioning Studio</h2>
            <p className="text-xs text-zinc-500 mt-1">
              {captioned.length} / {all.length} captioned
              {batchProgress && (
                <span className="ml-3 text-[#00e6ff]">
                  Batch: {batchProgress.done}/{batchProgress.total}
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Filter tabs */}
          <div className="flex bg-zinc-900 border border-zinc-800/60 rounded-full p-0.5">
            {(['all', 'captioned', 'uncaptioned'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setCaptioningFilter(f)}
                className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
                  captioningFilter === f
                    ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {f === 'all' ? 'All' : f === 'captioned' ? 'Captioned' : 'Uncaptioned'}
              </button>
            ))}
          </div>

          {/* Group Similar toggle */}
          <button
            onClick={() => {
              setCaptioningGrouped(!captioningGrouped);
              // Leaving grouped mode clears any stale selection.
              if (captioningGrouped) setCaptioningSelected(new Set());
            }}
            className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors flex items-center gap-1.5 border ${
              captioningGrouped
                ? 'bg-emerald-600/20 text-emerald-400 border-emerald-500/30'
                : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:border-zinc-500'
            }`}
          >
            <LayoutGrid className="w-3.5 h-3.5" />
            {captioningGrouped ? 'Grouped' : 'Group Similar'}
          </button>

          {/* Create Carousel — always visible in grouped mode.
              Opens the multi-source picker so the user can
              pick any combination of images. */}
          {captioningGrouped && (
            <button onClick={() => openCarouselPicker(null)} className="btn-blue-sm rounded-full">
              <LayoutGrid className="w-3.5 h-3.5" />
              Create Carousel
            </button>
          )}

          {/* Manual "Group Selected" — only when grouping toggle is off
              and the user has picked 2+ images with checkboxes. */}
          {!captioningGrouped && captioningSelected.size >= 2 && (
            <button
              onClick={() => {
                const ids = Array.from(captioningSelected);
                persistCarouselGroup(`manual-${ids[0]}`, ids);
                setCaptioningSelected(new Set());
                setCaptioningGrouped(true);
              }}
              className="btn-blue-sm rounded-full"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              Group Selected ({captioningSelected.size})
            </button>
          )}

          <button
            onClick={() => runBatchCaption(visible)}
            disabled={batchCaptioning || uncaptioned.length === 0}
            className="btn-blue-sm rounded-full"
          >
            {batchCaptioning ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Wand2 className="w-3.5 h-3.5" />
            )}
            Batch Caption
          </button>
        </div>
      </div>

      {/* Empty state */}
      {all.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 space-y-3 text-center">
          <ImageIcon className="w-10 h-10 text-zinc-700" />
          <p className="text-sm text-zinc-500">
            No saved images yet. Save images from the gallery to start captioning.
          </p>
          <button
            onClick={() => setView('gallery')}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl text-sm"
          >
            Go to Gallery
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div className="py-12 text-center text-sm text-zinc-500">
          No {captioningFilter} images in this view.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {(captioningGrouped ? computeCarouselView(visible) : visible.map((img) => ({ kind: 'single' as const, img }))).map((entry) => {
            // ── Carousel card (captioning) ────────────────
            if (entry.kind === 'carousel') {
              const anchor = entry.images[0];
              const isWorking = preparingPostId === anchor.id;
              const isExplicit = !!entry.group;
              return (
                <div key={`c-${entry.id}`} className="card overflow-hidden flex flex-col">
                  {/* Image strip */}
                  <div className="relative bg-zinc-950 overflow-x-auto">
                    <div className="flex gap-1 p-2" style={{ minHeight: 140 }}>
                      {entry.images.map((ci) => (
                        <div key={ci.id} className="relative shrink-0 group/ci">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={ci.url}
                            alt={ci.prompt}
                            loading="lazy"
                            onClick={() => setSelectedImage(ci)}
                            className="h-32 w-32 object-cover rounded-xl cursor-zoom-in"
                          />
                          {isExplicit && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                // Inline carousel-image removal handled by parent.
                                // We use the same persistCarouselGroup reducer pattern.
                                const remaining = entry.images.map((i) => i.id).filter((id) => id !== ci.id);
                                if (remaining.length < 2) {
                                  separateCarousel(entry.id);
                                } else {
                                  persistCarouselGroup(entry.id, remaining);
                                }
                              }}
                              className="absolute top-1 right-1 w-5 h-5 rounded-full bg-red-600/90 hover:bg-red-500 text-white flex items-center justify-center opacity-0 group-hover/ci:opacity-100 transition-opacity"
                              title="Remove from carousel"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                    <span className="absolute top-3 left-3 inline-flex items-center gap-1 px-2 py-0.5 bg-[#00e6ff]/15 border border-[#00e6ff]/30 text-[10px] font-medium text-[#00e6ff] rounded-full">
                      <LayoutGrid className="w-3 h-3" /> Carousel · {entry.images.length} images
                    </span>
                    {isExplicit && (
                      <button
                        onClick={() => openCarouselPicker(entry.id)}
                        className="absolute top-3 right-3 px-2 py-0.5 text-[10px] font-medium bg-zinc-900/80 hover:bg-zinc-800 text-zinc-300 border border-zinc-700 rounded-full flex items-center gap-1 transition-colors"
                        title="Add more images to this carousel"
                      >
                        <Plus className="w-3 h-3" /> Add
                      </button>
                    )}
                    {isWorking && (
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center gap-2 text-xs text-white">
                        <Loader2 className="w-4 h-4 animate-spin" /> Generating caption…
                      </div>
                    )}
                  </div>

                  {/* Shared caption body */}
                  <div className="flex-1 p-4 space-y-3">
                    <p className="text-[11px] text-zinc-500 line-clamp-2" title={anchor.prompt}>
                      {anchor.prompt}
                    </p>
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
                        Shared caption
                      </label>
                      <AutoTextarea
                        value={anchor.postCaption || ''}
                        onChange={(e) => {
                          // Fan edits to every image so Post Now
                          // and per-card Copy pick up the same text.
                          propagateCaptionToGroup(entry.images, e.target.value, undefined);
                        }}
                        placeholder="No caption yet…"
                        minRows={2}
                        className="w-full bg-zinc-800/50 border border-zinc-700/50 rounded-xl px-3 py-2 text-sm text-zinc-200 focus:border-[#c5a062]/50 focus:outline-none transition-colors"
                      />
                    </div>
                    {(anchor.postHashtags || []).length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {(anchor.postHashtags ?? []).map((tag, i) => (
                          <span
                            key={`${tag}-${i}`}
                            className="px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded-full text-[10px] text-zinc-300"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Footer actions */}
                  <div className="border-t border-[#c5a062]/15 p-3 flex items-center gap-2">
                    <button
                      disabled={isWorking || batchCaptioning}
                      onClick={async () => {
                        // Generate ONE caption using the anchor's
                        // prompt, then fan it out. Explicit
                        // user click → force overwrite siblings.
                        setLocalPreparingPostId(anchor.id);
                        setPreparingPostId(anchor.id);
                        try {
                          await fanCaptionToGroup(anchor, entry.images, { force: true });
                        } finally {
                          setLocalPreparingPostId(null);
                          setPreparingPostId(null);
                        }
                      }}
                      className="btn-blue-sm flex-1 justify-center"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      {anchor.postCaption ? 'Regenerate' : 'Generate'}
                    </button>
                    <button
                      disabled={!anchor.postCaption}
                      onClick={() => {
                        // Mark every image in the group as ready.
                        for (const ci of entry.images) {
                          patchImage(ci, { isPostReady: true });
                        }
                      }}
                      className="btn-blue-sm justify-center"
                      title="Mark all as ready to post"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    {isExplicit ? (
                      <button
                        onClick={() => separateCarousel(entry.id)}
                        className="px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl flex items-center justify-center gap-1.5 transition-colors"
                        title="Ungroup"
                      >
                        <Columns className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <button
                        onClick={() => persistCarouselGroup(`manual-${anchor.id}`, entry.images.map((i) => i.id))}
                        className="btn-blue-sm justify-center"
                        title="Lock this auto-detected grouping"
                      >
                        <LayoutGrid className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            }

            // ── Single-image card (original) ─────────────
            const img = entry.img;
            const isWorking = preparingPostId === img.id;
            const isSelected = captioningSelected.has(img.id);
            return (
              <div
                key={img.id}
                className={`bg-zinc-900/80 backdrop-blur-sm border rounded-2xl overflow-hidden flex flex-col transition-all duration-200 ${
                  isSelected ? 'border-[#00e6ff]/50 shadow-[0_0_16px_rgba(0,230,255,0.08)]' : 'border-[#c5a062]/20 hover:border-[#c5a062]/40'
                }`}
              >
                {/* Thumbnail */}
                <div className="relative aspect-square bg-zinc-950">
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
                    <div className="w-full h-full flex items-center justify-center">
                      <ImageOff className="w-8 h-8 text-zinc-700" />
                    </div>
                  )}
                  {isWorking && (
                    <div className="absolute inset-0 bg-black/60 flex items-center justify-center gap-2 text-xs text-white">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Generating caption…
                    </div>
                  )}
                  {/* Selection checkbox (manual grouping) —
                      only shown when grouping toggle is OFF. */}
                  {!captioningGrouped && (
                    <div className="absolute top-3 left-3 z-20">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(e) => {
                          const next = new Set(captioningSelected);
                          if (e.target.checked) next.add(img.id);
                          else next.delete(img.id);
                          setCaptioningSelected(next);
                        }}
                        className="w-5 h-5 rounded border-zinc-600 bg-zinc-900/80 backdrop-blur-sm text-emerald-600 focus:ring-emerald-500 cursor-pointer accent-[#c5a062]"
                      />
                    </div>
                  )}
                </div>

                {/* Body */}
                <div className="flex-1 p-4 space-y-3">
                  <p className="text-[11px] text-zinc-500 line-clamp-2" title={img.prompt}>
                    {img.prompt}
                  </p>

                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
                      Caption
                    </label>
                    <AutoTextarea
                      value={img.postCaption || ''}
                      onChange={(e) => patchImage(img, { postCaption: e.target.value })}
                      placeholder="No caption yet…"
                      minRows={2}
                      className="w-full bg-zinc-800/50 border border-zinc-700/50 rounded-xl px-3 py-2 text-sm text-zinc-200 focus:border-[#c5a062]/50 focus:outline-none transition-colors"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
                      Hashtags
                    </label>
                    {(img.postHashtags || []).length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {(img.postHashtags ?? []).map((tag, i) => (
                          <span
                            key={`${tag}-${i}`}
                            className="inline-flex items-center gap-1 px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded-full text-[10px] text-zinc-300"
                          >
                            {tag}
                            <button
                              onClick={() => removeHashtag(img, i)}
                              className="text-zinc-500 hover:text-red-400"
                            >
                              <X className="w-2.5 h-2.5" />
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11px] text-zinc-600 italic">No hashtags.</p>
                    )}
                  </div>
                </div>

                {/* Footer actions */}
                <div className="border-t border-zinc-800 p-3 flex items-center gap-2">
                  <button
                    disabled={isWorking || batchCaptioning}
                    onClick={async () => {
                      setLocalPreparingPostId(img.id);
                      setPreparingPostId(img.id);
                      try {
                        await generatePostContent(img);
                      } finally {
                        setLocalPreparingPostId(null);
                        setPreparingPostId(null);
                      }
                    }}
                    className="btn-blue-sm flex-1 justify-center"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    {img.postCaption ? 'Regenerate' : 'Generate'}
                  </button>
                  {!img.isVideo && (
                    <button
                      onClick={() => handleReapplyWatermark(img)}
                      className="btn-blue-sm justify-center"
                      title="Re-apply watermark with current settings"
                    >
                      <Stamp className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    disabled={!img.postCaption}
                    onClick={() => patchImage(img, { isPostReady: true })}
                    className="btn-blue-sm justify-center"
                    title="Mark as ready to post"
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                  {pendingRemoveId === img.id ? (
                    <div className="flex gap-1" title="Remove from Captioning? Image stays in Gallery.">
                      <button
                        onClick={() => {
                          patchImage(img, { approved: false, postCaption: '', postHashtags: [], tags: [] });
                          setPendingRemoveId(null);
                        }}
                        className="px-2 py-1.5 text-xs bg-red-600/90 hover:bg-red-500 text-white rounded-lg flex items-center gap-1 transition-colors"
                        title="Confirm remove"
                      >
                        <Check className="w-3 h-3" /> Remove
                      </button>
                      <button
                        onClick={() => setPendingRemoveId(null)}
                        className="px-2 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded-lg transition-colors"
                        title="Cancel"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setPendingRemoveId(img.id)}
                      className="px-3 py-1.5 text-xs bg-red-600/20 hover:bg-red-600/80 text-red-400 hover:text-white rounded-xl flex items-center justify-center gap-1.5 transition-colors"
                      title="Remove from Captioning (image stays in Gallery)"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
