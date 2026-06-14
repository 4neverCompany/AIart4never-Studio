'use client';

import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { X, Sparkles, Loader2, ChevronDown } from 'lucide-react';

// FEAT-004: simplified to a single-field flow. Name is the only required
// field; description is hidden behind an inline disclosure. ✨ Suggest
// pulls a name + description from pi.dev when the user opened the modal
// from a batch selection. Submit on Enter; blank submit is allowed
// (the parent's createCollection auto-names from selection or falls
// back to "Collection N").

interface CollectionModalProps {
  onClose: () => void;
  onCreate: (input: { name?: string; description?: string }) => void | Promise<void>;
  /** Count of pre-selected images, displayed as a hint and unlocking ✨ Suggest. */
  selectionCount?: number;
  /** Async lookup that fills name + description from the current selection. */
  onSuggest?: () => Promise<{ name: string; description: string } | null>;
}

export function CollectionModal({
  onClose,
  onCreate,
  selectionCount = 0,
  onSuggest,
}: CollectionModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [showDescription, setShowDescription] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async () => {
    if (isCreating) return;
    setIsCreating(true);
    try {
      await onCreate({
        name: name.trim() || undefined,
        description: description.trim() || undefined,
      });
    } finally {
      setIsCreating(false);
    }
  };

  const suggest = async () => {
    if (!onSuggest || isSuggesting) return;
    setIsSuggesting(true);
    try {
      const out = await onSuggest();
      if (out) {
        setName(out.name);
        setDescription(out.description);
        if (out.description) setShowDescription(true);
      }
    } finally {
      setIsSuggesting(false);
    }
  };

  const canSuggest = !!onSuggest && selectionCount > 0;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/80 backdrop-blur-sm p-0 sm:p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.12 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md bg-zinc-900/95 backdrop-blur-xl border-0 sm:border border-[#c5a062]/30 rounded-none sm:rounded-2xl shadow-2xl overflow-hidden h-full sm:h-auto max-h-[100dvh] sm:max-h-none flex flex-col"
      >
        <div className="px-5 pt-4 pb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="text-sm font-semibold text-white truncate">New Collection</h3>
            {selectionCount > 0 && (
              <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-mono bg-[#c5a062]/15 text-[#c5a062] border border-[#c5a062]/30 rounded-full">
                from {selectionCount} image{selectionCount === 1 ? '' : 's'}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-white transition-colors -mr-1"
            aria-label="Close collection dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pb-4 space-y-2.5">
          <div className="flex items-stretch gap-2">
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void submit(); }
                else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
              }}
              placeholder={
                isSuggesting
                  ? 'Generating name from your selection…'
                  : canSuggest
                    ? 'Name (or leave blank to auto-name)'
                    : 'Collection name'
              }
              disabled={isSuggesting || isCreating}
              // V080-DES-004: subtle gold-tinted ring while pi.dev is
              // composing the suggestion so users see WHICH fields will
              // get populated, not just that the button is busy.
              className={`flex-1 min-w-0 bg-zinc-950 border rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-[#c5a062]/40 disabled:opacity-60 transition-colors ${
                isSuggesting
                  ? 'border-[#c5a062]/50 ring-1 ring-[#c5a062]/30 animate-pulse'
                  : 'border-zinc-800/60'
              }`}
            />
            {canSuggest && (
              <button
                type="button"
                onClick={() => void suggest()}
                disabled={isSuggesting || isCreating}
                title="Suggest a name from your selection"
                aria-label="Suggest name and description from selection"
                className="shrink-0 inline-flex items-center gap-1.5 px-3 rounded-lg text-xs font-semibold bg-[#c5a062]/15 hover:bg-[#c5a062]/25 text-[#c5a062] border border-[#c5a062]/30 disabled:opacity-60 disabled:cursor-wait transition-colors"
              >
                {isSuggesting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" />
                )}
                Suggest
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => setShowDescription((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <ChevronDown className={`w-3 h-3 transition-transform ${showDescription ? 'rotate-180' : ''}`} />
            {showDescription ? 'Hide description' : 'Add description (optional)'}
          </button>

          {showDescription && (
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
                else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
              }}
              placeholder={
                isSuggesting
                  ? 'Generating description…'
                  : 'What is this collection about?'
              }
              disabled={isSuggesting || isCreating}
              className={`w-full bg-zinc-950 border rounded-lg px-3 py-2 text-xs text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-[#c5a062]/40 min-h-[64px] resize-none disabled:opacity-60 transition-colors ${
                isSuggesting
                  ? 'border-[#c5a062]/50 ring-1 ring-[#c5a062]/30 animate-pulse'
                  : 'border-zinc-800/60'
              }`}
            />
          )}
        </div>

        <div className="px-5 pb-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isCreating}
            className="px-3 py-1.5 text-xs text-zinc-400 hover:text-white transition-colors disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={isCreating || isSuggesting}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-[#00e6ff] hover:bg-[#33eaff] active:bg-[#00b8cc] text-[#050505] disabled:opacity-60 disabled:cursor-wait transition-colors"
          >
            {isCreating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {isCreating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
