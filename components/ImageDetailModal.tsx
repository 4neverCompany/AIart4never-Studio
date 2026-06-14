'use client';

import { useState, useRef, useEffect } from 'react';
import { motion } from 'motion/react';
import {
  X,
  Loader2,
  Download,
  Sparkles,
  Video,
  RefreshCw,
  Tag,
  FolderPlus,
  Plus,
  Trash2,
  BookmarkCheck,
  XCircle,
  ImageOff,
} from 'lucide-react';
import type { GeneratedImage, Collection } from './MashupContext';
import type { UserSettings } from '@/types/mashup';
import { showToast } from '@/components/Toast';

// FIX-100 slice C: extracted from MainContent.tsx (~319 LOC).
// Fullscreen image-detail viewer — shows media, metadata, tags,
// collection picker, animate-to-video, approve, download, delete.

interface ImageDetailModalProps {
  image: GeneratedImage;
  /** Called with null to close, or a full updated image to sync local UI state. */
  onImageChange: (updated: GeneratedImage | null) => void;
  settings: UserSettings;
  updateSettings: (
    patch: Partial<UserSettings> | ((prev: UserSettings) => Partial<UserSettings>),
  ) => void;
  collections: Collection[];
  selectedForBatch: Set<string>;
  updateImageTags: (id: string, tags: string[]) => void;
  addImageToCollection: (id: string, colId: string) => void;
  removeImageFromCollection: (id: string) => void;
  createCollection: (name?: string, description?: string, imageIds?: string[]) => Promise<unknown>;
  handleAnimate: (image: GeneratedImage) => void;
  toggleApproveImage: (id: string) => void;
  deleteImage: (id: string, fromSaved: boolean) => void;
}

export function ImageDetailModal({
  image,
  onImageChange,
  settings,
  updateSettings,
  collections,
  selectedForBatch,
  updateImageTags,
  addImageToCollection,
  removeImageFromCollection,
  createCollection,
  handleAnimate,
  toggleApproveImage,
  deleteImage,
}: ImageDetailModalProps) {
  const [zoom, setZoom] = useState(1);
  const [origin, setOrigin] = useState('50% 50%');
  const imgAreaRef = useRef<HTMLDivElement>(null);

  // MMX-VISION-ANALYZE: image analysis via mmx vision describe
  const [visionResult, setVisionResult] = useState<string | null>(null);
  const [analyzingVision, setAnalyzingVision] = useState(false);

  // V105.1-REACT-19: setState deferred via queueMicrotask (project
  // convention) so the effect body only watches image.id, not local
  // state. This resets zoom + vision result when the user navigates
  // to a different image.
  useEffect(() => {
    queueMicrotask(() => {
      setZoom(1);
      setOrigin('50% 50%');
      setVisionResult(null); // MMX-VISION-ANALYZE
    });
  }, [image.id]);

  useEffect(() => {
    const el = imgAreaRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      setOrigin(`${x}% ${y}%`);
      setZoom((prev) => Math.min(5, Math.max(1, prev + (e.deltaY > 0 ? -0.25 : 0.25))));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 backdrop-blur-md overflow-hidden">
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.98 }}
        className="w-full h-full flex flex-col md:flex-row"
      >
        {/* Image Area */}
        <div className="flex-1 relative bg-black flex items-center justify-center p-4 md:p-8 overflow-hidden">
          <button
            onClick={() => onImageChange(null)}
            className="absolute top-6 left-6 z-50 p-3 bg-white/10 hover:bg-white/20 text-white rounded-full backdrop-blur-md transition-all border border-white/10"
          >
            <X className="w-6 h-6" />
          </button>

          {image.isVideo ? (
            <div className="relative w-full h-full flex items-center justify-center group">
              {/* CDN-expiry fallback — revealed when video onError fires */}
              <div className="absolute inset-0 flex items-center justify-center">
                <ImageOff className="w-12 h-12 text-zinc-700" />
              </div>
              <video
                src={image.url}
                autoPlay
                loop
                controls
                className="max-w-full max-h-full object-contain shadow-2xl rounded-lg relative"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
              {settings.watermark?.enabled && settings.watermark.image && (
                <div
                  className="absolute pointer-events-none"
                  style={{
                    top: settings.watermark.position.includes('top') ? '10px' : settings.watermark.position === 'center' ? '50%' : 'auto',
                    bottom: settings.watermark.position.includes('bottom') ? '10px' : 'auto',
                    left: settings.watermark.position.includes('left') ? '10px' : settings.watermark.position === 'center' ? '50%' : 'auto',
                    right: settings.watermark.position.includes('right') ? '10px' : 'auto',
                    transform: settings.watermark.position === 'center' ? 'translate(-50%, -50%)' : 'none',
                    opacity: settings.watermark.opacity,
                    width: `${settings.watermark.scale * 100}%`,
                    maxWidth: '200px',
                  }}
                >
                  <img src={settings.watermark.image} alt="Watermark" className="absolute inset-0 w-full h-full object-contain" referrerPolicy="no-referrer" />
                </div>
              )}
              {settings.watermark?.enabled && !settings.watermark.image && settings.channelName && (
                <div
                  className="absolute pointer-events-none text-white font-bold drop-shadow-md"
                  style={{
                    top: settings.watermark.position.includes('top') ? '10px' : settings.watermark.position === 'center' ? '50%' : 'auto',
                    bottom: settings.watermark.position.includes('bottom') ? '10px' : 'auto',
                    left: settings.watermark.position.includes('left') ? '10px' : settings.watermark.position === 'center' ? '50%' : 'auto',
                    right: settings.watermark.position.includes('right') ? '10px' : 'auto',
                    transform: settings.watermark.position === 'center' ? 'translate(-50%, -50%)' : 'none',
                    opacity: settings.watermark.opacity,
                    fontSize: `${Math.max(12, settings.watermark.scale * 40)}px`,
                  }}
                >
                  @{settings.channelName}
                </div>
              )}
            </div>
          ) : (
            <div
              ref={imgAreaRef}
              className="relative w-full h-full flex items-center justify-center group"
              onDoubleClick={() => { setZoom(1); setOrigin('50% 50%'); }}
            >
              {/* CDN-expiry fallback — revealed when Image onError fires */}
              <div className="absolute inset-0 flex items-center justify-center">
                <ImageOff className="w-12 h-12 text-zinc-700" />
              </div>
              <img
                src={image.url || `data:image/jpeg;base64,${image.base64}`}
                alt={image.prompt}
                loading="lazy"
                className="absolute inset-0 w-full h-full object-contain shadow-2xl rounded-lg select-none"
                style={{
                  transform: `scale(${zoom})`,
                  transformOrigin: origin,
                  transition: zoom === 1 ? 'transform 0.2s ease' : 'transform 0.08s ease-out',
                  cursor: zoom > 1 ? 'crosshair' : 'zoom-in',
                }}
                referrerPolicy="no-referrer"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
              <div className="absolute bottom-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                {zoom > 1.01 ? (
                  <span className="bg-black/60 backdrop-blur-md text-[#c5a062] text-[10px] px-2 py-1 rounded uppercase tracking-widest border border-[#c5a062]/30">
                    {zoom.toFixed(1)}× · dbl-click to reset
                  </span>
                ) : (
                  <span className="bg-black/60 backdrop-blur-md text-white/60 text-[10px] px-2 py-1 rounded uppercase tracking-widest border border-white/5">
                    Scroll to zoom
                  </span>
                )}
              </div>
              {/* MMX-VISION-ANALYZE: analyze button */}
              <button
                onClick={async () => {
                  if (!image.url && !image.base64) return;
                  setAnalyzingVision(true);
                  try {
                    const imgSrc = image.url || `data:image/jpeg;base64,${image.base64}`;
                    const res = await fetch('/api/mmx/describe', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ image: imgSrc }),
                    });
                    const data = await res.json();
                    setVisionResult(data.description || data.error || 'Analysis failed');
                  } catch {
                    setVisionResult('Network error — could not analyze image.');
                  } finally {
                    setAnalyzingVision(false);
                  }
                }}
                disabled={analyzingVision || (!image.url && !image.base64)}
                className="absolute bottom-4 left-4 z-50 px-3 py-1.5 bg-[#00e6ff]/20 hover:bg-[#00e6ff]/40 border border-[#00e6ff]/40 text-[#00e6ff] text-xs rounded-full backdrop-blur-sm transition-all flex items-center gap-1.5"
              >
                {analyzingVision ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                {analyzingVision ? 'Analyzing…' : 'Analyze with MMX'}
              </button>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="w-full md:w-96 bg-zinc-900 border-l border-zinc-800 flex flex-col h-full overflow-y-auto">
          <div className="p-4 sm:p-8 space-y-8">
            {/* Metadata grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <h4 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Model</h4>
                <p className="text-xs text-white">{image.modelInfo?.modelName || 'Unknown'}</p>
              </div>
              <div className="space-y-1">
                <h4 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Provider</h4>
                <p className="text-xs text-white capitalize">{image.modelInfo?.provider || 'Unknown'}</p>
              </div>
              {image.imageSize && (
                <div className="space-y-1">
                  <h4 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Image Size</h4>
                  <p className="text-xs text-white">{image.imageSize}</p>
                </div>
              )}
              {image.aspectRatio && (
                <div className="space-y-1">
                  <h4 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Aspect Ratio</h4>
                  <p className="text-xs text-white">{image.aspectRatio}</p>
                </div>
              )}
              {image.seed !== undefined && (
                <div className="space-y-1">
                  <h4 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Seed</h4>
                  <p className="text-xs text-white font-mono">{image.seed}</p>
                </div>
              )}
              {image.universe && (
                <div className="space-y-1">
                  <h4 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Universe</h4>
                  <p className="text-xs text-white">{image.universe}</p>
                </div>
              )}
            </div>

            {image.negativePrompt && (
              <div className="space-y-3">
                <h4 className="text-xs font-bold text-zinc-500 uppercase tracking-widest flex items-center gap-2">
                  <XCircle className="w-3 h-3" />
                  Negative Prompt
                </h4>
                <div className="bg-zinc-950 border border-zinc-800/60 rounded-2xl p-4 text-sm text-zinc-400 leading-relaxed italic">
                  {image.negativePrompt}
                </div>
              </div>
            )}

            <div className="space-y-3">
              <h4 className="text-xs font-bold text-zinc-500 uppercase tracking-widest flex items-center gap-2">
                <Sparkles className="w-3 h-3" />
                Prompt
              </h4>
              <div className="bg-zinc-950 border border-zinc-800/60 rounded-2xl p-4 text-sm text-zinc-300 leading-relaxed group relative">
                {image.prompt}
                <button
                  onClick={() =>
                    navigator.clipboard.writeText(image.prompt).catch(() =>
                      showToast('Failed to copy prompt', 'error'),
                    )
                  }
                  className="absolute top-2 right-2 p-1.5 bg-zinc-900 text-zinc-500 hover:text-white rounded-lg opacity-0 group-hover:opacity-100 transition-all"
                  title="Copy Prompt"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* MMX-VISION-ANALYZE: show result */}
            {visionResult && (
              <div className="space-y-3">
                <h4 className="text-xs font-bold text-[#00e6ff] uppercase tracking-widest flex items-center gap-2">
                  <Sparkles className="w-3 h-3" />
                  MMX Vision Analysis
                </h4>
                <div className="bg-zinc-950 border border-[#00e6ff]/20 rounded-2xl p-4 text-sm text-zinc-300 leading-relaxed">
                  {visionResult}
                </div>
              </div>
            )}

            {/* Tags */}
            <div className="space-y-3">
              <h4 className="text-xs font-bold text-zinc-500 uppercase tracking-widest flex items-center gap-2">
                <Tag className="w-3 h-3" />
                Tags
              </h4>
              <div className="flex flex-wrap gap-2">
                {image.tags?.map((tag) => (
                  <span
                    key={tag}
                    className="px-2 py-1 bg-zinc-800 text-zinc-300 text-xs rounded-lg border border-zinc-700 flex items-center gap-1 group"
                  >
                    {tag}
                    <button
                      onClick={() => {
                        const newTags = image.tags?.filter((t) => t !== tag) || [];
                        updateImageTags(image.id, newTags);
                        onImageChange({ ...image, tags: newTags });
                      }}
                      className="text-zinc-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                <input
                  type="text"
                  placeholder="Add tag..."
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const val = e.currentTarget.value.trim();
                      if (val && !image.tags?.includes(val)) {
                        const newTags = [...(image.tags || []), val];
                        updateImageTags(image.id, newTags);
                        onImageChange({ ...image, tags: newTags });
                        e.currentTarget.value = '';
                      }
                    }
                  }}
                  className="bg-transparent border border-dashed border-zinc-700 rounded-lg px-2 py-1 text-xs text-zinc-400 focus:outline-none focus:border-[#c5a062]/60 w-24"
                />
              </div>
            </div>

            {/* Collection */}
            <div className="space-y-3">
              <h4 className="text-xs font-bold text-zinc-500 uppercase tracking-widest flex items-center gap-2">
                <FolderPlus className="w-3 h-3" />
                Collection
              </h4>
              <select
                value={image.collectionId || ''}
                onChange={(e) => {
                  const colId = e.target.value;
                  if (colId) {
                    addImageToCollection(image.id, colId);
                    onImageChange({ ...image, collectionId: colId });
                  } else {
                    removeImageFromCollection(image.id);
                    onImageChange({ ...image, collectionId: undefined });
                  }
                }}
                className="w-full bg-zinc-950 border border-zinc-800/60 rounded-xl px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30"
              >
                <option value="">None</option>
                {collections.map((col) => (
                  <option key={col.id} value={col.id}>{col.name}</option>
                ))}
              </select>

              <div className="space-y-2 pt-2">
                <input
                  type="text"
                  placeholder="New collection name..."
                  id="new-col-name"
                  className="w-full bg-transparent border-b border-zinc-800 text-xs text-zinc-400 py-1 focus:outline-none focus:border-[#c5a062]/60"
                />
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="Description (optional)..."
                    id="new-col-desc"
                    className="flex-1 bg-transparent border-b border-zinc-800 text-[10px] text-zinc-500 py-1 focus:outline-none focus:border-[#c5a062]/60"
                  />
                  <button
                    onClick={async () => {
                      const nameInput = document.getElementById('new-col-name') as HTMLInputElement;
                      const descInput = document.getElementById('new-col-desc') as HTMLInputElement;
                      const imageIds = selectedForBatch.size > 0 ? Array.from(selectedForBatch) : undefined;
                      if (!nameInput.value.trim()) {
                        await createCollection(undefined, undefined, imageIds);
                      } else {
                        await createCollection(nameInput.value.trim(), descInput.value.trim(), imageIds);
                      }
                      nameInput.value = '';
                      descInput.value = '';
                    }}
                    className="p-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white rounded-lg transition-all flex items-center gap-1"
                    title="Create Collection"
                  >
                    <Plus className="w-4 h-4" />
                    <span className="text-[10px] font-bold uppercase">Add</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="pt-8 border-t border-zinc-800 space-y-4">
              {image.imageId && !image.isVideo && (
                <div className="space-y-4 bg-zinc-950/50 p-4 rounded-2xl border border-zinc-800/60">
                  <div className="flex items-center justify-between text-xs text-zinc-400">
                    <span>Duration</span>
                    <select
                      value={settings.defaultAnimationDuration || 5}
                      onChange={(e) => updateSettings({ defaultAnimationDuration: Number(e.target.value) as 3 | 5 | 10 })}
                      className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1 text-white focus:outline-none"
                    >
                      <option value={3}>3s</option>
                      <option value={5}>5s</option>
                      <option value={10}>10s</option>
                    </select>
                  </div>
                  <button
                    onClick={() => handleAnimate(image)}
                    disabled={image.status === 'animating'}
                    className="w-full py-3 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl font-bold transition-all flex items-center justify-center gap-2 text-xs uppercase tracking-widest"
                  >
                    {image.status === 'animating' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Video className="w-4 h-4" />}
                    {image.status === 'animating' ? 'Animating...' : 'Animate to Video'}
                  </button>
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => {
                    toggleApproveImage(image.id);
                    onImageChange({ ...image, approved: !image.approved });
                  }}
                  className={`flex-1 py-4 rounded-2xl font-bold transition-all flex items-center justify-center gap-2 shadow-lg uppercase tracking-widest text-xs ${
                    image.approved
                      ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-500/20'
                      : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700'
                  }`}
                >
                  <BookmarkCheck className="w-4 h-4" />
                  {image.approved ? 'Approved' : 'Approve'}
                </button>
                <a
                  href={image.url || `data:image/jpeg;base64,${image.base64}`}
                  download={image.isVideo ? 'mashup-video.mp4' : 'mashup-detail.jpg'}
                  className="flex-1 py-4 bg-[#00e6ff] hover:bg-[#33eaff] active:bg-[#00b8cc] text-[#050505] rounded-2xl font-bold transition-all flex items-center justify-center gap-2 shadow-lg shadow-[#00e6ff]/20 uppercase tracking-widest text-xs"
                  target={image.url ? '_blank' : undefined}
                  rel={image.url ? 'noopener noreferrer' : undefined}
                >
                  <Download className="w-4 h-4" />
                  Download
                </a>
                <button
                  onClick={() => {
                    deleteImage(image.id, true);
                    onImageChange(null);
                  }}
                  className="w-14 h-14 flex items-center justify-center bg-zinc-800 hover:bg-red-500/20 text-zinc-500 hover:text-red-400 rounded-2xl transition-all border border-zinc-700"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
