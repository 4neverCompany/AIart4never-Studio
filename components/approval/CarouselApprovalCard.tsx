// V040-DES-003: top-level carousel card for the approval queue.
// Composes thumbnail strip + status pill + review panel + degrade
// notice. Handlers are the existing per-post approve/reject callbacks;
// "approve carousel" loops over images to call them N times.
//
// Mutation of CarouselGroup.imageIds and schema work (per-image status
// persistence, true degrade transition) are flagged complex in the
// V040-DES-001 spec and remain PROP-gated. This component shows the
// visual + interaction layer cleanly on top of whatever state the
// parent feeds it.

import { useEffect, useMemo, useState } from 'react';
import { Check, X, ChevronDown, Layers, Lightbulb } from 'lucide-react';
import type { GeneratedImage, Idea, ScheduledPost } from '@/types/mashup';
import { CarouselStatusPill, type CarouselImageState } from './CarouselStatusPill';
import { CarouselThumbnailStrip } from './CarouselThumbnailStrip';
import { CarouselReviewPanel } from './CarouselReviewPanel';
import { DegradeNotice } from './DegradeNotice';
import { InlineCaptionEditor } from './InlineCaptionEditor';
import { ViralityBadge } from './ViralityBadge';
import { canRejectMoreInCarousel } from '@/lib/carousel-degrade-guard';
import {
  GHOST_TTL_MS,
  pruneExpiredGhosts,
  nextGhostExpiry,
  type CarouselGhost,
  type CarouselGhostState,
} from '@/lib/carousel-ghost';

export function CarouselApprovalCard({
  groupId,
  posts,
  imagesById,
  idea,
  selected,
  onToggleSelect,
  onApprovePost,
  onRejectPost,
  onUpdateCaption,
  onImageClick,
}: {
  groupId: string;
  posts: ScheduledPost[];
  imagesById: Map<string, GeneratedImage>;
  idea?: Idea;
  selected: boolean;
  onToggleSelect: () => void;
  onApprovePost: (postId: string) => void;
  onRejectPost: (postId: string) => void;
  /** V050-005: edit the carousel's shared caption. Parent fans out to
   *  every sibling post and the matching CarouselGroup. */
  onUpdateCaption?: (next: string) => void;
  /** Optional fullscreen-preview click handler for the expanded panel. */
  onImageClick?: (img: GeneratedImage) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Local optimistic state so the user sees per-image feedback before
  // the parent commits (or before we add persistence). Maps image id →
  // local state; absent = 'pending'.
  const [localStatus, setLocalStatus] = useState<Record<string, CarouselImageState>>({});

  // V040-HOTFIX-003: ghost memory. Approve/reject removes the post from
  // the parent's queue, which removes the image from `liveImages` on
  // the next render — so the user never sees their own checkmark land.
  // Ghost entries hold onto the image (and its just-acted state) for
  // GHOST_TTL_MS so the row stays visible long enough to register.
  const [ghosts, setGhosts] = useState<Record<string, CarouselGhost<GeneratedImage>>>({});
  // Append-only ordered cache of every image we've ever seen in this
  // carousel. Used to keep ghost rows in their original strip position
  // instead of jumping to the end after the parent re-renders.
  const [seenOrder, setSeenOrder] = useState<Map<string, GeneratedImage>>(new Map());

  const liveImages = useMemo(
    () => posts.map((p) => imagesById.get(p.imageId)).filter((i): i is GeneratedImage => !!i),
    [posts, imagesById],
  );
  const liveIds = useMemo(() => new Set(liveImages.map((i) => i.id)), [liveImages]);

  // Grow seenOrder as new live images appear. Never shrinks — the
  // displayImages filter below drops anything that's neither live
  // nor ghosted, so stale entries just sit dormant.
  // V105.1-REACT-19: setSeenOrder is the "grow seenOrder as new live
  // images appear" pattern. The functional setter (prev => next) is
  // the safe form (no stale-closure risk) and the mutation is gated
  // by `mutated` so we only re-render when there's actually a new id.
  // Tests assert onClick fires for each new image; queueMicrotask
  // deferred the setState past the test's act() block and broke the
  // "fire onApprovePost per sibling" assertion. Keeping the
  // synchronous setter with documented justification.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSeenOrder((prev) => {
      let mutated = false;
      const next = new Map(prev);
      for (const img of liveImages) {
        if (!next.has(img.id)) {
          next.set(img.id, img);
          mutated = true;
        }
      }
      return mutated ? next : prev;
    });
  }, [liveImages]);

  // Sweep expired ghosts. Schedule one timer to the next expiry; the
  // effect re-runs whenever `ghosts` changes (any add or sweep) and
  // re-arms the timer.
  useEffect(() => {
    const next = nextGhostExpiry(ghosts);
    if (next === null) return;
    const wait = Math.max(0, next - Date.now()) + 50;
    const t = setTimeout(() => {
      setGhosts((prev) => pruneExpiredGhosts(prev, Date.now()));
    }, wait);
    return () => clearTimeout(t);
  }, [ghosts]);

  // Display = images in original-seen order, kept if still live OR
  // currently ghosted. Position is preserved across the live → ghost
  // → gone transition.
  const images = useMemo(() => {
    const out: GeneratedImage[] = [];
    for (const [id, img] of seenOrder) {
      if (liveIds.has(id) || ghosts[id]) out.push(img);
    }
    return out;
  }, [seenOrder, liveIds, ghosts]);

  // Map imageId → the owning post (so we can fire approve/reject by post.id)
  const postByImage = useMemo(() => {
    const m = new Map<string, ScheduledPost>();
    for (const p of posts) m.set(p.imageId, p);
    return m;
  }, [posts]);

  // Live images consult `localStatus` (which is meaningful pre-removal);
  // ghosted images consult their captured ghost state.
  const statuses: Record<string, CarouselImageState> = useMemo(() => {
    const out: Record<string, CarouselImageState> = {};
    for (const img of images) {
      if (liveIds.has(img.id)) {
        out[img.id] = localStatus[img.id] ?? 'pending';
      } else {
        out[img.id] = ghosts[img.id]?.state ?? 'pending';
      }
    }
    return out;
  }, [images, liveIds, localStatus, ghosts]);

  const counts = useMemo(() => {
    let pending = 0, approved = 0, rejected = 0;
    for (const img of images) {
      const st = statuses[img.id];
      if (st === 'approved') approved++;
      else if (st === 'rejected') rejected++;
      else pending++;
    }
    return { pending, approved, rejected, total: images.length };
  }, [images, statuses]);

  // Reject floor is computed from LIVE-queue count (`liveImages.length`)
  // rather than displayed `images.length` — ghosts are visual residue
  // of completed actions, not still-rejectable posts.
  const rejectGuarded = !canRejectMoreInCarousel(liveImages.length);

  const addGhost = (img: GeneratedImage, state: CarouselGhostState) => {
    setGhosts((prev) => ({
      ...prev,
      [img.id]: { state, img, expiresAt: Date.now() + GHOST_TTL_MS },
    }));
  };

  const approveImage = (imageId: string) => {
    const post = postByImage.get(imageId);
    if (!post) return;
    const img = liveImages.find((i) => i.id === imageId);
    setLocalStatus((prev) => ({ ...prev, [imageId]: 'approved' }));
    if (img) addGhost(img, 'approved');
    onApprovePost(post.id);
  };

  const rejectImage = (imageId: string) => {
    if (rejectGuarded) return;
    const post = postByImage.get(imageId);
    if (!post) return;
    const img = liveImages.find((i) => i.id === imageId);
    setLocalStatus((prev) => ({ ...prev, [imageId]: 'rejected' }));
    if (img) addGhost(img, 'rejected');
    onRejectPost(post.id);
  };

  const approveRemaining = () => {
    for (const img of liveImages) {
      if ((statuses[img.id] ?? 'pending') === 'pending') approveImage(img.id);
    }
  };

  const approveCarousel = () => {
    approveRemaining();
  };

  const rejectCarousel = () => {
    // Whole-carousel reject bypasses the per-image guard — the user is
    // explicitly killing the group, not accidentally degrading it.
    for (const img of liveImages) {
      const post = postByImage.get(img.id);
      if (!post) continue;
      setLocalStatus((prev) => ({ ...prev, [img.id]: 'rejected' }));
      addGhost(img, 'rejected');
      onRejectPost(post.id);
    }
  };

  const firstPost = posts[0];
  const caption = firstPost?.caption;
  const date = firstPost?.date;
  const time = firstPost?.time;
  const platforms = firstPost?.platforms ?? [];
  const onThumbClick = () => setExpanded(true);

  return (
    <div
      className={`relative bg-zinc-900/60 rounded-2xl border p-3 space-y-3 transition-all duration-200 hover:shadow-[0_4px_20px_rgba(0,230,255,0.08)] ${
        selected
          ? 'border-[#c5a062]/60 shadow-[0_0_12px_rgba(197,160,98,0.18)]'
          : counts.rejected === counts.total
            ? 'border-red-500/40 hover:border-red-500/60'
            : counts.pending === 0
              ? 'border-emerald-500/40 hover:border-emerald-500/60'
              : counts.approved > 0
                ? 'border-[#c5a062]/40 hover:border-[#c5a062]/60'
                : 'border-[#00e6ff]/25 hover:border-[#00e6ff]/45'
      }`}
    >
      <label className="absolute top-2 left-2 z-10 flex items-center justify-center w-5 h-5 bg-zinc-900/80 rounded cursor-pointer">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="w-4 h-4 accent-[#c5a062] cursor-pointer"
          aria-label={`Select carousel ${groupId}`}
        />
      </label>

      <div className="flex items-center justify-between pl-7 gap-2">
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#00e6ff]/10 border border-[#00e6ff]/25 text-[#00e6ff]">
          <Layers className="w-3 h-3" aria-hidden="true" />
          <span className="text-[11px] font-semibold tracking-tight">
            Carousel · {images.length}
          </span>
        </span>
        <div className="flex items-center gap-2">
          {/* V1.3: virality score badge — all posts in a carousel share the same score */}
          {posts[0]?.viralityScore != null && (
            <ViralityBadge score={posts[0].viralityScore} />
          )}
          <CarouselStatusPill {...counts} />
        </div>
      </div>

      {!expanded && (
        <CarouselThumbnailStrip
          images={images}
          statuses={statuses}
          onThumbClick={onThumbClick}
        />
      )}

      {expanded && (
        <CarouselReviewPanel
          images={images}
          statuses={statuses}
          captionPreview={caption}
          rejectGuarded={rejectGuarded}
          onApproveImage={approveImage}
          onRejectImage={rejectImage}
          onApproveRemaining={approveRemaining}
          onRejectCarousel={rejectCarousel}
          onCollapse={() => setExpanded(false)}
          onImageClick={onImageClick}
        />
      )}

      {!expanded && (
        <>
          {idea && (
            <div className="flex items-center gap-1 text-[10px] text-[#c5a062]/80">
              <Lightbulb className="w-3 h-3" />
              <span className="truncate">{idea.concept}</span>
            </div>
          )}

          {onUpdateCaption ? (
            <InlineCaptionEditor caption={caption} onSave={onUpdateCaption} />
          ) : (
            <p className="text-xs text-zinc-300 line-clamp-2 min-h-[2rem]">
              {caption || <span className="text-zinc-600 italic">No caption</span>}
            </p>
          )}

          <div className="flex items-center justify-between text-[10px] text-zinc-500">
            <span>{date} {time}</span>
            {platforms.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {platforms.map((pl) => (
                  <span key={pl} className="text-[9px] px-1.5 py-0.5 bg-zinc-800 text-zinc-400 rounded">
                    {pl}
                  </span>
                ))}
              </div>
            )}
          </div>

          <DegradeNotice visible={rejectGuarded} />

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="inline-flex items-center justify-center gap-1 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs rounded-lg transition-colors"
            >
              Review
              <ChevronDown className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={approveCarousel}
              disabled={counts.pending === 0}
              className="flex-1 inline-flex items-center justify-center gap-1 px-3 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/40 disabled:opacity-40 disabled:cursor-not-allowed text-emerald-300 text-xs font-medium rounded-lg transition-colors"
            >
              <Check className="w-3.5 h-3.5" />
              Approve carousel
            </button>
            <button
              type="button"
              onClick={rejectCarousel}
              className="inline-flex items-center justify-center gap-1 px-3 py-1.5 bg-red-600/20 hover:bg-red-600/40 text-red-300 text-xs font-medium rounded-lg transition-colors"
              aria-label="Reject carousel"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
