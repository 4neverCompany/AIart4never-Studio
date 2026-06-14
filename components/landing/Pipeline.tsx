'use client';

import { motion } from 'motion/react';
import Image from 'next/image';

const steps = [
  {
    n: '01',
    name: 'idea',
    desc: 'A seed prompt. The pipeline learns your niche, tone, and audience over time.',
    accent: 'amber',
  },
  {
    n: '02',
    name: 'image',
    desc: 'Leonardo.ai generates the art. Watermarked, auto-carousel-sliced, ready to host.',
    accent: 'emerald',
  },
  {
    n: '03',
    name: 'caption',
    desc: 'MiniMax-M2.7 rewrites for Instagram, X, and Pinterest from one prompt.',
    accent: 'fuchsia',
  },
  {
    n: '04',
    name: 'approve',
    desc: 'A single panel shows the post. Inline caption edit, undo, or ship.',
    accent: 'cyan',
  },
  {
    n: '05',
    name: 'scheduled',
    desc: 'SmartScheduler drops it into your audience\'s peak window. State machine commits the record.',
    accent: 'amber',
  },
  {
    n: '06',
    name: 'live',
    desc: 'Outcome tracker records engagement, loops learnings back to the next idea.',
    accent: 'emerald',
  },
];

const accentMap = {
  amber: { ring: 'ring-amber-500/30', text: 'text-amber-300', dot: 'bg-amber-400' },
  emerald: { ring: 'ring-emerald-500/30', text: 'text-emerald-300', dot: 'bg-emerald-400' },
  fuchsia: { ring: 'ring-fuchsia-500/30', text: 'text-fuchsia-300', dot: 'bg-fuchsia-400' },
  cyan: { ring: 'ring-cyan-500/30', text: 'text-cyan-300', dot: 'bg-cyan-400' },
};

export function Pipeline() {
  return (
    <section
      id="pipeline"
      aria-labelledby="pipeline-heading"
      className="relative overflow-hidden border-t border-white/5 bg-gradient-to-b from-[#050505] to-black py-24 sm:py-32 lg:py-40"
    >
      {/* BG image */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 opacity-30"
        style={{
          backgroundImage: 'url(/landing/flow-bg.webp)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          maskImage:
            'radial-gradient(ellipse 60% 50% at 50% 50%, black 30%, transparent 80%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 60% 50% at 50% 50%, black 30%, transparent 80%)',
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          backgroundImage:
            'radial-gradient(ellipse 50% 35% at 80% 20%, rgba(168,85,247,0.08), transparent 60%), radial-gradient(ellipse 50% 35% at 20% 80%, rgba(0,230,255,0.08), transparent 60%)',
        }}
      />

      <div className="mx-auto max-w-7xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-50px' }}
            transition={{ duration: 0.5 }}
            className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/5 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em] text-emerald-300"
          >
            <span className="h-1 w-1 rounded-full bg-emerald-400" /> the pipeline
          </motion.div>
          <motion.h2
            id="pipeline-heading"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-50px' }}
            transition={{ duration: 0.6, delay: 0.05 }}
            className="mt-5 font-sans text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-6xl"
          >
            One spark. Six states.
            <br />
            <span className="bg-gradient-to-r from-emerald-300 via-amber-300 to-fuchsia-300 bg-clip-text text-transparent">
              Zero lost posts.
            </span>
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-50px' }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="mt-5 text-base text-zinc-400 sm:text-lg"
          >
            Each transition is atomic, observable, and reversible. The
            v0.9.41 bug — a post without a hosted image — cannot happen
            here, by construction.
          </motion.p>
        </div>

        {/* Steps */}
        <ol className="relative mt-16 grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-2 lg:grid-cols-3">
          {/* Connecting line on lg+ */}
          <div
            aria-hidden="true"
            className="absolute left-0 right-0 top-12 hidden h-px bg-gradient-to-r from-transparent via-white/15 to-transparent lg:block"
          />
          {steps.map((s, i) => {
            const tone = accentMap[s.accent as keyof typeof accentMap];
            return (
              <motion.li
                key={s.n}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-50px' }}
                transition={{ duration: 0.5, delay: i * 0.07, ease: 'easeOut' }}
                className="group relative"
              >
                <div className="relative h-full overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.03] to-transparent p-6 transition-all duration-300 hover:border-white/20 sm:p-7">
                  <div className="flex items-center gap-3">
                    <span
                      className={
                        'relative inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-black/40 font-mono text-xs font-bold ring-1 ring-inset ' +
                        tone.ring +
                        ' ' +
                        tone.text
                      }
                    >
                      <span
                        className={
                          'absolute inset-0.5 rounded-full opacity-20 ' + tone.dot
                        }
                        aria-hidden="true"
                      />
                      <span className="relative">{s.n}</span>
                    </span>
                    <h3 className="font-sans text-lg font-bold text-white">{s.name}</h3>
                  </div>
                  <p className="mt-4 text-sm leading-relaxed text-zinc-400 sm:text-base">
                    {s.desc}
                  </p>
                  <div className="mt-5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                    <span className={'h-1.5 w-1.5 rounded-full ' + tone.dot} />
                    {s.accent === 'amber' && 'atomic write'}
                    {s.accent === 'emerald' && 'leonardo · fx'}
                    {s.accent === 'fuchsia' && 'vercel-ai · sdk'}
                    {s.accent === 'cyan' && 'human-in-loop'}
                    {s.accent === 'amber' && s.n === '05' && 'state machine'}
                    {s.accent === 'emerald' && s.n === '06' && 'feedback loop'}
                  </div>
                </div>
              </motion.li>
            );
          })}
        </ol>

        {/* State diagram visual */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          transition={{ duration: 0.7, delay: 0.2 }}
          className="relative mx-auto mt-20 max-w-4xl"
        >
          <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black/40 p-6 backdrop-blur sm:p-8">
            <div className="flex items-center justify-between border-b border-white/5 pb-4">
              <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
                post.lifecycle · current state machine
              </div>
              <div className="font-mono text-[10px] text-zinc-600">lib/post-lifecycle/</div>
            </div>
            <pre className="mt-5 overflow-x-auto font-mono text-[11px] leading-relaxed text-zinc-400 sm:text-xs">
{`idle ──▶ image_ready ──▶ pending_caption ──▶ pending_approval
                                                    │
                                          ┌─────────┴─────────┐
                                          ▼                   ▼
                                     approved            rejected
                                          │                   │
                                          ▼                   ▼
                                     scheduled          failed (atomic)
                                          │
                                          ▼
                                       posted`}
            </pre>
            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-white/5 pt-4 text-[10px] font-mono uppercase tracking-[0.16em] text-zinc-500">
              <span className="rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-1 text-amber-300">
                savePostWithBlob() · atomic
              </span>
              <span className="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2 py-1 text-emerald-300">
                applyTransition() · typed
              </span>
              <span className="rounded-md border border-fuchsia-500/20 bg-fuchsia-500/5 px-2 py-1 text-fuchsia-300">
                Reconciler · read-time fix
              </span>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

export default Pipeline;
