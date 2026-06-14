// V040-DES-003: horizontal strip of image thumbnails with per-image
// state dots. Shows first 3 thumbs + "+N" overflow tile when >4 images.
// Pure presentational — parent decides what clicking means.

import { ImageOff } from 'lucide-react';
import type { GeneratedImage } from '@/types/mashup';
import type { CarouselImageState } from './CarouselStatusPill';

const STATE_DOT: Record<CarouselImageState, string> = {
  pending: 'bg-[#00e6ff]',
  approved: 'bg-emerald-500',
  rejected: 'bg-red-500',
};

const STATE_BORDER: Record<CarouselImageState, string> = {
  pending: 'border-[#00e6ff]/30',
  approved: 'border-emerald-500/60',
  rejected: 'border-red-500/40',
};

const STATE_IMG: Record<CarouselImageState, string> = {
  pending: '',
  approved: '',
  rejected: 'saturate-50 opacity-45',
};

export function CarouselThumbnailStrip({
  images,
  statuses,
  onThumbClick,
  maxVisible = 4,
}: {
  images: GeneratedImage[];
  statuses: Record<string, CarouselImageState>;
  onThumbClick?: (imageId: string) => void;
  maxVisible?: number;
}) {
  const visible = images.slice(0, maxVisible);
  const overflow = images.length - maxVisible;

  return (
    <div
      className="grid gap-1.5"
      style={{ gridTemplateColumns: `repeat(${visible.length + (overflow > 0 ? 1 : 0)}, minmax(0, 1fr))` }}
    >
      {visible.map((img) => {
        const st = statuses[img.id] ?? 'pending';
        return (
          <button
            key={img.id}
            type="button"
            onClick={() => onThumbClick?.(img.id)}
            className={`relative aspect-square rounded-lg overflow-hidden bg-zinc-800 border-2 ${STATE_BORDER[st]} transition-transform hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e6ff]/60`}
            aria-label={`Image ${img.id} · ${st}`}
          >
            {img.url || img.base64 ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={img.url || `data:image/png;base64,${img.base64}`}
                alt=""
                className={`w-full h-full object-cover ${STATE_IMG[st]}`}
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <ImageOff className="w-5 h-5 text-zinc-600" />
              </div>
            )}
            <span
              className={`absolute bottom-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full ${STATE_DOT[st]}`}
              aria-hidden="true"
            />
          </button>
        );
      })}
      {overflow > 0 && (
        <button
          type="button"
          onClick={() => onThumbClick?.(images[maxVisible]?.id ?? '')}
          className="aspect-square rounded-lg bg-zinc-800/80 border-2 border-zinc-700/60 flex items-center justify-center text-xs text-zinc-400 hover:border-zinc-500 transition-colors"
          aria-label={`${overflow} more images`}
        >
          +{overflow}
        </button>
      )}
    </div>
  );
}
