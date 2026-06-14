'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, Check, X, Lightbulb, ImageOff, CheckCircle2 } from 'lucide-react';
import type { GeneratedImage, Idea, ScheduledPost } from '@/types/mashup';
import { groupApprovalPosts } from '@/lib/approval-grouping';
import { CarouselApprovalCard } from '@/components/approval/CarouselApprovalCard';
import { InlineCaptionEditor } from '@/components/approval/InlineCaptionEditor';

export function ApprovalQueue({
  posts,
  images,
  ideas,
  onApprove,
  onReject,
  onBulkApprove,
  onBulkReject,
  onUpdateCaption,
}: {
  posts: ScheduledPost[];
  images: GeneratedImage[];
  ideas: Idea[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onBulkApprove: (ids: string[]) => void;
  onBulkReject: (ids: string[]) => void;
  /** V050-005: inline caption edit. ids carries one for a single
   *  post, or every sibling id for a carousel. */
  onUpdateCaption: (ids: string[], next: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ideaFilter, setIdeaFilter] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState<string | null>(null);
  const [platformFilter, setPlatformFilter] = useState<string | null>(null);
  // Fullscreen preview for an approval thumbnail. Kept local rather
  // than threading selectedImage through context so this stays a leaf
  // concern — the pipeline approval queue is the only place these
  // pipelinePending images live.
  const [previewImage, setPreviewImage] = useState<GeneratedImage | null>(null);
  // V030-005: transient banner after a bulk action so the user sees
  // confirmation before the cards disappear from the queue.
  const [flash, setFlash] = useState<{ kind: 'approve' | 'reject'; count: number } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);
  const triggerFlash = (kind: 'approve' | 'reject', count: number) => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlash({ kind, count });
    flashTimer.current = setTimeout(() => setFlash(null), 3000);
  };

  const imageById = useMemo(() => {
    const m = new Map<string, GeneratedImage>();
    for (const img of images) m.set(img.id, img);
    return m;
  }, [images]);

  const ideaById = useMemo(() => {
    const m = new Map<string, Idea>();
    for (const i of ideas) m.set(i.id, i);
    return m;
  }, [ideas]);

  const { ideaOptions, modelOptions, platformOptions } = useMemo(() => {
    const ideaSet = new Set<string>();
    const modelSet = new Set<string>();
    const platSet = new Set<string>();
    for (const p of posts) {
      if (p.sourceIdeaId) ideaSet.add(p.sourceIdeaId);
      const img = imageById.get(p.imageId);
      const mid = img?.modelInfo?.modelId;
      if (mid) modelSet.add(mid);
      for (const pl of p.platforms || []) platSet.add(pl);
    }
    return {
      ideaOptions: Array.from(ideaSet),
      modelOptions: Array.from(modelSet),
      platformOptions: Array.from(platSet),
    };
  }, [posts, imageById]);

  const filtered = useMemo(() => {
    return posts.filter((p) => {
      if (ideaFilter && p.sourceIdeaId !== ideaFilter) return false;
      if (modelFilter) {
        const img = imageById.get(p.imageId);
        if (img?.modelInfo?.modelId !== modelFilter) return false;
      }
      if (platformFilter && !(p.platforms || []).includes(platformFilter)) return false;
      return true;
    });
  }, [posts, ideaFilter, modelFilter, platformFilter, imageById]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelected(new Set(filtered.map((p) => p.id)));
  };
  const clearSelection = () => setSelected(new Set());

  const selectedCount = selected.size;
  const visibleSelectedIds = filtered.filter((p) => selected.has(p.id)).map((p) => p.id);

  const handleBulkApprove = () => {
    if (selectedCount === 0) return;
    const count = visibleSelectedIds.length;
    onBulkApprove(visibleSelectedIds);
    clearSelection();
    triggerFlash('approve', count);
  };

  const handleBulkReject = () => {
    if (selectedCount === 0) return;
    const count = visibleSelectedIds.length;
    onBulkReject(visibleSelectedIds);
    clearSelection();
    triggerFlash('reject', count);
  };

  const handleApproveAllFiltered = () => {
    if (filtered.length === 0) return;
    const ids = filtered.map((p) => p.id);
    onBulkApprove(ids);
    clearSelection();
    triggerFlash('approve', ids.length);
  };

  const truncateConcept = (s: string | undefined, n = 28) =>
    s ? (s.length > n ? `${s.slice(0, n)}…` : s) : '';

  // V030-005: after the final approval the queue may be empty; we still
  // want to show the confirmation banner so the action didn't happen in
  // silence. Render a compact banner-only container in that case.
  if (posts.length === 0) {
    if (!flash) return null;
    return (
      <div
        role="status"
        aria-live="polite"
        className={`flex items-center gap-2 text-xs px-3 py-2 rounded-xl border ${
          flash.kind === 'approve'
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
            : 'bg-red-500/10 border-red-500/30 text-red-300'
        }`}
      >
        {flash.kind === 'approve' ? (
          <CheckCircle2 className="w-4 h-4" />
        ) : (
          <X className="w-4 h-4" />
        )}
        <span>
          {flash.kind === 'approve'
            ? `${flash.count} post${flash.count === 1 ? '' : 's'} moved to schedule`
            : `${flash.count} post${flash.count === 1 ? '' : 's'} removed from queue`}
        </span>
      </div>
    );
  }

  return (
    <div className="bg-[#00e6ff]/5 rounded-2xl border border-[#00e6ff]/25 p-3 sm:p-5 space-y-3 sm:space-y-4">
      {flash && (
        <div
          role="status"
          aria-live="polite"
          className={`flex items-center gap-2 text-xs px-3 py-2 rounded-xl border ${
            flash.kind === 'approve'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
              : 'bg-red-500/10 border-red-500/30 text-red-300'
          }`}
        >
          {flash.kind === 'approve' ? (
            <CheckCircle2 className="w-4 h-4" />
          ) : (
            <X className="w-4 h-4" />
          )}
          <span>
            {flash.kind === 'approve'
              ? `${flash.count} post${flash.count === 1 ? '' : 's'} moved to schedule`
              : `${flash.count} post${flash.count === 1 ? '' : 's'} removed from queue`}
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <CheckCircle2 className="w-4 h-4 text-[#00e6ff] shrink-0" />
          <span className="text-sm font-medium text-[#00e6ff] truncate">
            Pipeline Approval ({posts.length})
            {filtered.length !== posts.length && (
              <span className="text-[#00e6ff]/70"> · {filtered.length} shown</span>
            )}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          <button
            onClick={handleApproveAllFiltered}
            disabled={filtered.length === 0}
            className="text-[11px] px-2.5 py-1 bg-[#c5a062] hover:bg-[#d4b478] active:bg-[#a68748] text-[#050505] font-semibold rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
          >
            <Check className="w-3 h-3" />
            Approve All ({filtered.length})
          </button>
          <button
            onClick={selectAllVisible}
            className="text-[11px] px-2 py-1 bg-zinc-800 text-zinc-300 rounded-xl hover:bg-zinc-700 transition-colors"
          >
            Select All
          </button>
          <button
            onClick={clearSelection}
            disabled={selectedCount === 0}
            className="text-[11px] px-2 py-1 bg-zinc-800 text-zinc-400 rounded-xl hover:bg-zinc-700 transition-colors disabled:opacity-40"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Filter pills */}
      {(ideaOptions.length > 0 || modelOptions.length > 0 || platformOptions.length > 0) && (
        <div className="space-y-2">
          {ideaOptions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wide text-zinc-500 mr-1">Topic</span>
              <button
                onClick={() => setIdeaFilter(null)}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                  ideaFilter === null
                    ? 'bg-[#00e6ff]/15 text-[#00e6ff] border-[#00e6ff]/40'
                    : 'bg-[#050505]/80 text-zinc-400 border-[#c5a062]/20 hover:border-[#c5a062]/50'
                }`}
              >
                All
              </button>
              {ideaOptions.map((id) => (
                <button
                  key={id}
                  onClick={() => setIdeaFilter(id)}
                  className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                    ideaFilter === id
                      ? 'bg-[#00e6ff]/15 text-[#00e6ff] border-[#00e6ff]/40'
                      : 'bg-[#050505]/80 text-zinc-400 border-[#c5a062]/20 hover:border-[#c5a062]/50'
                  }`}
                  title={ideaById.get(id)?.concept || id}
                >
                  {truncateConcept(ideaById.get(id)?.concept) || id.slice(0, 8)}
                </button>
              ))}
            </div>
          )}

          {modelOptions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wide text-zinc-500 mr-1">Model</span>
              <button
                onClick={() => setModelFilter(null)}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                  modelFilter === null
                    ? 'bg-[#00e6ff]/15 text-[#00e6ff] border-[#00e6ff]/40'
                    : 'bg-[#050505]/80 text-zinc-400 border-[#c5a062]/20 hover:border-[#c5a062]/50'
                }`}
              >
                All
              </button>
              {modelOptions.map((m) => (
                <button
                  key={m}
                  onClick={() => setModelFilter(m)}
                  className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                    modelFilter === m
                      ? 'bg-[#00e6ff]/15 text-[#00e6ff] border-[#00e6ff]/40'
                      : 'bg-[#050505]/80 text-zinc-400 border-[#c5a062]/20 hover:border-[#c5a062]/50'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          )}

          {platformOptions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wide text-zinc-500 mr-1">Platform</span>
              <button
                onClick={() => setPlatformFilter(null)}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                  platformFilter === null
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                    : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:border-zinc-500'
                }`}
              >
                All
              </button>
              {platformOptions.map((p) => (
                <button
                  key={p}
                  onClick={() => setPlatformFilter(p)}
                  className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                    platformFilter === p
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                      : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:border-zinc-500'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Bulk action bar — shown only when items are selected */}
      {selectedCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[#c5a062]/20">
          <span className="text-xs text-[#c5a062]">{selectedCount} selected</span>
          <button
            onClick={handleBulkApprove}
            className="text-xs px-3 py-1 bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-300 rounded-xl border border-emerald-500/40 transition-colors"
          >
            <Check className="w-3 h-3 inline mr-1" />
            Approve Selected
          </button>
          <button
            onClick={handleBulkReject}
            className="text-xs px-3 py-1 bg-red-600/30 hover:bg-red-600/50 text-red-200 rounded-xl border border-red-500/40 transition-colors"
          >
            <X className="w-3 h-3 inline mr-1" />
            Reject Selected
          </button>
        </div>
      )}

      {/* Card grid — V040-DES-003: groups carousel posts into one card,
          singles render as before. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {groupApprovalPosts(filtered).map((item) => {
          if (item.kind === 'carousel') {
            const postIds = item.posts.map((p) => p.id);
            const anyInGroupSelected = postIds.some((id) => selected.has(id));
            const firstIdeaId = item.posts.find((p) => p.sourceIdeaId)?.sourceIdeaId;
            const idea = firstIdeaId ? ideaById.get(firstIdeaId) : undefined;
            return (
              <CarouselApprovalCard
                key={item.groupId}
                groupId={item.groupId}
                posts={item.posts}
                imagesById={imageById}
                idea={idea}
                selected={anyInGroupSelected}
                onToggleSelect={() => {
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (anyInGroupSelected) {
                      for (const id of postIds) next.delete(id);
                    } else {
                      for (const id of postIds) next.add(id);
                    }
                    return next;
                  });
                }}
                onApprovePost={(id) => {
                  onApprove(id);
                  triggerFlash('approve', 1);
                }}
                onRejectPost={(id) => {
                  onReject(id);
                  triggerFlash('reject', 1);
                }}
                onUpdateCaption={(next) => onUpdateCaption(postIds, next)}
                onImageClick={(clicked) => setPreviewImage(clicked)}
              />
            );
          }
          const post = item.post;
          const img = imageById.get(post.imageId);
          const idea = post.sourceIdeaId ? ideaById.get(post.sourceIdeaId) : undefined;
          const isSelected = selected.has(post.id);
          const modelName = img?.modelInfo?.modelName || img?.modelInfo?.modelId;
          return (
            <div
              key={post.id}
              className={`relative bg-[#050505]/70 rounded-xl border p-3 space-y-2 transition-all duration-200 ${
                isSelected
                  ? 'border-[#c5a062]/60 shadow-[0_0_14px_rgba(197,160,98,0.22)]'
                  : 'border-[#c5a062]/20 hover:border-[#c5a062]/45 hover:shadow-[0_0_10px_rgba(197,160,98,0.10)]'
              }`}
            >
              <label className="absolute top-2 left-2 z-10 flex items-center justify-center w-5 h-5 bg-[#050505]/85 border border-[#c5a062]/25 rounded cursor-pointer">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSelect(post.id)}
                  className="w-4 h-4 accent-[#c5a062] cursor-pointer"
                />
              </label>

              <div className="w-full aspect-video rounded-xl overflow-hidden bg-zinc-900 border border-[#c5a062]/15">
                {img ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={img.url || (img.base64 ? `data:image/png;base64,${img.base64}` : '')}
                    alt=""
                    className="w-full h-full object-cover cursor-zoom-in"
                    onClick={() => setPreviewImage(img)}
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <ImageOff className="w-6 h-6 text-zinc-600" />
                  </div>
                )}
              </div>

              {idea && (
                <div className="flex items-center gap-1 text-[10px] text-[#c5a062]/80">
                  <Lightbulb className="w-3 h-3" />
                  <span className="truncate">{idea.concept}</span>
                </div>
              )}

              <InlineCaptionEditor
                caption={post.caption}
                onSave={(next) => onUpdateCaption([post.id], next)}
              />

              <div className="flex items-center justify-between text-[10px] text-zinc-500">
                <span>{post.date} {post.time}</span>
                {modelName && <span className="text-[#00e6ff]/80">{modelName}</span>}
              </div>

              {post.platforms && post.platforms.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {post.platforms.map((pl) => (
                    <span
                      key={pl}
                      className="text-[9px] px-1.5 py-0.5 bg-[#050505]/80 border border-[#c5a062]/20 text-zinc-300 rounded"
                    >
                      {pl}
                    </span>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => {
                    onApprove(post.id);
                    triggerFlash('approve', 1);
                  }}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/40 rounded-lg text-emerald-400 text-xs transition-colors"
                  title="Approve"
                >
                  <Check className="w-3.5 h-3.5" />
                  Approve
                </button>
                <button
                  onClick={() => {
                    onReject(post.id);
                    triggerFlash('reject', 1);
                  }}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 bg-red-600/20 hover:bg-red-600/40 rounded-lg text-red-400 text-xs transition-colors"
                  title="Reject"
                >
                  <X className="w-3.5 h-3.5" />
                  Reject
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {previewImage && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Preview image"
          onClick={() => setPreviewImage(null)}
          className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 cursor-zoom-out"
        >
          <button
            type="button"
            aria-label="Close preview"
            onClick={(e) => {
              e.stopPropagation();
              setPreviewImage(null);
            }}
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-zinc-900/80 text-zinc-200 hover:bg-zinc-800 flex items-center justify-center"
          >
            <X className="w-5 h-5" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewImage.url || (previewImage.base64 ? `data:image/png;base64,${previewImage.base64}` : '')}
            alt={previewImage.prompt || ''}
            onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-full object-contain rounded-lg"
          />
        </div>
      )}
    </div>
  );
}
