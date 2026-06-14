'use client';

import { useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { LazyImg } from '../LazyImg';
import type { PostPlatform } from '@/types/mashup';
import { getAspectFor, PLATFORM_ASPECT } from '@/lib/platform-aspect';

export interface AspectPreviewProps {
  src: string | undefined;
  alt: string;
  /** Platforms the user has currently toggled on this card. */
  selectedPlatforms: PostPlatform[];
  onClick?: () => void;
  /** Optional badge / overlay slot rendered absolute over the image. */
  overlay?: React.ReactNode;
}

const platformPillColor = (p: PostPlatform): string => {
  if (p === 'instagram') return 'bg-pink-600/90 text-white border-pink-500/30';
  if (p === 'pinterest') return 'bg-red-600/90 text-white border-red-500/30';
  if (p === 'twitter') return 'bg-sky-600/90 text-white border-sky-500/30';
  return 'bg-indigo-600/90 text-white border-indigo-500/30';
};

/**
 * V040-009: native-aspect preview for the Post Ready grid card.
 *
 * Shows the image cropped to the target platform's feed aspect ratio so
 * the user can see how it'll actually appear after posting. When 2+
 * platforms are selected, a tab strip lets them flip between aspects.
 *
 * When no platforms are selected, falls back to a 1:1 square preview —
 * matches the pre-V040-009 default and keeps the card layout stable.
 */
export function AspectPreview({
  src,
  alt,
  selectedPlatforms,
  onClick,
  overlay,
}: AspectPreviewProps) {
  // Active preview platform: defaults to the first selected platform.
  // Resets whenever the selection changes so the active tab never
  // points at a platform the user just unticked.
  const [activePlatform, setActivePlatform] = useState<PostPlatform | null>(
    selectedPlatforms[0] ?? null,
  );

  // V105.1-REACT-19: setActivePlatform deferred via queueMicrotask
  // (project convention) so the effect body only watches the
  // platform selection, not local state in the body itself.
  useEffect(() => {
    queueMicrotask(() => {
      if (selectedPlatforms.length === 0) {
        setActivePlatform(null);
        return;
      }
      if (!activePlatform || !selectedPlatforms.includes(activePlatform)) {
        setActivePlatform(selectedPlatforms[0]);
      }
    });
  }, [selectedPlatforms, activePlatform]);

  const aspect = getAspectFor(activePlatform);

  return (
    <div className="md:w-48 md:shrink-0 flex flex-col">
      {/* Aspect-locked preview */}
      <div className={`relative bg-zinc-950 ${aspect.className} overflow-hidden`}>
        {src ? (
          <LazyImg
            src={src}
            alt={alt}
            onClick={onClick}
            className="w-full h-full object-cover cursor-zoom-in"
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ImageOff className="w-8 h-8 text-zinc-700" />
          </div>
        )}
        {overlay}
        {/* Aspect ratio chip — bottom-left, gives the user a tiny but
            unambiguous signal that this is a crop preview, not the
            original. Only shows when at least one platform is selected. */}
        {activePlatform && (
          <span
            className="absolute bottom-2 left-2 inline-flex items-center px-1.5 py-0.5 bg-black/70 backdrop-blur-sm text-[9px] font-medium text-zinc-100 rounded-md tabular-nums"
            title={aspect.note}
          >
            {aspect.ratio}
          </span>
        )}
      </div>

      {/* Platform tab strip — only renders when 2+ platforms selected.
          With one platform, the aspect chip already says it all and a
          single-tab strip would just be noise. */}
      {selectedPlatforms.length >= 2 && (
        <div
          className="flex flex-wrap gap-1 p-1.5 bg-zinc-950/80 border-t border-zinc-800/60"
          role="tablist"
          aria-label="Preview crop for platform"
        >
          {selectedPlatforms.map((p) => {
            const isActive = p === activePlatform;
            return (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActivePlatform(p)}
                className={`px-2 py-0.5 text-[9px] uppercase tracking-wider rounded-full border transition-colors ${
                  isActive
                    ? platformPillColor(p)
                    : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-300'
                }`}
              >
                {PLATFORM_ASPECT[p]?.shortLabel ?? p.slice(0, 2).toUpperCase()}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
