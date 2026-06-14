'use client';

/**
 * V060-001 — Simplified Post Ready card for a carousel (multi-image post).
 *
 * Same layout as PostReadyCard: status pill + colored border, collapsed
 * caption / hashtags, two primary buttons + kebab. Differences:
 *   - Image strip across the top (not a single AspectPreview)
 *   - "Separate" / "Lock Group" lives in the kebab, not a primary button
 */

import { useState } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import {
  Check,
  Clock,
  Columns,
  Copy,
  GripVertical,
  LayoutGrid,
  Loader2,
  MinusCircle,
  RefreshCw,
  Send,
  X,
} from 'lucide-react';
import type { DragData } from './PostReadyDndGrid';
import { CountdownBadge } from './CountdownBadge';
import { InlineScheduleCalendar } from './InlineScheduleCalendar';
import { KebabMenu, type KebabMenuItem } from '../KebabMenu';
import {
  derivePostReadyStatus,
  type PostReadyStatusKind,
} from '@/lib/post-ready-status';
import type { GeneratedImage, PostPlatform, ScheduledPost } from '@/types/mashup';

function platformBadgeClass(p: PostPlatform): string {
  if (p === 'instagram') return 'bg-pink-600/90';
  if (p === 'pinterest') return 'bg-red-600/90';
  if (p === 'twitter') return 'bg-sky-600/90';
  return 'bg-indigo-600/90';
}

function visualsForKind(kind: PostReadyStatusKind): {
  border: string;
  pillBg: string;
  pillText: string;
} {
  switch (kind) {
    case 'posted':
      return {
        border: 'border-emerald-500/60',
        pillBg: 'bg-emerald-500/20 border-emerald-400/50',
        pillText: 'text-emerald-300',
      };
    case 'failed':
      return {
        border: 'border-red-500/60',
        pillBg: 'bg-red-500/20 border-red-400/50',
        pillText: 'text-red-300',
      };
    case 'scheduled':
      return {
        border: 'border-sky-500/60',
        pillBg: 'bg-sky-500/20 border-sky-400/50',
        pillText: 'text-sky-300',
      };
    case 'ready':
    default:
      return {
        border: 'border-[#c5a062]/30',
        pillBg: 'bg-zinc-800/80 border-zinc-700',
        pillText: 'text-zinc-200',
      };
  }
}

const HASHTAG_PREVIEW = 3;

export interface PostReadyCarouselCardProps {
  images: GeneratedImage[];
  /** Carousel group ID — used as the droppable zone identifier. */
  carouselId: string;
  /** When true, this is a user-locked group (shows Separate in kebab).
   *  When false, it's an auto-detected group (shows Lock Group instead). */
  isExplicit: boolean;
  scheduledPost: ScheduledPost | undefined;
  allScheduledPosts: ScheduledPost[];
  selectedPlatforms: PostPlatform[];
  available: PostPlatform[];
  busy: 'posting' | 'scheduling' | null | undefined;
  status: string | null | undefined;
  isRegen: boolean;
  copyHighlighted: boolean;

  onPreviewClick: (img: GeneratedImage) => void;
  onCaptionChange: (next: string) => void;
  onTogglePlatform: (p: PostPlatform) => void;
  onPostNow: () => void;
  onSchedule: (date: string, time: string) => void;
  onCopy: () => void;
  onRegen: () => void;
  onUnreadyAll: () => void;
  /** Only invoked when isExplicit is true. */
  onSeparate: () => void;
  /** Only invoked when isExplicit is false. */
  onLockGroup: () => void;
  /** Unschedule all posts in this carousel without rejecting. Only
   *  shown when at least one post is still scheduled. */
  onCancelSchedule?: () => void;
}

function DroppableImageStrip({
  carouselId,
  children,
}: {
  carouselId: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: `drop-${carouselId}`,
    data: { carouselId },
  });
  // FEAT-2 §3.5: only image-kind drags are valid drops on the strip.
  const isImageDrag = (active?.data.current as DragData | undefined)?.kind !== 'carousel';

  return (
    <div
      ref={setNodeRef}
      className={`bg-zinc-950 overflow-x-auto transition-colors ${
        isOver && isImageDrag ? 'bg-[#00e6ff]/5 ring-1 ring-[#00e6ff]/50' : ''
      }`}
    >
      {isOver && isImageDrag && (
        <div className="h-0.5 w-full bg-[#00e6ff] rounded-full animate-pulse" />
      )}
      <div className="flex gap-1 p-2" style={{ minHeight: 144 }}>
        {children}
      </div>
    </div>
  );
}

/**
 * FEAT-2 §6: header-level drag handle. Wraps the GripVertical icon and
 * exposes a draggable that the parent <DndContext> picks up as a
 * carousel-kind drag.
 */
function CarouselHeaderHandle({
  carouselId,
  previewUrls,
  previewCount,
}: {
  carouselId: string;
  previewUrls: string[];
  previewCount: number;
}) {
  const dragData: DragData = {
    kind: 'carousel',
    carouselId,
    previewUrls,
    previewCount,
  };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `card-drag-${carouselId}`,
    data: dragData,
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...listeners}
      {...attributes}
      aria-label={`Drag carousel ${carouselId} to reorder`}
      onClick={(e) => e.stopPropagation()}
      className={`shrink-0 p-1.5 rounded-md bg-zinc-800/80 hover:bg-zinc-700 text-zinc-500 hover:text-zinc-200 opacity-0 group-hover/card:opacity-100 transition-opacity cursor-grab active:cursor-grabbing ${
        isDragging ? 'opacity-100' : ''
      }`}
      data-testid={`carousel-header-handle-${carouselId}`}
    >
      <GripVertical className="w-4 h-4" />
    </button>
  );
}

function DraggableImage({
  image,
  carouselId,
  onPreviewClick,
}: {
  image: GeneratedImage;
  carouselId: string;
  onPreviewClick: (img: GeneratedImage) => void;
}) {
  const dragData: DragData = {
    imageId: image.id,
    sourceCarouselId: carouselId,
    imageUrl: image.url,
  };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `drag-${image.id}`,
    data: dragData,
  });

  return (
    <div
      ref={setNodeRef}
      className={`relative group/img shrink-0 ${isDragging ? 'opacity-30' : ''}`}
    >
      <button
        type="button"
        {...listeners}
        {...attributes}
        className="absolute -left-1 top-1/2 -translate-y-1/2 z-10 p-0.5 rounded bg-black/60 text-zinc-600 hover:text-zinc-200 opacity-0 group-hover/img:opacity-100 transition-opacity cursor-grab active:cursor-grabbing"
        aria-label={`Drag image ${image.id}`}
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="w-3.5 h-3.5" />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={image.url}
        alt={image.prompt}
        loading="lazy"
        onClick={() => onPreviewClick(image)}
        className="h-32 w-32 object-cover rounded-lg cursor-zoom-in"
      />
    </div>
  );
}

export function PostReadyCarouselCard({
  images,
  carouselId,
  isExplicit,
  scheduledPost,
  allScheduledPosts,
  selectedPlatforms,
  available,
  busy,
  status,
  isRegen,
  copyHighlighted,
  onPreviewClick,
  onCaptionChange,
  onTogglePlatform,
  onPostNow,
  onSchedule,
  onCopy,
  onRegen,
  onUnreadyAll,
  onSeparate,
  onLockGroup,
  onCancelSchedule,
}: PostReadyCarouselCardProps) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [captionExpanded, setCaptionExpanded] = useState(false);
  const [hashtagsExpanded, setHashtagsExpanded] = useState(false);

  const anchor = images[0];
  const { kind, label } = derivePostReadyStatus(anchor, scheduledPost);
  const v = visualsForKind(kind);

  const hashtags = anchor.postHashtags ?? [];
  const visibleTags = hashtagsExpanded ? hashtags : hashtags.slice(0, HASHTAG_PREVIEW);
  const hiddenCount = Math.max(0, hashtags.length - HASHTAG_PREVIEW);

  const handleCalendarConfirm = (date: string, time: string) => {
    onSchedule(date, time);
    setCalendarOpen(false);
  };

  const cardKey = `carousel-${anchor.id}`;

  return (
    <CarouselCardShell
      carouselId={carouselId}
      restingBorder={v.border}
      previewUrls={images.slice(0, 3).map((i) => i.url).filter((u): u is string => !!u)}
      previewCount={images.length}
    >
      {/* Status pill row */}
      <div className="px-3 pt-3 pb-2 flex items-center gap-2 flex-wrap">
        <CarouselHeaderHandle
          carouselId={carouselId}
          previewUrls={images.slice(0, 3).map((i) => i.url).filter((u): u is string => !!u)}
          previewCount={images.length}
        />
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 text-[11px] font-semibold rounded-full border ${v.pillBg} ${v.pillText}`}
          aria-label={`Status: ${label}`}
        >
          {kind === 'scheduled' && <Clock className="w-3 h-3" />}
          {kind === 'posted' && <Check className="w-3 h-3" />}
          {kind === 'failed' && <X className="w-3 h-3" />}
          {label}
        </span>
        {kind === 'scheduled' && <CountdownBadge scheduledPost={scheduledPost} />}
        {/* V080-DES-002: explicit "Not scheduled" affordance so an
            unscheduled carousel reads the same as an unscheduled single. */}
        {kind === 'ready' && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full border bg-zinc-900/60 border-zinc-700 text-zinc-400"
            aria-label="Not scheduled"
          >
            <Clock className="w-3 h-3" aria-hidden="true" />
            Not scheduled
          </span>
        )}
        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#00e6ff]/15 border border-[#00e6ff]/30 text-[10px] font-medium text-[#00e6ff] rounded-full">
          <LayoutGrid className="w-3 h-3" /> Carousel · {images.length}
        </span>
        {isExplicit && (
          <span className="inline-flex items-center px-2 py-0.5 bg-zinc-800/80 text-[10px] font-medium text-zinc-300 rounded-full border border-zinc-700">
            manual
          </span>
        )}
      </div>

      {/* Image strip — droppable zone for receiving dragged images */}
      <DroppableImageStrip carouselId={carouselId}>
        {images.map((ci) => (
          <DraggableImage
            key={ci.id}
            image={ci}
            carouselId={carouselId}
            onPreviewClick={onPreviewClick}
          />
        ))}
      </DroppableImageStrip>

      <div className="p-3 space-y-3">
        {/* Shared caption */}
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
            Shared caption
          </label>
          {captionExpanded ? (
            <textarea
              autoFocus
              value={anchor.postCaption || ''}
              onChange={(e) => onCaptionChange(e.target.value)}
              onBlur={() => setCaptionExpanded(false)}
              placeholder="No caption yet…"
              rows={4}
              className="w-full bg-zinc-800/50 border border-zinc-700/50 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:border-[#c5a062]/50 focus:outline-none resize-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => setCaptionExpanded(true)}
              className="w-full text-left text-sm text-zinc-300 line-clamp-2 hover:text-zinc-100 transition-colors"
              title="Tap to edit"
            >
              {anchor.postCaption || (
                <span className="text-zinc-600 italic">No caption yet — tap to edit</span>
              )}
            </button>
          )}
        </div>

        {/* Hashtags */}
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
            Hashtags
          </label>
          {hashtags.length === 0 ? (
            <p className="text-[11px] text-zinc-600 italic">No hashtags.</p>
          ) : (
            <div className="flex flex-wrap gap-1 items-center">
              {visibleTags.map((tag, i) => (
                <span
                  key={`${tag}-${i}`}
                  className="px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded-full text-[10px] text-zinc-300"
                >
                  {tag}
                </span>
              ))}
              {!hashtagsExpanded && hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => setHashtagsExpanded(true)}
                  className="px-2 py-0.5 text-[10px] text-[#c5a062] hover:text-[#e0c285] underline-offset-2 hover:underline"
                >
                  +{hiddenCount} more
                </button>
              )}
              {hashtagsExpanded && hashtags.length > HASHTAG_PREVIEW && (
                <button
                  type="button"
                  onClick={() => setHashtagsExpanded(false)}
                  className="px-2 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-300"
                >
                  show less
                </button>
              )}
            </div>
          )}
        </div>

        {/* Platforms */}
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
            Platforms
          </label>
          {available.length === 0 ? (
            <p className="text-[11px] text-amber-400">Configure a platform in Settings.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {available.map((p) => {
                const checked = selectedPlatforms.includes(p);
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => onTogglePlatform(p)}
                    className={`px-2.5 py-1 text-[10px] rounded-full border transition-colors ${
                      checked
                        ? `${platformBadgeClass(p)} text-white border-transparent`
                        : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:border-zinc-500'
                    }`}
                  >
                    {checked && <Check className="w-3 h-3 inline mr-1" />}
                    {p}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Primary actions: Post Now + Schedule + kebab */}
        <div className="flex items-center gap-2">
          <button
            disabled={!!busy || selectedPlatforms.length === 0}
            onClick={onPostNow}
            className="flex-1 btn-blue-sm text-[11px] px-2 justify-center"
          >
            {busy === 'posting' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5" />
            )}
            Post Now
          </button>
          <button
            disabled={!!busy || selectedPlatforms.length === 0}
            onClick={() => setCalendarOpen((v) => !v)}
            aria-expanded={calendarOpen}
            aria-controls={`schedule-calendar-${cardKey}`}
            className="flex-1 btn-gold-sm text-[11px] px-2 justify-center"
          >
            <Clock className="w-3.5 h-3.5" /> Schedule
          </button>
          <KebabMenu
            ariaLabel="More actions"
            triggerClassName="flex items-center justify-center w-8 h-8 rounded-full text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:opacity-40"
            items={(() => {
              const out: KebabMenuItem[] = [
                {
                  kind: 'item',
                  id: 'copy',
                  label: 'Copy caption + tags',
                  icon: copyHighlighted ? Check : Copy,
                  disabled: !anchor.postCaption,
                  onSelect: onCopy,
                },
                {
                  kind: 'item',
                  id: 'regen',
                  label: 'Regenerate caption',
                  icon: isRegen ? Loader2 : RefreshCw,
                  disabled: isRegen,
                  onSelect: onRegen,
                },
                isExplicit
                  ? {
                      kind: 'item',
                      id: 'separate',
                      label: 'Separate carousel',
                      icon: Columns,
                      onSelect: onSeparate,
                    }
                  : {
                      kind: 'item',
                      id: 'lock-group',
                      label: 'Lock as group',
                      icon: LayoutGrid,
                      onSelect: onLockGroup,
                    },
              ];
              if (onCancelSchedule && kind === 'scheduled') {
                out.push({
                  kind: 'item',
                  id: 'cancel-schedule',
                  label: 'Cancel schedule',
                  icon: X,
                  onSelect: onCancelSchedule,
                });
              }
              out.push({
                kind: 'item',
                id: 'unready-all',
                label: 'Move all out of Post Ready',
                icon: MinusCircle,
                destructive: true,
                onSelect: onUnreadyAll,
              });
              return out;
            })()}
          />
        </div>

        {status && (
          <p className={`text-[11px] ${status.startsWith('Error') ? 'text-red-400' : 'text-emerald-400'}`}>
            {status}
          </p>
        )}
      </div>

      {calendarOpen && (
        <div id={`schedule-calendar-${cardKey}`}>
          <InlineScheduleCalendar
            scheduledPosts={allScheduledPosts}
            selectedPlatforms={selectedPlatforms}
            onConfirm={handleCalendarConfirm}
            onClose={() => setCalendarOpen(false)}
          />
        </div>
      )}
    </CarouselCardShell>
  );
}

/**
 * FEAT-2 §3.5: card-level shell that wraps the resting frame and adds
 * Tier-2 droppable styling when an image-kind drag hovers anywhere on
 * the card (not just inside the strip). It also acts as the draggable
 * source for whole-carousel reordering — but the listener lives on the
 * dedicated <CarouselHeaderHandle> button so accidental clicks on the
 * card body don't initiate drags.
 */
function CarouselCardShell({
  carouselId,
  restingBorder,
  previewUrls: _previewUrls,
  previewCount: _previewCount,
  children,
}: {
  carouselId: string;
  restingBorder: string;
  previewUrls: string[];
  previewCount: number;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: `card-${carouselId}`,
    data: { carouselId },
  });
  const isImageDrag = (active?.data.current as DragData | undefined)?.kind !== 'carousel';
  const isDifferentSource = (active?.data.current as DragData | undefined)?.sourceCarouselId !== carouselId;

  // Tier 2 (hover): full Electric Blue border. Tier 1 (eligible) is implicit
  // — drag is in flight but not over us; resting border still applies.
  const borderClass = isOver && isImageDrag && isDifferentSource
    ? 'border-[#00e6ff]/50'
    : restingBorder;

  return (
    <div
      ref={setNodeRef}
      data-testid={`carousel-card-${carouselId}`}
      className={`group/card bg-zinc-900/80 backdrop-blur-sm border-2 ${borderClass} rounded-2xl overflow-visible hover:border-opacity-80 transition-all duration-300 flex flex-col`}
    >
      {children}
    </div>
  );
}
