'use client';

import { motion } from 'motion/react';

export function CTA() {
  return (
    <section
      aria-labelledby="cta-heading"
      className="relative overflow-hidden border-t border-white/5 bg-[#050505] py-24 sm:py-32 lg:py-40"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          backgroundImage:
            'radial-gradient(ellipse 60% 50% at 50% 50%, rgba(197,160,98,0.12), transparent 60%), radial-gradient(ellipse 40% 30% at 30% 30%, rgba(0,230,255,0.10), transparent 60%), radial-gradient(ellipse 40% 30% at 70% 70%, rgba(168,85,247,0.10), transparent 60%)',
        }}
      />

      <div className="mx-auto max-w-5xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
          className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-white/[0.06] via-white/[0.02] to-white/[0.04] p-8 backdrop-blur sm:p-12 lg:p-16"
        >
          {/* Subtle grid background */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 opacity-[0.05]"
            style={{
              backgroundImage:
                'linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)',
              backgroundSize: '48px 48px',
              maskImage:
                'radial-gradient(ellipse 70% 60% at center, black 0%, transparent 70%)',
            }}
          />

          {/* Glow accents */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full bg-amber-500/15 blur-[100px]"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-20 -left-20 h-72 w-72 rounded-full bg-emerald-500/15 blur-[100px]"
          />

          <div className="relative text-center">
            <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-amber-300">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
              </span>
              v1.0.8 ships with the OAuth deep-link fix
            </div>

            <h2
              id="cta-heading"
              className="mt-6 font-sans text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-6xl"
            >
              Your next post
              <br />
              is one keystroke away.
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-base text-zinc-400 sm:text-lg">
              Open the studio in your browser or download the desktop build.
              Your ideas, your captions, your channel — the pipeline just keeps
              it moving.
            </p>

            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
              <a
                href="/studio"
                className="group relative inline-flex items-center gap-2 overflow-hidden rounded-2xl bg-white px-7 py-3.5 text-sm font-bold text-black shadow-[0_0_48px_rgba(255,255,255,0.18)] transition-all duration-200 hover:scale-[1.02] hover:shadow-[0_0_64px_rgba(197,160,98,0.35)]"
              >
                <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-amber-300 to-amber-500 transition-transform duration-500 group-hover:translate-x-0" />
                <span className="relative">Launch Studio</span>
                <span className="relative transition-transform group-hover:translate-x-1" aria-hidden="true">
                  →
                </span>
              </a>
              <a
                href="https://github.com/4neverCompany/MashupForge/releases/latest"
                target="_blank"
                rel="noopener noreferrer"
                className="group inline-flex items-center gap-2 rounded-2xl border border-white/20 bg-white/[0.04] px-6 py-3.5 text-sm font-semibold text-white backdrop-blur transition-all duration-200 hover:border-white/40 hover:bg-white/[0.08]"
              >
                <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                </svg>
                Download for desktop
              </a>
            </div>

            <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">
              Windows · macOS · Linux · AGPL-3.0 · auto-updating
            </p>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

export default CTA;
