// V040-DES-003: inline expanded review — one full-size image per row
// with per-image Approve/Reject buttons. Pure presentational; handlers
// are the existing approve/reject post actions, looped per image.

import { Check, X, ImageOff, ChevronUp } from 'lucide-react';
import type { GeneratedImage } from '@/types/mashup';
import type { CarouselImageState } from './CarouselStatusPill';
import { DegradeNotice } from './DegradeNotice';

export function CarouselReviewPanel({
  images,
  statuses,
  captionPreview,
  rejectGuarded = false,
  onApproveImage,
  onRejectImage,
  onApproveRemaining,
  onRejectCarousel,
  onCollapse,
  onImageClick,
}: {
  images: GeneratedImage[];
  statuses: Record<string, CarouselImageState>;
  captionPreview?: string;
  /** When true, per-image reject is disabled — the carousel is at the
   *  1-image floor and another reject would drop it to zero. V080-DEV-003:
   *  a 2→1 reject is allowed (survivor auto-collapses to a single post);
   *  only the very last image is locked behind "Reject carousel". */
  rejectGuarded?: boolean;
  onApproveImage: (imageId: string) => void;
  onRejectImage: (imageId: string) => void;
  onApproveRemaining: () => void;
  onRejectCarousel: () => void;
  onCollapse: () => void;
  /** Click handler for the expanded image — opens fullscreen viewer. */
  onImageClick?: (img: GeneratedImage) => void;
}) {
  const pendingCount = images.filter((img) => (statuses[img.id] ?? 'pending') === 'pending').length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-zinc-300 line-clamp-2 flex-1 pr-3">
          {captionPreview || <span className="text-zinc-600 italic">No caption</span>}
        </p>
        <button
          type="button"
          onClick={onCollapse}
          className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200 px-2 py-1 rounded-lg hover:bg-zinc-800/60 transition-colors"
        >
          <ChevronUp className="w-3 h-3" />
          Collapse
        </button>
      </div>

      <div className="space-y-3">
        {images.map((img) => {
          const st = statuses[img.id] ?? 'pending';
          return (
            <div
              key={img.id}
              className={`rounded-xl overflow-hidden border ${
                st === 'approved'
                  ? 'border-emerald-500/40 bg-emerald-500/5'
                  : st === 'rejected'
                    ? 'border-red-500/40 bg-red-500/5'
                    : 'border-[#00e6ff]/25 bg-zinc-900/40'
              }`}
            >
              <div className="w-full aspect-video bg-zinc-800 flex items-center justify-center">
                {img.url || img.base64 ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={img.url || `data:image/png;base64,${img.base64}`}
                    alt=""
                    onClick={onImageClick ? () => onImageClick(img) : undefined}
                    className={`w-full h-full object-cover ${onImageClick ? 'cursor-zoom-in' : ''} ${st === 'rejected' ? 'saturate-50 opacity-50' : ''}`}
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                ) : (
                  <ImageOff className="w-8 h-8 text-zinc-600" />
                )}
              </div>
              <div className="flex items-center justify-center gap-2 p-2">
                {st === 'pending' ? (
                  <>
                    <button
                      type="button"
                      onClick={() => onApproveImage(img.id)}
                      className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/40 rounded-lg text-emerald-300 text-xs font-medium transition-colors"
                    >
                      <Check className="w-3.5 h-3.5" />
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => onRejectImage(img.id)}
                      disabled={rejectGuarded}
                      title={rejectGuarded ? 'Cannot reject the last image — use "Reject carousel" instead' : undefined}
                      className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 bg-red-600/20 hover:bg-red-600/40 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-red-600/20 rounded-lg text-red-300 text-xs font-medium transition-colors"
                    >
                      <X className="w-3.5 h-3.5" />
                      Reject
                    </button>
                  </>
                ) : (
                  <span className={`text-xs font-medium ${
                    st === 'approved' ? 'text-emerald-300' : 'text-red-300'
                  }`}>
                    {st === 'approved' ? '✓ Approved' : '✕ Rejected'}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <DegradeNotice visible={rejectGuarded} />

      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[#c5a062]/15">
        <button
          type="button"
          onClick={onApproveRemaining}
          disabled={pendingCount === 0}
          className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-1 px-3 py-1.5 bg-[#c5a062] hover:bg-[#d4b478] active:bg-[#a68748] disabled:opacity-40 disabled:cursor-not-allowed text-[#050505] text-xs font-semibold rounded-xl transition-colors"
        >
          <Check className="w-3.5 h-3.5" />
          Approve remaining ({pendingCount})
        </button>
        <button
          type="button"
          onClick={onRejectCarousel}
          className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-1 px-3 py-1.5 bg-red-600/20 hover:bg-red-600/40 text-red-200 text-xs font-medium rounded-xl border border-red-500/40 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
          Reject carousel
        </button>
      </div>
    </div>
  );
}
