'use client';

// V050-005: tap-to-edit caption editor for the approval queue. Click
// the rendered caption → it swaps to a textarea pre-populated with
// the current value. Save triggers on blur or Enter (without Shift).
// Escape cancels without saving. Shift+Enter inserts a newline so
// multi-line captions stay possible.
//
// Designed to be a drop-in replacement for the static caption <p> in
// CarouselApprovalCard and the single-post card in ApprovalQueue.

import { useEffect, useRef, useState } from 'react';

export interface InlineCaptionEditorProps {
  caption: string | undefined;
  onSave: (next: string) => void;
  /** Optional placeholder when caption is empty. */
  placeholder?: string;
  /** Override class for the read-only caption display. */
  readClassName?: string;
}

export function InlineCaptionEditor({
  caption,
  onSave,
  placeholder = 'No caption',
  readClassName = 'text-xs text-zinc-300 line-clamp-2 min-h-[2rem]',
}: InlineCaptionEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(caption ?? '');
  const cancelledRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Keep the draft in sync when the parent caption changes externally
  // (e.g. another save lands while we're not editing).
  //
  // V105.1-REACT-19: setDraft deferred via queueMicrotask (project
  // convention) so the effect body only watches caption + editing, not
  // local state in the body itself.
  useEffect(() => {
    if (!editing) queueMicrotask(() => setDraft(caption ?? ''));
  }, [caption, editing]);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [editing]);

  const commit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      setDraft(caption ?? '');
      setEditing(false);
      return;
    }
    const next = draft.trim();
    const prev = (caption ?? '').trim();
    if (next !== prev) onSave(next);
    setEditing(false);
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        className={`${readClassName} text-left w-full hover:bg-zinc-800/30 rounded px-1 -mx-1 cursor-text transition-colors`}
        aria-label="Edit caption"
        title="Click to edit caption"
      >
        {caption || <span className="text-zinc-600 italic">{placeholder}</span>}
      </button>
    );
  }

  return (
    <textarea
      ref={textareaRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelledRef.current = true;
          // Blur will call commit, which sees cancelledRef and bails.
          textareaRef.current?.blur();
        }
      }}
      onClick={(e) => e.stopPropagation()}
      rows={3}
      placeholder={placeholder}
      className="w-full text-xs text-zinc-100 bg-zinc-950 border border-[#c5a062]/40 focus:border-[#c5a062] rounded px-2 py-1.5 outline-none resize-y min-h-[3rem]"
      aria-label="Caption editor"
    />
  );
}
