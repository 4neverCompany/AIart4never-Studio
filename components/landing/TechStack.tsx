'use client';

import { motion } from 'motion/react';

interface Tech {
  name: string;
  role: string;
  blurb: string;
  badge?: string;
}

const stack: Tech[] = [
  { name: 'Tauri 2', role: 'desktop shell', blurb: 'Native WebView, sub-100MB binary, signed auto-update.', badge: 'rust' },
  { name: 'Next.js 16', role: 'studio UI', blurb: 'Server components, Turbopack, 300KB first-load budget.' },
  { name: 'Leonardo.ai', role: 'image gen', blurb: 'Phoenix + custom model presets, watermarking built-in.' },
  { name: 'MiniMax + OpenAI', role: 'text chain', blurb: 'vercel-ai SDK, 2-LLM fallback chain, no vendor lock-in.' },
  { name: 'SQLite + IDB', role: 'persistence', blurb: 'Real ACID on desktop, web parity on the way.' },
  { name: 'AGPL-3.0', role: 'license', blurb: 'Every line public. Every dep pinned. Forever.', badge: 'copyleft' },
];

export function TechStack() {
  return (
    <section
      id="stack"
      aria-labelledby="stack-heading"
      className="relative overflow-hidden border-t border-white/5 bg-[#050505] py-24 sm:py-32"
    >
      {/* Orb background */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-40 top-1/2 -z-10 h-[600px] w-[600px] -translate-y-1/2 opacity-40"
        style={{
          backgroundImage: 'url(/landing/orb-bg.webp)',
          backgroundSize: 'contain',
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'center',
          maskImage:
            'radial-gradient(circle at center, black 30%, transparent 70%)',
          WebkitMaskImage:
            'radial-gradient(circle at center, black 30%, transparent 70%)',
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          backgroundImage:
            'radial-gradient(ellipse 50% 35% at 0% 100%, rgba(197,160,98,0.08), transparent 60%)',
        }}
      />

      <div className="mx-auto max-w-7xl px-6">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-5">
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-50px' }}
              transition={{ duration: 0.5 }}
              className="inline-flex items-center gap-2 rounded-full border border-fuchsia-500/30 bg-fuchsia-500/5 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em] text-fuchsia-300"
            >
              <span className="h-1 w-1 rounded-full bg-fuchsia-400" /> the stack
            </motion.div>
            <motion.h2
              id="stack-heading"
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-50px' }}
              transition={{ duration: 0.6, delay: 0.05 }}
              className="mt-5 font-sans text-4xl font-bold tracking-tight text-white sm:text-5xl"
            >
              Boring where it should be.
              <br />
              <span className="italic text-amber-400">Sharp</span> where it matters.
            </motion.h2>
            <motion.p
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-50px' }}
              transition={{ duration: 0.6, delay: 0.1 }}
              className="mt-5 text-base leading-relaxed text-zinc-400 sm:text-lg"
            >
              MashupForge is built on a small set of sharp tools. Every
              dependency is a deliberate trade — no kitchen-sink
              abstractions, no hidden cloud, no telemetry you didn&apos;t approve.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-50px' }}
              transition={{ duration: 0.6, delay: 0.15 }}
              className="mt-8 flex flex-wrap items-center gap-2"
            >
              {[
                { label: 'binary size', value: '~85MB' },
                { label: 'first-load JS', value: '<215KB' },
                { label: 'tests', value: '1,194 ✓' },
                { label: 'release channel', value: 'auto' },
              ].map((m) => (
                <div
                  key={m.label}
                  className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2"
                >
                  <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-zinc-500">
                    {m.label}
                  </div>
                  <div className="mt-0.5 font-sans text-sm font-bold text-white">{m.value}</div>
                </div>
              ))}
            </motion.div>
          </div>

          <div className="lg:col-span-7">
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
              {stack.map((t, i) => (
                <motion.li
                  key={t.name}
                  initial={{ opacity: 0, y: 12 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: '-50px' }}
                  transition={{ duration: 0.5, delay: i * 0.05 }}
                  className="group relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.03] to-white/[0.005] p-5 transition-colors hover:border-white/20 sm:p-6"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber-400">
                        {t.role}
                      </div>
                      <h3 className="mt-1.5 font-sans text-lg font-bold text-white sm:text-xl">
                        {t.name}
                      </h3>
                    </div>
                    {t.badge && (
                      <span
                        className={
                          'rounded-md border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] ' +
                          (t.badge === 'rust'
                            ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                            : 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-300')
                        }
                      >
                        {t.badge}
                      </span>
                    )}
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-zinc-400">{t.blurb}</p>
                </motion.li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

export default TechStack;
