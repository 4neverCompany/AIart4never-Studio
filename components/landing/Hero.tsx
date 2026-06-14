'use client';

import { motion, useScroll, useTransform } from 'motion/react';
import { useRef } from 'react';
import Image from 'next/image';

export interface HeroProps {
  ctaHref?: string;
  onCtaClick?: () => void;
}

export function Hero({ ctaHref = '/studio', onCtaClick }: HeroProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start start', 'end start'],
  });
  const collageY = useTransform(scrollYProgress, [0, 1], ['0%', '20%']);
  const collageScale = useTransform(scrollYProgress, [0, 1], [1, 1.08]);
  const headlineOpacity = useTransform(scrollYProgress, [0, 0.6], [1, 0]);
  const headlineY = useTransform(scrollYProgress, [0, 0.6], [0, -60]);

  return (
    <section
      ref={ref}
      id="top"
      aria-labelledby="hero-heading"
      className="relative isolate overflow-hidden bg-[#050505] pt-28 sm:pt-32"
    >
      {/* ── Ambient background layers ─────────────────────────────── */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <div
          className="absolute inset-0 opacity-50"
          style={{
            backgroundImage: 'url(/landing/mesh-bg.webp)',
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            maskImage: 'radial-gradient(ellipse 80% 60% at 50% 30%, black 30%, transparent 80%)',
            WebkitMaskImage:
              'radial-gradient(ellipse 80% 60% at 50% 30%, black 30%, transparent 80%)',
          }}
        />
        <div className="absolute left-1/2 top-[20%] h-[640px] w-[640px] -translate-x-1/2 rounded-full bg-emerald-500/10 blur-[160px]" />
        <div className="absolute -left-32 top-[40%] h-[420px] w-[420px] rounded-full bg-amber-500/10 blur-[140px]" />
        <div className="absolute -right-32 top-[10%] h-[380px] w-[380px] rounded-full bg-fuchsia-500/10 blur-[120px]" />
        <div
          className="absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              'linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)',
            backgroundSize: '72px 72px',
            maskImage:
              'linear-gradient(to bottom, black 0%, black 70%, transparent 100%)',
          }}
        />
      </div>

      <div className="mx-auto max-w-7xl px-6 pb-20 sm:pb-28 lg:pb-36">
        {/* ── Headline block ─────────────────────────────────────── */}
        <motion.div
          style={{ opacity: headlineOpacity, y: headlineY }}
          className="mx-auto flex max-w-4xl flex-col items-center text-center"
        >
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
            className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/5 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-amber-400 sm:text-[11px]"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
            </span>
            v1.0.1 is live · AGPL-3.0 · auto-updating
          </motion.div>

          <motion.h1
            id="hero-heading"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.05, ease: 'easeOut' }}
            className="mt-7 font-sans text-[clamp(2.75rem,8vw,6.5rem)] font-bold leading-[0.95] tracking-[-0.04em] text-white"
          >
            Forge art that
            <br />
            <span className="relative inline-block">
              <span className="bg-gradient-to-r from-amber-300 via-amber-500 to-emerald-400 bg-clip-text text-transparent">
                crosses worlds
              </span>
              <svg
                aria-hidden="true"
                viewBox="0 0 300 12"
                className="absolute -bottom-2 left-0 h-3 w-full text-emerald-400/60"
                fill="none"
                preserveAspectRatio="none"
              >
                <motion.path
                  d="M2 8 Q 75 2, 150 6 T 298 4"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 1.4, delay: 0.7, ease: 'easeOut' }}
                />
              </svg>
            </span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2, ease: 'easeOut' }}
            className="mt-7 max-w-2xl text-base leading-relaxed text-zinc-400 sm:text-lg"
          >
            MashupForge is a desktop studio that takes a single creative spark and
            ships it as a fully captioned, scheduled Instagram post — image
            generation, AI captions, approval queue, and a smart scheduler
            wired into one atomic pipeline.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.32, ease: 'easeOut' }}
            className="mt-9 flex flex-col items-center gap-3 sm:flex-row sm:gap-4"
          >
            <a
              href={ctaHref}
              onClick={
                onCtaClick
                  ? (e) => {
                      e.preventDefault();
                      onCtaClick();
                    }
                  : undefined
              }
              className="group relative inline-flex items-center gap-2 overflow-hidden rounded-2xl bg-white px-7 py-3.5 text-sm font-bold text-black shadow-[0_0_48px_rgba(255,255,255,0.18)] transition-all duration-200 hover:scale-[1.02] hover:shadow-[0_0_64px_rgba(197,160,98,0.35)] active:scale-100"
            >
              <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-amber-300 to-amber-500 transition-transform duration-500 group-hover:translate-x-0" />
              <span className="relative transition-colors group-hover:text-black">Launch Studio</span>
              <span className="relative transition-transform group-hover:translate-x-1" aria-hidden="true">→</span>
            </a>

            <a
              href="https://github.com/4neverCompany/MashupForge/releases/latest"
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-center gap-2 rounded-2xl border border-white/15 bg-white/[0.02] px-6 py-3.5 text-sm font-semibold text-white backdrop-blur transition-all duration-200 hover:border-white/30 hover:bg-white/[0.06]"
            >
              <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              Download v1.0.1
            </a>
          </motion.div>

          {/* Trust strip */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.55 }}
            className="mt-12 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[11px] font-mono uppercase tracking-[0.18em] text-zinc-500"
          >
            <span>Tauri 2</span>
            <span className="h-3 w-px bg-zinc-700" />
            <span>Next.js 16</span>
            <span className="h-3 w-px bg-zinc-700" />
            <span>Leonardo.ai</span>
            <span className="h-3 w-px bg-zinc-700" />
            <span>Open Source</span>
            <span className="h-3 w-px bg-zinc-700" />
            <span>Windows · macOS · Linux</span>
          </motion.div>
        </motion.div>

        {/* ── Hero collage ───────────────────────────────────────── */}
        <motion.div
          style={{ y: collageY, scale: collageScale }}
          initial={{ opacity: 0, y: 60 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1.1, delay: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="relative mx-auto mt-16 sm:mt-20"
        >
          {/* Glow frame */}
          <div
            aria-hidden="true"
            className="absolute -inset-4 -z-10 rounded-[2rem] bg-gradient-to-br from-amber-500/20 via-transparent to-emerald-500/20 blur-2xl sm:-inset-8"
          />

          <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-white/[0.04] to-white/[0.01] p-1.5 shadow-[0_24px_80px_rgba(0,0,0,0.6)] backdrop-blur">
            {/* Window chrome */}
            <div className="flex items-center justify-between border-b border-white/5 px-4 py-2.5 sm:px-5">
              <div className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-rose-400/80" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
              </div>
              <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
                mashupforge · pipeline #2847
              </div>
              <div className="font-mono text-[10px] text-zinc-600 hidden sm:block">⌘K</div>
            </div>

            {/* Collage */}
            <div className="relative aspect-[16/9] w-full overflow-hidden rounded-2xl">
              <Image
                src="/landing/hero-collage.webp"
                alt="Generated crossover art from MashupForge — four distinct multiverse panels"
                fill
                priority
                sizes="(max-width: 1280px) 100vw, 1280px"
                className="object-cover"
              />
              {/* Cinematic gradient overlay */}
              <div
                aria-hidden="true"
                className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/20"
              />

              {/* Floating UI overlays */}
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 1.2, duration: 0.5 }}
                className="absolute bottom-4 left-4 right-4 flex flex-wrap items-end justify-between gap-3 sm:bottom-6 sm:left-6 sm:right-6"
              >
                <div className="flex items-center gap-2 rounded-xl border border-white/15 bg-black/60 px-3 py-2 backdrop-blur-md sm:gap-3 sm:px-4 sm:py-2.5">
                  <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-amber-400 to-amber-600 sm:h-8 sm:w-8">
                    <span className="text-xs font-bold text-black">✓</span>
                  </div>
                  <div className="text-left">
                    <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-amber-400 sm:text-[10px]">
                      approved · v0.9.41 fix landed
                    </div>
                    <div className="font-sans text-xs font-semibold text-white sm:text-sm">
                      Atomic post + hosted-URL write
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 rounded-xl border border-white/15 bg-black/60 px-3 py-2 backdrop-blur-md sm:px-4 sm:py-2.5">
                  <div className="flex -space-x-1.5">
                    <span className="h-5 w-5 rounded-full border border-black bg-amber-400 sm:h-6 sm:w-6" />
                    <span className="h-5 w-5 rounded-full border border-black bg-emerald-400 sm:h-6 sm:w-6" />
                    <span className="h-5 w-5 rounded-full border border-black bg-fuchsia-400 sm:h-6 sm:w-6" />
                    <span className="h-5 w-5 rounded-full border border-black bg-cyan-400 sm:h-6 sm:w-6" />
                  </div>
                  <div className="text-left">
                    <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-emerald-400 sm:text-[10px]">
                      scheduled · 12 posts
                    </div>
                    <div className="font-sans text-xs font-semibold text-white sm:text-sm">
                      this week
                    </div>
                  </div>
                </div>
              </motion.div>
            </div>
          </div>

          {/* Floating annotation chips */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 1.4, duration: 0.5 }}
            className="absolute -left-4 top-12 hidden rotate-[-3deg] rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-amber-300 backdrop-blur md:block"
          >
            <span className="text-amber-400">↗</span> idea
          </motion.div>
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 1.55, duration: 0.5 }}
            className="absolute -right-4 top-24 hidden rotate-[3deg] rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-300 backdrop-blur md:block"
          >
            image <span className="text-emerald-400">→</span>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.7, duration: 0.5 }}
            className="absolute -right-2 bottom-12 hidden rotate-[-2deg] rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-fuchsia-300 backdrop-blur md:block"
          >
            <span className="text-fuchsia-400">✓</span> approved
          </motion.div>
        </motion.div>
      </div>

      {/* Bottom fade */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-b from-transparent to-[#050505]"
      />
    </section>
  );
}

export default Hero;
