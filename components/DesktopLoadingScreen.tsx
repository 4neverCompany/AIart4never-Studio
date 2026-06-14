'use client';

import { useEffect, useState } from 'react';

// ── Status message cycle ──────────────────────────────────────────────────────

const STATUS_MESSAGES = [
  'Loading studio…',
  'Restoring your universe…',
  'Loading collections…',
  'Syncing ideas…',
  'Calibrating the multiverse…',
] as const;

const MESSAGE_INTERVAL_MS = 1800;

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Full-screen branded loading screen shown while the app shell initializes
 * (MashupContext hydration from localStorage, auth check, etc.).
 *
 * Visual language matches the Tauri splash screen (STORY-024) so the
 * transition feels seamless on desktop: same ring logo mark, same gold
 * shimmer wordmark, same Electric Blue spinner.
 */
export function DesktopLoadingScreen() {
  const [msgIdx, setMsgIdx] = useState(0);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    const cycle = setInterval(() => {
      // Fade out → swap message → fade in
      setFading(true);
      setTimeout(() => {
        setMsgIdx((i) => (i + 1) % STATUS_MESSAGES.length);
        setFading(false);
      }, 260);
    }, MESSAGE_INTERVAL_MS);

    return () => clearInterval(cycle);
  }, []);

  return (
    <div
      className="fixed inset-0 z-[9990] flex flex-col items-center justify-center bg-[#050505]"
      role="status"
      aria-label="Loading MashupForge"
    >
      {/* Radial depth glow */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 70% 50% at 50% 42%, rgba(197,160,98,0.055) 0%, transparent 68%)',
        }}
        aria-hidden="true"
      />

      {/* ── Logo mark ── */}
      <div className="relative w-14 h-14 mb-7 shrink-0" aria-hidden="true">
        {/* Outer gold ring */}
        <div
          className="absolute inset-0 rounded-full border border-[#c5a062]/55"
          style={{ animation: 'ds-ring-breathe 3s ease-in-out infinite' }}
        />
        {/* Inner blue ring */}
        <div
          className="absolute rounded-full border border-[#00e6ff]/45"
          style={{
            inset: '10px',
            animation: 'ds-ring-breathe 3s ease-in-out infinite 0.45s',
          }}
        />
        {/* Centre gold dot */}
        <div
          className="absolute rounded-full bg-[#c5a062]"
          style={{
            width: 8,
            height: 8,
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            boxShadow: '0 0 10px rgba(197,160,98,0.9), 0 0 20px rgba(197,160,98,0.35)',
            animation: 'ds-dot-glow 3s ease-in-out infinite 0.9s',
          }}
        />
      </div>

      {/* ── Wordmark ── */}
      <div
        className="text-2xl font-bold uppercase tracking-[0.2em] mb-1 select-none"
        style={{
          background:
            'linear-gradient(90deg, #a07840, #c5a062 40%, #e8c987 55%, #c5a062 70%, #a07840)',
          backgroundSize: '200% auto',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
          animation: 'ds-word-shimmer 4s linear infinite',
        }}
        aria-hidden="true"
      >
        MashupForge
      </div>

      {/* ── Tagline ── */}
      <div
        className="text-[0.575rem] font-medium uppercase tracking-[0.4em] mb-9 select-none"
        style={{ color: 'rgba(0,230,255,0.45)' }}
        aria-hidden="true"
      >
        MashupForge
      </div>

      {/* ── Gold rule ── */}
      <div
        className="w-24 h-px mb-9"
        style={{
          background:
            'linear-gradient(90deg, transparent, rgba(197,160,98,0.45), transparent)',
        }}
        aria-hidden="true"
      />

      {/* ── Electric Blue arc spinner ── */}
      <div className="relative w-8 h-8 mb-4 shrink-0" aria-hidden="true">
        {/* Track */}
        <div className="absolute inset-0 rounded-full border border-[#00e6ff]/10" />
        {/* Arc */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            border: '1.5px solid transparent',
            borderTopColor: '#00e6ff',
            boxShadow: '0 0 8px rgba(0,230,255,0.45)',
            animation: 'spin 1s linear infinite',
          }}
        />
      </div>

      {/* ── Cycling status message ── */}
      <p
        className="text-[0.675rem] tracking-[0.07em] text-zinc-600 transition-opacity duration-[260ms]"
        style={{ opacity: fading ? 0 : 1 }}
      >
        {STATUS_MESSAGES[msgIdx]}
      </p>

      {/* ── Keyframes ── */}
      <style>{`
        @keyframes ds-ring-breathe {
          0%, 100% { opacity: 0.55; transform: scale(1);    }
          50%       { opacity: 1;    transform: scale(1.05); }
        }
        @keyframes ds-dot-glow {
          0%, 100% { box-shadow: 0 0  8px rgba(197,160,98,0.8), 0 0 16px rgba(197,160,98,0.3); }
          50%       { box-shadow: 0 0 14px rgba(197,160,98,1),   0 0 28px rgba(197,160,98,0.5); }
        }
        @keyframes ds-word-shimmer {
          0%   { background-position: 100% center; }
          100% { background-position: -100% center; }
        }
      `}</style>
    </div>
  );
}
