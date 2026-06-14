'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import { X, Tag } from 'lucide-react';

// FIX-100 slice D: extracted from MainContent.tsx (~90 LOC).
// Internal state: tagsInput + mode. Parent owns open/close and the
// batch set; clearBatch() is called after a successful apply.

interface BulkTagModalProps {
  onClose: () => void;
  selectedForBatch: Set<string>;
  clearBatch: () => void;
  bulkUpdateImageTags: (ids: string[], tags: string[], mode: 'append' | 'replace') => void;
}

export function BulkTagModal({
  onClose,
  selectedForBatch,
  clearBatch,
  bulkUpdateImageTags,
}: BulkTagModalProps) {
  const [tagsInput, setTagsInput] = useState('');
  const [mode, setMode] = useState<'append' | 'replace'>('append');

  const handleApply = () => {
    let tags = tagsInput.split(',').map((t) => t.trim()).filter((t) => t !== '');
    // If no commas, try splitting by space but keep known phrases together
    if (tags.length === 1 && tags[0].includes(' ')) {
      const knownPhrases = ['warhammer 40k', 'star wars', 'marvel cinematic universe', 'dc comics'];
      const lowerInput = tags[0].toLowerCase();
      let tempInput = tags[0];
      knownPhrases.forEach((phrase) => {
        if (lowerInput.includes(phrase)) {
          const placeholder = `__PHRASE_${phrase.replace(/\s+/g, '_')}__`;
          tempInput = tempInput.replace(new RegExp(phrase, 'gi'), placeholder);
        }
      });
      tags = tempInput
        .split(/\s+/)
        .map((t) => {
          if (t.startsWith('__PHRASE_') && t.endsWith('__')) {
            return t.replace('__PHRASE_', '').replace('__', '').replace(/_/g, ' ');
          }
          return t;
        })
        .filter((t) => t);
    }

    if (tags.length > 0) {
      bulkUpdateImageTags(Array.from(selectedForBatch), tags, mode);
      onClose();
      setTagsInput('');
      clearBatch();
    }
  };

  const activeClass =
    'bg-[#00e6ff]/10 border-[#00e6ff] text-[#00e6ff]';
  const inactiveClass =
    'bg-zinc-950 border-zinc-800 text-zinc-500 hover:border-zinc-700';

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-0 sm:p-4 bg-black/80 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full sm:max-w-md bg-zinc-900/90 backdrop-blur-xl border-0 sm:border border-zinc-800/60 rounded-none sm:rounded-2xl shadow-2xl overflow-hidden h-full sm:h-auto max-h-[100dvh] sm:max-h-none"
      >
        <div className="p-6 border-b border-zinc-800 flex items-center justify-between">
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <Tag className="w-5 h-5 text-[#00e6ff]" />
            Bulk Tagging ({selectedForBatch.size} Images)
          </h3>
          <button type="button" onClick={onClose} className="text-zinc-500 hover:text-white" aria-label="Close bulk tagging dialog">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-6">
          <div className="space-y-2">
            <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider">
              Tags (Comma separated)
            </label>
            <input
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="e.g. Marvel, Cinematic, 4k"
              className="w-full bg-zinc-950 border border-zinc-800/60 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30"
            />
          </div>
          <div className="flex gap-4">
            <button
              onClick={() => setMode('append')}
              className={`flex-1 py-3 rounded-xl border text-xs font-bold uppercase tracking-wider transition-all ${mode === 'append' ? activeClass : inactiveClass}`}
            >
              Append
            </button>
            <button
              onClick={() => setMode('replace')}
              className={`flex-1 py-3 rounded-xl border text-xs font-bold uppercase tracking-wider transition-all ${mode === 'replace' ? activeClass : inactiveClass}`}
            >
              Replace
            </button>
          </div>
        </div>
        <div className="p-6 bg-zinc-950/50 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-3 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl font-bold text-xs uppercase tracking-widest transition-all"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            className="flex-1 py-3 bg-[#00e6ff] hover:bg-[#33eaff] active:bg-[#00b8cc] text-[#050505] rounded-xl font-bold text-xs uppercase tracking-widest transition-all shadow-lg shadow-[#00e6ff]/20"
          >
            Apply Tags
          </button>
        </div>
      </motion.div>
    </div>
  );
}
