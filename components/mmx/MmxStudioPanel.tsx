'use client';

/**
 * MMX studio panel — floating bottom-right action group.
 *
 * Surfaces the music + video generation affordances added by FEAT-MMX-MUSIC-UI.
 * Mounted from MashupStudio so it sits over the studio shell regardless of
 * which view (gallery, post-ready, etc.) is active. Returns null when the
 * MMX CLI is unavailable on the server so the panel quietly disappears
 * rather than serving up buttons that will only error.
 *
 * Speech synthesis ("Read aloud") lives on individual sidebar messages and
 * is wired separately in Sidebar.tsx — it doesn't belong in this floating
 * action group.
 */

import { useEffect, useRef, useState } from 'react';
import { Music, Video, Loader2, X, Sparkles, AudioLines } from 'lucide-react';
import { useMmxAvailability } from '@/lib/useMmxAvailability';

type MusicState =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'ready'; url: string }
  | { kind: 'error'; message: string };

type VideoState =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'ready'; taskId: string | null; path: string | null }
  | { kind: 'error'; message: string };

export function MmxStudioPanel() {
  const available = useMmxAvailability();
  const [musicOpen, setMusicOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);

  if (!available) return null;

  return (
    <>
      <div
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 px-2 py-1.5 rounded-full bg-[#050505]/85 backdrop-blur-md border border-[#c5a062]/30 shadow-[0_8px_28px_rgba(0,0,0,0.5)]"
        data-testid="mmx-studio-panel"
        aria-label="MMX generation"
      >
        <span className="inline-flex items-center gap-1 pl-2 pr-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[#c5a062]/80">
          <Sparkles className="w-3 h-3" />
          MMX
        </span>
        <button
          type="button"
          onClick={() => setMusicOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full bg-[#c5a062]/15 hover:bg-[#c5a062]/25 text-[#c5a062] border border-[#c5a062]/40 transition-colors"
          title="Generate background music"
        >
          <Music className="w-3.5 h-3.5" />
          Music
        </button>
        <button
          type="button"
          onClick={() => setVideoOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full bg-[#00e6ff]/15 hover:bg-[#00e6ff]/25 text-[#00e6ff] border border-[#00e6ff]/40 transition-colors"
          title="Generate a short video clip"
        >
          <Video className="w-3.5 h-3.5" />
          Video
        </button>
      </div>

      {musicOpen && <MusicModal onClose={() => setMusicOpen(false)} />}
      {videoOpen && <VideoModal onClose={() => setVideoOpen(false)} />}
    </>
  );
}

// ─── Music modal ────────────────────────────────────────────────────────────

function MusicModal({ onClose }: { onClose: () => void }) {
  const [prompt, setPrompt] = useState('');
  const [instrumental, setInstrumental] = useState(true);
  const [lyrics, setLyrics] = useState('');
  const [state, setState] = useState<MusicState>({ kind: 'idle' });
  const objectUrlRef = useRef<string | null>(null);

  // Revoke any blob URL we minted when the modal unmounts so we don't leak
  // memory if the user generates 5 tracks in a row without closing.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  const generate = async () => {
    if (!prompt.trim()) return;
    setState({ kind: 'generating' });
    try {
      const body: { prompt: string; options?: Record<string, unknown> } = { prompt };
      if (instrumental) {
        body.options = { instrumental: true };
      } else if (lyrics.trim()) {
        body.options = { lyrics: lyrics.trim() };
      }
      const res = await fetch('/api/mmx/music', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setState({ kind: 'error', message: err.error || `Request failed (${res.status})` });
        return;
      }
      const blob = await res.blob();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      setState({ kind: 'ready', url });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'Music generation failed' });
    }
  };

  return (
    <ModalShell title="Generate Music" icon={<Music className="w-4 h-4 text-[#c5a062]" />} onClose={onClose}>
      <label className="space-y-1 block">
        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Prompt</span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Cinematic synth pad, slow 80 BPM, melancholic, sci-fi"
          rows={3}
          className="input-brand w-full resize-none"
          autoFocus
        />
      </label>

      <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-zinc-900/50 border border-zinc-800/60">
        <div className="min-w-0">
          <p className="text-xs font-medium text-zinc-200">Instrumental</p>
          <p className="text-[10px] text-zinc-500">Off to add lyrics.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={instrumental}
          onClick={() => setInstrumental((v) => !v)}
          className={`relative w-10 h-5 rounded-full transition-colors ${
            instrumental ? 'bg-[#c5a062]' : 'bg-zinc-700'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              instrumental ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {!instrumental && (
        <label className="space-y-1 block">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Lyrics</span>
          <textarea
            value={lyrics}
            onChange={(e) => setLyrics(e.target.value)}
            placeholder="Verse, chorus, bridge…"
            rows={4}
            className="input-brand w-full resize-none"
          />
        </label>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button onClick={onClose} className="btn-ghost text-xs">
          Close
        </button>
        <button
          onClick={generate}
          disabled={!prompt.trim() || state.kind === 'generating'}
          className="btn-gold-sm"
        >
          {state.kind === 'generating' ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating…
            </>
          ) : (
            <>
              <Sparkles className="w-3.5 h-3.5" /> Generate
            </>
          )}
        </button>
      </div>

      {state.kind === 'ready' && (
        <div className="space-y-2 p-3 rounded-xl bg-zinc-900/60 border border-[#c5a062]/25">
          <div className="flex items-center gap-2 text-xs text-[#c5a062]">
            <AudioLines className="w-3.5 h-3.5" />
            <span className="font-medium tracking-wide">Track ready</span>
          </div>
          <audio controls src={state.url} className="w-full" />
          <a
            href={state.url}
            download="mmx-track.mp3"
            className="text-[11px] text-zinc-400 hover:text-[#c5a062] underline-offset-2 hover:underline"
          >
            Download .mp3
          </a>
        </div>
      )}

      {state.kind === 'error' && (
        <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
          {state.message}
        </p>
      )}
    </ModalShell>
  );
}

// ─── Video modal ────────────────────────────────────────────────────────────

function VideoModal({ onClose }: { onClose: () => void }) {
  const [prompt, setPrompt] = useState('');
  const [state, setState] = useState<VideoState>({ kind: 'idle' });

  const generate = async () => {
    if (!prompt.trim()) return;
    setState({ kind: 'generating' });
    try {
      const res = await fetch('/api/mmx/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        taskId?: string | null;
        path?: string | null;
        error?: string;
      };
      if (!res.ok) {
        setState({ kind: 'error', message: data.error || `Request failed (${res.status})` });
        return;
      }
      setState({ kind: 'ready', taskId: data.taskId ?? null, path: data.path ?? null });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'Video generation failed' });
    }
  };

  return (
    <ModalShell title="Generate Video" icon={<Video className="w-4 h-4 text-[#00e6ff]" />} onClose={onClose}>
      <label className="space-y-1 block">
        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Prompt</span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="A neon-lit city skyline at dusk, slow drone push-in, 4 seconds"
          rows={3}
          className="input-brand w-full resize-none"
          autoFocus
        />
      </label>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button onClick={onClose} className="btn-ghost text-xs">
          Close
        </button>
        <button
          onClick={generate}
          disabled={!prompt.trim() || state.kind === 'generating'}
          className="btn-blue-sm"
        >
          {state.kind === 'generating' ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Submitting…
            </>
          ) : (
            <>
              <Sparkles className="w-3.5 h-3.5" /> Generate
            </>
          )}
        </button>
      </div>

      {state.kind === 'ready' && (
        <div className="space-y-2 p-3 rounded-xl bg-zinc-900/60 border border-[#00e6ff]/25">
          <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#00e6ff]/15 border border-[#00e6ff]/40 text-[#00e6ff] text-[10px] font-bold uppercase tracking-wider">
            <Loader2 className="w-3 h-3 animate-spin" />
            Generating
          </div>
          {state.taskId ? (
            <p className="text-xs text-zinc-300">
              Task ID: <span className="font-mono text-[#00e6ff]">{state.taskId}</span>
            </p>
          ) : (
            <p className="text-xs text-zinc-500">Task started — no ID returned.</p>
          )}
          <p className="text-[10px] text-zinc-500">
            Polling and download UI is out of scope for v1 — fetch the finished video later via the MMX CLI.
          </p>
        </div>
      )}

      {state.kind === 'error' && (
        <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
          {state.message}
        </p>
      )}
    </ModalShell>
  );
}

// ─── Shared modal shell ─────────────────────────────────────────────────────

function ModalShell({
  title,
  icon,
  onClose,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  // Escape closes the modal (parity with the calendar trash modal QA-W4 fix).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-[#050505]/95 backdrop-blur-xl border border-[#c5a062]/30 rounded-2xl p-5 space-y-3 shadow-[0_0_36px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            {icon}
            {title}
          </h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-full"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
