'use client';

/**
 * FEAT-2 §7: undo affordance for DnD moves in Post Ready.
 *
 * Toast appears bottom-right after a successful move, displays a 5s
 * progress bar that drains, then fades out. While visible, ⌘Z / Ctrl+Z
 * (handled in MainContent.tsx) or clicking the Undo button reverses the
 * move via `onUndo`. Hover pauses the dismissal timer.
 */

import { useEffect, useRef, useState } from 'react';
import { Undo2 } from 'lucide-react';

const DEFAULT_DURATION_MS = 5000;

export interface DndUndoToastProps {
  /** When non-null, the toast is shown with this message. Set to null to
   *  hide. Each new non-null value resets the timer. */
  message: string | null;
  /** Invoked when the user clicks the Undo button (Ctrl+Z is handled
   *  by the global keyboard handler, not here). */
  onUndo: () => void;
  /** Invoked when the toast self-dismisses or the user dismisses it. */
  onDismiss: () => void;
  /** Override timer in tests. */
  durationMs?: number;
}

export function DndUndoToast({
  message,
  onUndo,
  onDismiss,
  durationMs = DEFAULT_DURATION_MS,
}: DndUndoToastProps) {
  const [paused, setPaused] = useState(false);
  // `tick` is bumped each time a new message arrives so the progress bar
  // restarts even if the same message text is shown twice in a row.
  const [tick, setTick] = useState(0);
  const lastMsgRef = useRef<string | null>(null);

  // V105.1-REACT-19: setTick deferred via queueMicrotask (project
  // convention) so the effect body only triggers a tick on new
  // messages, not local state in the body itself.
  useEffect(() => {
    if (message !== lastMsgRef.current) {
      lastMsgRef.current = message;
      if (message !== null) queueMicrotask(() => setTick((t) => t + 1));
    }
  }, [message]);

  useEffect(() => {
    if (message === null || paused) return;
    const id = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(id);
  }, [message, paused, durationMs, onDismiss, tick]);

  if (message === null) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="dnd-undo-toast"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className="fixed bottom-6 right-6 z-50 min-w-[280px] bg-zinc-900 border border-zinc-800/60 rounded-xl shadow-2xl backdrop-blur-md overflow-hidden"
    >
      {/* Progress bar — drains over `durationMs`. Restarted via the
          `tick`-keyed inline animation duration. */}
      <div
        key={tick}
        className="h-px bg-[#00e6ff]"
        style={{
          animation: `dnd-undo-toast-drain ${durationMs}ms linear forwards`,
          animationPlayState: paused ? 'paused' : 'running',
        }}
      />
      <div className="px-4 py-3 flex items-center gap-3">
        <Undo2 className="w-4 h-4 text-[#c5a062] shrink-0" aria-hidden="true" />
        <span className="text-sm text-zinc-200">{message}</span>
        <span className="ml-auto flex items-center gap-2">
          <kbd className="font-mono text-[10px] px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-300">
            ⌘Z
          </kbd>
          <button
            type="button"
            onClick={onUndo}
            className="text-[11px] text-[#00e6ff] hover:underline"
            data-testid="dnd-undo-toast-button"
          >
            Undo
          </button>
        </span>
      </div>
      {/* Inline keyframes — kept local to the component so it ships with
          the chunk and doesn't pollute globals.css for one transient
          affordance. */}
      <style jsx>{`
        @keyframes dnd-undo-toast-drain {
          from { width: 100%; }
          to { width: 0%; }
        }
      `}</style>
    </div>
  );
}
