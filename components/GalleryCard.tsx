'use client';

// TECHDEBT-002: extracted from MainContent's gallery + studio image grid.
// The card body was ~400 LOC of inline JSX inside MainContent's render
// — same shape used by both the studio and gallery views, just with
// different overlay buttons gated by the `view` prop. Lifting it here
// cuts MainContent by ~250 LOC (props plumbing replaces the inline
// JSX) and makes per-card changes (DESIGN-002 tweaks, KebabMenu items,
// hover overlays) editable without scrolling through 4700 lines.
//
// No visual regression: the JSX is a verbatim move; only state that
// used to live in MainContent's local scope is now arrived at via props.

import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useImageSrc } from '@/hooks/useImageSrc';
import { motion } from 'motion/react';
import {
  Bookmark,
  BookmarkCheck,
  Download,
  FolderOpen,
  FolderPlus,
  ImageOff,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Stamp,
  Tag,
  Trash2,
  Video,
  XCircle,
} from 'lucide-react';
import { LazyImg } from './LazyImg';
import { KebabMenu, type KebabMenuItem } from './KebabMenu';
import { gold as uiGold, status as uiStatus } from '@/lib/ui-tokens';
import type {
  Collection,
  GeneratedImage,
  UserSettings,
  ViewType,
} from '@/types/mashup';

interface GalleryCardProps {
  image: GeneratedImage;
  /** Index in the visible grid — drives the staggered fade-in. */
  index: number;
  view: ViewType;
  /** True when the image is also in savedImages (for the studio Save button). */
  isSaved: boolean;
  settings: UserSettings;
  collections: Collection[];
  selectedForBatch: Set<string>;
  /** Currently-tagging image id, or null. Globally locks the tag action. */
  taggingId: string | null;
  /** Currently post-preparing image id, or null. Globally locks Save→Post. */
  preparingPostId: string | null;
  /** Set of model ids currently in flight — drives the Re-roll spinner. */
  isGenerating: boolean;
  /** Currently-drop-target collection id (drag-and-drop visual feedback). */
  dragOverCollection: string | null;

  // Setters (state slices owned by MainContent)
  onOpen: (image: GeneratedImage) => void;
  onToggleBatch: (next: Set<string>) => void;
  setDragOverCollection: (id: string | null) => void;
  setTaggingId: (id: string | null) => void;
  setPreparingPostId: (id: string | null) => void;
  setShowCollectionModal: (open: boolean) => void;
  setView: (view: ViewType) => void;

  // Handlers
  handleAnimate: (image: GeneratedImage) => void;
  rerollImage: (id: string, prompt: string) => void;
  toggleApproveImage: (id: string) => void;
  addImageToCollection: (imageId: string, collectionId: string) => void;
  removeImageFromCollection: (imageId: string) => void;
  saveImage: (image: GeneratedImage) => void;
  deleteImage: (id: string, fromSaved: boolean) => void;
  generatePostContent: (image: GeneratedImage) => Promise<GeneratedImage | undefined>;
  autoTagImage: (id: string, providedImage?: GeneratedImage) => Promise<void>;
  /** V1.5: re-apply the current watermark to this image (images only).
   *  M3.1: takes the image as an argument so MainContent can pass ONE
   *  stable handler instead of a per-card inline lambda — a fresh
   *  lambda identity per render would defeat the React.memo below. */
  onReapplyWatermark?: (image: GeneratedImage) => void;
}

// M3.1 (V1.8): memoized with default shallow comparison — NOT a custom
// comparator that whitelists fields (that would silently drop renders
// when e.g. tags/caption/approved change). Effective because every
// handler prop now has a stable identity (MashupContext routes all
// function fields through useStableCallbacks; MainContent's local
// handlers use useStableCallback) and `displayedImages` is memoized,
// so unrelated provider ticks (pipeline log lines, progress) no longer
// re-render N cards — each of which re-runs useImageSrc's async
// asset:// resolution (O(N) Tauri IPC calls per tick while scrolling).
export const GalleryCard = memo(function GalleryCard({
  image: img,
  index: idx,
  view,
  isSaved,
  settings,
  collections,
  selectedForBatch,
  taggingId,
  preparingPostId,
  isGenerating,
  dragOverCollection,
  onOpen,
  onToggleBatch,
  setDragOverCollection,
  setTaggingId,
  setPreparingPostId,
  setShowCollectionModal,
  setView,
  handleAnimate,
  rerollImage,
  toggleApproveImage,
  addImageToCollection,
  removeImageFromCollection,
  saveImage,
  deleteImage,
  generatePostContent,
  autoTagImage,
  onReapplyWatermark,
}: GalleryCardProps) {
  // V060-COLL-001: click-driven + portaled "Add to Collection" menu.
  // The previous hover-driven dropdown was clipped by sibling cards in
  // the grid because `z-index` does not cross stacking contexts. Render
  // through `createPortal(..., document.body)` with `position: fixed`,
  // anchored to the folder button's rect and re-computed on scroll/
  // resize (same pattern as the Post Ready kebab).
  const [collectionOpen, setCollectionOpen] = useState(false);
  const collectionBtnRef = useRef<HTMLButtonElement>(null);
  const collectionMenuRef = useRef<HTMLDivElement>(null);
  const COLLECTION_MENU_WIDTH = 192;
  const [collectionMenuPos, setCollectionMenuPos] = useState<{ top: number; left: number } | null>(
    null,
  );

  // V105.1-REACT-19: setCollectionMenuPos deferred via queueMicrotask
  // (project convention) so the effect body only manages the
  // window listeners (external system) and the initial position
  // computation, not local state in the body.
  useEffect(() => {
    if (!collectionOpen) {
      queueMicrotask(() => setCollectionMenuPos(null));
      return;
    }
    const recompute = () => {
      const rect = collectionBtnRef.current?.getBoundingClientRect();
      if (!rect) return;
      setCollectionMenuPos({ top: rect.bottom + 8, left: rect.right - COLLECTION_MENU_WIDTH });
    };
    queueMicrotask(recompute);
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (collectionBtnRef.current?.contains(target)) return;
      if (collectionMenuRef.current?.contains(target)) return;
      setCollectionOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', recompute, true);
    window.addEventListener('resize', recompute);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', recompute, true);
      window.removeEventListener('resize', recompute);
    };
  }, [collectionOpen]);

  // V1.3.4: resolve the local-file path (if any) to a webview-
  // loadable URL. Falls back to the CDN url / base64 inside the
  // hook itself. `resolvedSrc` is what `<LazyImg src=...>` reads.
  const resolvedSrc = useImageSrc(img);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.4, delay: idx * 0.1, ease: 'easeOut' }}
      whileHover={{ scale: 1.02, y: -4, transition: { type: 'spring', stiffness: 300, damping: 25 } }}
      onClick={() => onOpen(img)}
      role="button"
      tabIndex={0}
      aria-label={`Open image details: ${img.prompt.slice(0, 80)}`}
      onKeyDown={(e) => {
        // Only react to Enter/Space when the card itself is focused — nested
        // buttons/inputs handle their own keyboard activation.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(img);
        }
      }}
      className={`group relative bg-zinc-900/80 backdrop-blur-sm border rounded-2xl overflow-hidden transition-all duration-300 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00e6ff] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050505] ${
        dragOverCollection ? 'ring-2 ring-[#00e6ff] border-[#00e6ff]/50' : 'border-[#c5a062]/20 hover:border-[#c5a062]/60 hover:shadow-[0_8px_40px_rgba(197,160,98,0.18),0_0_0_1px_rgba(197,160,98,0.15)]'
      }`}
      draggable={view === 'gallery'}
      onDragStart={(e) => {
        const native = e as unknown as React.DragEvent;
        native.dataTransfer.setData('imageId', img.id);
        native.dataTransfer.effectAllowed = 'move';
      }}
    >
      <div
        className={`aspect-square relative overflow-hidden bg-zinc-950 ${img.approved ? 'ring-2 ring-emerald-500/60 ring-inset' : ''}`}
      >
        {(img.status === 'generating' || img.status === 'animating') && (
          <div className="absolute inset-0 z-40 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center gap-3 p-4 text-center">
            <div className="relative">
              <div className="w-12 h-12 rounded-full border-2 border-indigo-500/20 border-t-indigo-500 animate-spin" />
              <Sparkles className="absolute inset-0 m-auto w-5 h-5 text-indigo-400 animate-pulse" />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-bold text-white uppercase tracking-widest">
                {img.status === 'generating' ? 'Materializing' : 'Animating'}
              </p>
              <p className="text-[10px] text-zinc-400">
                {img.status === 'generating' ? 'Crafting across universes...' : 'Breathing life into pixels...'}
              </p>
            </div>
          </div>
        )}
        {img.status === 'error' && (
          <div className="absolute inset-0 z-40 bg-red-950/80 backdrop-blur-sm flex flex-col items-center justify-center gap-2 p-4 text-center">
            <div className="w-12 h-12 rounded-full bg-red-500/20 border border-red-500/40 flex items-center justify-center">
              <XCircle className="w-6 h-6 text-red-400" />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-bold text-red-300 uppercase tracking-widest">Generation Failed</p>
              <p className="text-[10px] text-red-200/80 max-w-[90%] leading-tight">
                {img.error || 'Unknown error'}
              </p>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                deleteImage(img.id, view === 'gallery');
              }}
              className="mt-1 px-3 py-1 text-[10px] bg-red-600/80 hover:bg-red-500 text-white rounded-lg transition-colors"
            >
              Dismiss
            </button>
          </div>
        )}
        {view === 'gallery' && !img.isVideo && img.imageId && (
          // V080-DEV-001: z-40 keeps the checkbox above the top action
          // overlay (also z-30, but rendered later in DOM so it would
          // otherwise win the hit test on equal z) — prior to the bump
          // the invisible action overlay's empty left area ate every
          // click on the checkbox, making batch selection unusable.
          <div className="absolute top-4 left-4 z-40">
            <input
              type="checkbox"
              checked={selectedForBatch.has(img.id)}
              onChange={(e) => {
                e.stopPropagation();
                const next = new Set(selectedForBatch);
                if (e.target.checked) next.add(img.id);
                else next.delete(img.id);
                onToggleBatch(next);
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-5 h-5 rounded border-zinc-600 bg-zinc-900/80 backdrop-blur-sm text-emerald-600 focus:ring-emerald-500 cursor-pointer accent-[#c5a062]"
            />
          </div>
        )}

        {img.isVideo ? (
          <div className="relative w-full h-full">
            {/* CDN-expiry fallback — revealed when video onError fires */}
            <div className="absolute inset-0 flex items-center justify-center">
              <ImageOff className="w-8 h-8 text-zinc-700" />
            </div>
            <video
              src={img.url}
              autoPlay
              loop
              muted
              playsInline
              className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
            {settings.watermark?.enabled && (
              <div
                className={`absolute pointer-events-none z-10 ${
                  settings.watermark.position === 'bottom-right' ? 'bottom-2 right-2' :
                  settings.watermark.position === 'bottom-left' ? 'bottom-2 left-2' :
                  settings.watermark.position === 'top-right' ? 'top-2 right-2' :
                  settings.watermark.position === 'top-left' ? 'top-2 left-2' : 'bottom-2 right-2'
                }`}
                style={{ opacity: settings.watermark.opacity || 0.8 }}
              >
                {settings.watermark.image ? (
                  <img src={settings.watermark.image} alt="Watermark" className="absolute inset-0 w-full h-full object-contain" referrerPolicy="no-referrer" />
                ) : settings.channelName ? (
                  <span className="text-white bg-black/50 px-2 py-1 rounded text-xs font-bold">{settings.channelName}</span>
                ) : null}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* CDN-expiry fallback — sits behind LazyImg at z-0;
                revealed automatically when onError hides the img */}
            <div className="absolute inset-0 flex items-center justify-center z-0">
              <ImageOff className="w-8 h-8 text-zinc-700" />
            </div>
            <LazyImg
              src={resolvedSrc || `data:image/jpeg;base64,${img.base64}`}
              alt={img.prompt}
              className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
              referrerPolicy="no-referrer"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          </>
        )}

        {/* Gap 2: provider badge — top-right, permanent at z-5 so action buttons
            (z-30, hover-only) appear above it. Shows Higgsfield in cyan,
            MiniMax in purple, Leonardo in gold so the user can see at a glance
            which backend produced each image. */}
        {img.modelInfo?.provider && (
          <div className="absolute top-2 right-2 z-[5] pointer-events-none select-none">
            <span
              className={`inline-flex items-center px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide backdrop-blur-md rounded-full border ${
                img.modelInfo.provider === 'higgsfield'
                  ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                  : img.modelInfo.provider === 'minimax' || img.modelInfo.provider === 'mmx'
                  ? 'bg-purple-500/20 text-purple-300 border-purple-500/40'
                  : 'bg-[#c5a062]/20 text-[#c5a062] border-[#c5a062]/40'
              }`}
            >
              {img.modelInfo.provider === 'higgsfield'
                ? 'Higgsfield'
                : img.modelInfo.provider === 'minimax' || img.modelInfo.provider === 'mmx'
                ? 'MiniMax'
                : 'Leonardo'}
            </span>
          </div>
        )}

        {/* QOL-FE01: collection membership badge — bottom-left, above model chips. */}
        {img.collectionId && (() => {
          const col = collections.find(c => c.id === img.collectionId);
          if (!col) return null;
          const label = col.name.length > 12 ? col.name.slice(0, 12) + '…' : col.name;
          return (
            <div className="absolute bottom-9 left-2 z-[5] pointer-events-none select-none opacity-80 group-hover:opacity-100 transition-opacity">
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide bg-[#c5a062]/15 text-[#c5a062] border border-[#c5a062]/40 rounded-full backdrop-blur-md">
                <FolderOpen className="w-2.5 h-2.5" />
                {label}
              </span>
            </div>
          );
        })()}

        {/* DESIGN-002 §3: permanent model chip (bottom-left).
            Replaces the bottom-left "Approved" pill — the inset
            emerald ring already conveys approved state.
            Style chip sits alongside when the generation picked a style. */}
        <div className="absolute bottom-2 left-2 z-[5] flex items-center gap-1 pointer-events-none select-none">
          {img.modelInfo?.modelName && (
            <span
              className={`px-1.5 py-0.5 text-[9px] font-semibold tracking-wide uppercase bg-black/55 backdrop-blur-md ${uiGold.text} border ${uiGold.border.default} rounded-full max-w-[80px] truncate`}
              title={img.modelInfo.modelName}
            >
              {img.modelInfo.modelName}
            </span>
          )}
          {img.style && (
            <span
              className="px-1.5 py-0.5 text-[9px] font-medium tracking-wide bg-[#c5a062]/20 backdrop-blur-md text-[#c5a062] border border-[#c5a062]/40 rounded-full max-w-[110px] truncate"
              title={`Style: ${img.style}`}
            >
              {img.style}
            </span>
          )}
        </div>

        {/* Top Actions Overlay — compact icon row (3 primary + kebab, DESIGN-002 §3.7).
            BUG-CRIT-010: z-30 keeps the row (and its KebabMenu dropdown,
            which opens downward into the prompt area) painted above the
            bottom prompt overlay at z-[20]. Without the bump, the overlay's
            later DOM order beat the row at the same z-20, so kebab items
            rendered behind the prompt and the Delete button was unclickable. */}
        <div className="absolute top-0 left-0 right-0 p-2 flex justify-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-300 z-30">
          {view === 'studio' && !img.isVideo && (
            <button
              onClick={(e) => { e.stopPropagation(); rerollImage(img.id, img.prompt); }}
              disabled={isGenerating}
              className="w-8 h-8 flex items-center justify-center bg-black/50 hover:bg-emerald-500/80 text-white rounded-xl backdrop-blur-md transition-colors"
              title="Re-roll Image"
            >
              <RefreshCw className={`w-4 h-4 ${isGenerating ? 'animate-spin' : ''}`} />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); toggleApproveImage(img.id); }}
            className={`w-8 h-8 flex items-center justify-center rounded-xl backdrop-blur-md transition-colors ${
              img.approved
                ? 'bg-emerald-500 text-white'
                : 'bg-black/50 hover:bg-emerald-500/80 text-white'
            }`}
            title={img.approved ? 'Unapprove Image' : 'Approve Image'}
          >
            <BookmarkCheck className="w-4 h-4" />
          </button>
          {view === 'gallery' && (
            <div className="relative">
              <button
                ref={collectionBtnRef}
                onClick={(e) => { e.stopPropagation(); setCollectionOpen((v) => !v); }}
                aria-haspopup="menu"
                aria-expanded={collectionOpen}
                className="w-8 h-8 flex items-center justify-center bg-black/50 hover:bg-emerald-500/80 text-white rounded-xl backdrop-blur-md transition-colors"
                title="Add to Collection"
              >
                <FolderPlus className="w-4 h-4" />
              </button>
              {collectionOpen && collectionMenuPos && typeof document !== 'undefined' && createPortal(
                <div
                  ref={collectionMenuRef}
                  role="menu"
                  className="fixed z-[9999] w-48 bg-zinc-900 border border-zinc-800/60 rounded-xl shadow-2xl p-2"
                  style={{ top: collectionMenuPos.top, left: collectionMenuPos.left }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest px-2 py-1 mb-1">Add to Collection</p>
                  {collections.map((col) => (
                    <button
                      key={col.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        addImageToCollection(img.id, col.id);
                        setCollectionOpen(false);
                      }}
                      onDragOver={(e) => { e.preventDefault(); setDragOverCollection(col.id); }}
                      onDragLeave={() => setDragOverCollection(null)}
                      onDrop={(e) => {
                        e.preventDefault();
                        const droppedImageId = e.dataTransfer.getData('imageId');
                        if (droppedImageId) addImageToCollection(droppedImageId, col.id);
                        setDragOverCollection(null);
                        setCollectionOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors ${
                        dragOverCollection === col.id ? 'bg-emerald-500 text-white scale-105' :
                        img.collectionId === col.id ? 'bg-emerald-500/20 text-emerald-400' : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'
                      }`}
                    >
                      {col.name}
                    </button>
                  ))}
                  {img.collectionId && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeImageFromCollection(img.id);
                        setCollectionOpen(false);
                      }}
                      className="w-full text-left px-3 py-2 rounded-lg text-xs text-red-400 hover:bg-red-500/10 transition-colors mt-1 border-t border-zinc-800 pt-2"
                    >
                      Remove from Collection
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowCollectionModal(true);
                      setCollectionOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 rounded-lg text-xs ${uiStatus.success.text} hover:bg-emerald-500/10 transition-colors mt-1 border-t border-zinc-800 pt-2 flex items-center gap-2`}
                  >
                    <Plus className="w-3 h-3" />
                    New Collection
                  </button>
                </div>,
                document.body,
              )}
            </div>
          )}
          {view !== 'gallery' && (
            <button
              onClick={(e) => { e.stopPropagation(); saveImage(img); }}
              disabled={isSaved}
              className={`w-8 h-8 flex items-center justify-center rounded-xl backdrop-blur-md transition-colors ${
                isSaved
                  ? 'bg-emerald-500/80 text-white cursor-default'
                  : 'bg-black/50 hover:bg-black/80 text-white'
              }`}
              title={isSaved ? 'Saved to Gallery' : 'Save to Gallery'}
            >
              {isSaved ? <BookmarkCheck className="w-4 h-4" /> : <Bookmark className="w-4 h-4" />}
            </button>
          )}
          {view === 'gallery' && (
            <button
              disabled={preparingPostId === img.id}
              onClick={async (e) => {
                e.stopPropagation();
                if (preparingPostId) return;
                setPreparingPostId(img.id);
                try {
                  if (!img.approved) toggleApproveImage(img.id);
                  if (!img.postCaption) await generatePostContent(img);
                  await saveImage({ ...img, isPostReady: true });
                  setView('post-ready');
                } finally {
                  setPreparingPostId(null);
                }
              }}
              className="w-8 h-8 flex items-center justify-center bg-black/50 hover:bg-emerald-500/80 disabled:opacity-60 disabled:hover:bg-black/50 text-white rounded-xl backdrop-blur-md transition-colors"
              title={preparingPostId === img.id ? 'Generating caption…' : 'Prepare for Post'}
            >
              {preparingPostId === img.id ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Save className="w-4 h-4" />
              )}
            </button>
          )}
          <KebabMenu
            ariaLabel={`More actions for ${img.prompt.slice(0, 60)}`}
            items={(() => {
              const isTagging = taggingId === img.id;
              const hasTags = !!(img.tags && img.tags.length > 0);
              const preparing = preparingPostId === img.id;
              const downloadItem: KebabMenuItem = {
                kind: 'item',
                id: 'download',
                label: 'Download',
                icon: Download,
                onSelect: () => {
                  const href = img.url || `data:image/jpeg;base64,${img.base64}`;
                  const a = document.createElement('a');
                  a.href = href;
                  a.download = `mashup-${img.id}.jpg`;
                  if (img.url) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                },
              };
              const animateItem: KebabMenuItem | null =
                img.imageId && !img.isVideo
                  ? {
                      kind: 'item',
                      id: 'animate',
                      label: img.status === 'animating' ? 'Animating…' : 'Animate',
                      icon: img.status === 'animating' ? Loader2 : Video,
                      disabled: img.status === 'animating',
                      onSelect: () => handleAnimate(img),
                    }
                  : null;
              // V1.5: re-apply the current watermark (images only).
              const reapplyWatermarkItem: KebabMenuItem | null =
                onReapplyWatermark && !img.isVideo
                  ? {
                      kind: 'item',
                      id: 'reapply-watermark',
                      label: 'Re-apply watermark',
                      icon: Stamp,
                      onSelect: () => onReapplyWatermark(img),
                    }
                  : null;
              const items: (KebabMenuItem | null)[] =
                view === 'gallery'
                  ? [
                      animateItem,
                      reapplyWatermarkItem,
                      {
                        kind: 'item',
                        id: 'auto-tag',
                        label: isTagging
                          ? 'Tagging…'
                          : hasTags ? 'Re-generate tags' : 'Auto-tag',
                        icon: isTagging ? Loader2 : Tag,
                        disabled: isTagging,
                        onSelect: () => {
                          if (taggingId) return;
                          setTaggingId(img.id);
                          autoTagImage(img.id, img).finally(() => setTaggingId(null));
                        },
                      },
                      downloadItem,
                      { kind: 'separator' },
                      {
                        kind: 'item',
                        id: 'delete',
                        label: 'Delete',
                        icon: Trash2,
                        destructive: true,
                        onSelect: () => deleteImage(img.id, true),
                      },
                    ]
                  : [
                      animateItem,
                      reapplyWatermarkItem,
                      {
                        kind: 'item',
                        id: 'save-for-post',
                        label: preparing ? 'Generating caption…' : 'Prepare for Post',
                        icon: preparing ? Loader2 : Save,
                        disabled: preparing,
                        onSelect: async () => {
                          if (preparingPostId) return;
                          setPreparingPostId(img.id);
                          try {
                            if (!img.approved) toggleApproveImage(img.id);
                            if (!img.postCaption) await generatePostContent(img);
                            await saveImage({ ...img, isPostReady: true });
                            setView('post-ready');
                          } finally {
                            setPreparingPostId(null);
                          }
                        },
                      },
                      downloadItem,
                      { kind: 'separator' },
                      {
                        kind: 'item',
                        id: 'delete',
                        label: 'Delete',
                        icon: Trash2,
                        destructive: true,
                        onSelect: () => deleteImage(img.id, false),
                      },
                    ];
              return items.filter((x): x is KebabMenuItem => x !== null);
            })()}
          />
        </div>

        {/* DESIGN-002 §3.5/§3.6: slimmed bottom hover panel. */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/15 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-3 pt-12 pointer-events-none z-[20]">
          <p className="text-xs text-zinc-200 line-clamp-2 mb-1.5 font-medium leading-snug shadow-sm pointer-events-auto">
            {img.prompt}
          </p>
          {img.tags && img.tags.length > 0 ? (
            <div className="flex gap-1 overflow-hidden pointer-events-auto">
              {img.tags.slice(0, 3).map((t) => (
                <span
                  key={t}
                  className="shrink-0 px-1.5 py-0.5 text-[9px] bg-[#c5a062]/15 text-[#c5a062]/85 border border-[#c5a062]/25 rounded-full whitespace-nowrap"
                >
                  {t}
                </span>
              ))}
              {img.tags.length > 3 && (
                <span className="shrink-0 px-1.5 py-0.5 text-[9px] text-zinc-400 whitespace-nowrap">
                  +{img.tags.length - 3}
                </span>
              )}
            </div>
          ) : view === 'gallery' ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (taggingId) return;
                setTaggingId(img.id);
                autoTagImage(img.id, img).finally(() => setTaggingId(null));
              }}
              disabled={taggingId === img.id}
              className="self-start inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] bg-[#c5a062]/10 hover:bg-[#c5a062]/25 text-[#c5a062]/90 hover:text-[#c5a062] border border-[#c5a062]/30 rounded-full whitespace-nowrap pointer-events-auto disabled:opacity-60 disabled:cursor-wait transition-colors"
              title="Auto-generate tags via pi.dev"
            >
              {taggingId === img.id ? (
                <>
                  <Loader2 className="w-2.5 h-2.5 animate-spin" />
                  Tagging…
                </>
              ) : (
                <>
                  <Tag className="w-2.5 h-2.5" />
                  Auto-tag
                </>
              )}
            </button>
          ) : null}
        </div>

        {/* Animating Overlay */}
        {img.status === 'animating' && (
          <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center z-30 backdrop-blur-sm">
            <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mb-3" />
            <span className="text-sm font-medium text-white">Generating Video...</span>
          </div>
        )}
      </div>
    </motion.div>
  );
});
