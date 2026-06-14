'use client';

/**
 * Read-aloud affordance for chat-style messages.
 *
 * Posts the supplied text to /api/mmx/speech, plays the returned mp3
 * inline, and toggles between play / stop. Hides itself when mmx is
 * unavailable on the server. One-shot per click — nothing is saved.
 */

import { useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX, Loader2 } from 'lucide-react';
import { useMmxAvailability } from '@/lib/useMmxAvailability';

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'playing'; url: string }
  | { kind: 'error'; message: string };

export function ReadAloudButton({ text }: { text: string }) {
  const available = useMmxAvailability();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  if (!available) return null;

  const stop = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setState({ kind: 'idle' });
  };

  const play = async () => {
    if (!text.trim()) return;
    setState({ kind: 'loading' });
    try {
      const res = await fetch('/api/mmx/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setState({ kind: 'error', message: err.error || `Speech failed (${res.status})` });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.addEventListener('ended', stop);
      audio.addEventListener('error', () =>
        setState({ kind: 'error', message: 'Audio playback failed' }),
      );
      await audio.play();
      setState({ kind: 'playing', url });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'Speech failed' });
    }
  };

  if (state.kind === 'loading') {
    return (
      <button
        type="button"
        disabled
        className="inline-flex items-center gap-1 text-[10px] text-zinc-500 px-1.5 py-0.5 rounded-full"
      >
        <Loader2 className="w-3 h-3 animate-spin" />
        Loading
      </button>
    );
  }

  if (state.kind === 'playing') {
    return (
      <button
        type="button"
        onClick={stop}
        className="inline-flex items-center gap-1 text-[10px] text-[#00e6ff] hover:text-[#33eaff] px-1.5 py-0.5 rounded-full transition-colors"
        aria-label="Stop reading"
      >
        <VolumeX className="w-3 h-3" />
        Stop
      </button>
    );
  }

  if (state.kind === 'error') {
    return (
      <button
        type="button"
        onClick={play}
        title={state.message}
        className="inline-flex items-center gap-1 text-[10px] text-red-400 hover:text-red-300 px-1.5 py-0.5 rounded-full transition-colors"
      >
        <Volume2 className="w-3 h-3" />
        Retry
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={play}
      className="inline-flex items-center gap-1 text-[10px] text-zinc-500 hover:text-[#c5a062] px-1.5 py-0.5 rounded-full transition-colors"
      aria-label="Read message aloud"
    >
      <Volume2 className="w-3 h-3" />
      Read aloud
    </button>
  );
}
