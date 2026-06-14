'use client';

import { useState, useCallback } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { GripVertical, LayoutGrid } from 'lucide-react';
import type { PostItem } from '@/lib/carouselView';

export interface DndMoveHandler {
  moveImageToCarousel: (imageId: string, sourceCarouselId: string | null, targetCarouselId: string) => void;
  moveImageToNewGroup: (imageId: string, sourceCarouselId: string | null) => void;
  /** FEAT-2: reorder explicit carousel groups. Drops `groupId` immediately
   *  before `beforeGroupId`; pass null to drop at the end. No-op for groups
   *  not in settings.carouselGroups (auto-detected carousels). */
  moveCarouselGroup?: (groupId: string, beforeGroupId: string | null) => void;
}

interface PostReadyDndGridProps {
  children: React.ReactNode;
  postItems: PostItem[];
  onMove: DndMoveHandler;
}

export type DragKind = 'image' | 'carousel';

export interface DragData {
  kind?: DragKind;
  imageId?: string;
  sourceCarouselId?: string | null;
  imageUrl?: string;
  /** When kind === 'carousel', the carousel group id being dragged. */
  carouselId?: string;
  /** When kind === 'carousel', a few image URLs to render the preview. */
  previewUrls?: string[];
  /** When kind === 'carousel', the count for the preview pill. */
  previewCount?: number;
}

export function DraggableSingleWrapper({
  imageId,
  imageUrl,
  children,
}: {
  imageId: string;
  imageUrl?: string;
  children: React.ReactNode;
}) {
  const dragData: DragData = { kind: 'image', imageId, sourceCarouselId: null, imageUrl };
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: `drag-single-${imageId}`,
    data: dragData,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `drop-single-${imageId}`,
    data: { carouselId: `new-group-${imageId}` },
  });

  return (
    <div
      ref={(node) => { setDragRef(node); setDropRef(node); }}
      className={`relative ${isDragging ? 'opacity-40' : ''} ${isOver ? 'ring-2 ring-[#00e6ff]/60 rounded-2xl' : ''}`}
    >
      <button
        type="button"
        {...listeners}
        {...attributes}
        className="absolute top-3 right-12 z-10 p-1 rounded bg-black/60 text-zinc-500 hover:text-zinc-200 opacity-0 hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing"
        aria-label="Drag to reorder"
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="w-4 h-4" />
      </button>
      {children}
    </div>
  );
}

export function PostReadyDndGrid({ children, postItems, onMove }: PostReadyDndGridProps) {
  const [activeData, setActiveData] = useState<DragData | null>(null);

  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: { distance: 8 },
  });
  const touchSensor = useSensor(TouchSensor, {
    activationConstraint: { delay: 200, tolerance: 5 },
  });
  const keyboardSensor = useSensor(KeyboardSensor);
  const sensors = useSensors(pointerSensor, touchSensor, keyboardSensor);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as DragData | undefined;
    if (data) setActiveData(data);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveData(null);
    const { active, over } = event;
    if (!over) return;

    const source = active.data.current as DragData | undefined;
    if (!source) return;

    // ── Carousel-level drag: reorder groups ───────────────────────────────
    if (source.kind === 'carousel' && source.carouselId) {
      // Target must be another card-drop zone (carries beforeGroupId).
      const beforeGroupId = over.data.current?.beforeGroupId as string | null | undefined;
      if (beforeGroupId === undefined) return; // dropped on a non-grid target
      if (beforeGroupId === source.carouselId) return; // dropped on self
      onMove.moveCarouselGroup?.(source.carouselId, beforeGroupId);
      return;
    }

    // ── Image-level drag: existing behavior ───────────────────────────────
    const targetCarouselId = over.data.current?.carouselId as string | undefined;
    if (!targetCarouselId) return;
    if (source.sourceCarouselId === targetCarouselId) return;
    if (!source.imageId) return;

    onMove.moveImageToCarousel(source.imageId, source.sourceCarouselId ?? null, targetCarouselId);
  }, [onMove]);

  const handleDragCancel = useCallback(() => {
    setActiveData(null);
  }, []);

  const isCarouselGhost = activeData?.kind === 'carousel';

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      autoScroll={{ threshold: { x: 0, y: 0.2 } }}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {isCarouselGhost ? (
          <div
            className="bg-zinc-900/90 backdrop-blur-md border-2 border-[#00e6ff]/60 rounded-2xl shadow-2xl shadow-[0_0_36px_rgba(0,230,255,0.40)] opacity-70 scale-90 pointer-events-none w-[320px] overflow-hidden"
            data-testid="carousel-drag-ghost"
          >
            <div className="px-3 pt-3 pb-2 flex items-center gap-2">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#00e6ff]/15 border border-[#00e6ff]/30 text-[10px] font-medium text-[#00e6ff] rounded-full">
                <LayoutGrid className="w-3 h-3" /> Carousel · {activeData?.previewCount ?? 0}
              </span>
            </div>
            <div className="flex gap-1 p-2 bg-zinc-950">
              {(activeData?.previewUrls ?? []).slice(0, 3).map((url, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  src={url}
                  alt=""
                  className="h-20 w-20 object-cover rounded-lg"
                />
              ))}
            </div>
          </div>
        ) : (
          activeData?.imageUrl && (
            <div
              className="opacity-50 scale-95 rounded-lg overflow-hidden pointer-events-none border-2 border-[#00e6ff]/60 shadow-2xl shadow-[0_0_24px_rgba(0,230,255,0.35)]"
              data-testid="image-drag-ghost"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={activeData.imageUrl}
                alt="Dragging"
                className="h-32 w-32 object-cover"
              />
            </div>
          )
        )}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * FEAT-2 §6: Whole-card drop zone that sits between cards in the grid.
 * Carries `beforeGroupId` so the dragEnd handler knows where to insert.
 * Renders as a thin gap that only becomes visible (insert line) when a
 * carousel-kind drag is hovering it.
 */
export function CarouselReorderSlot({ beforeGroupId }: { beforeGroupId: string | null }) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: `carousel-slot-${beforeGroupId ?? 'end'}`,
    data: { beforeGroupId },
  });
  const isCarouselDrag = (active?.data.current as DragData | undefined)?.kind === 'carousel';

  // Slot is invisible unless a carousel-drag is in flight; even then it's
  // only an outlined band so the grid layout doesn't shift.
  return (
    <div
      ref={setNodeRef}
      className={`transition-all duration-200 ${
        isCarouselDrag
          ? isOver
            ? 'h-2 my-2 bg-[#00e6ff] rounded-full animate-pulse opacity-100'
            : 'h-1 my-2 bg-[#00e6ff]/20 rounded-full opacity-60'
          : 'h-0 my-0 opacity-0'
      }`}
      data-testid={`carousel-reorder-slot-${beforeGroupId ?? 'end'}`}
      aria-hidden={!isCarouselDrag}
    />
  );
}
