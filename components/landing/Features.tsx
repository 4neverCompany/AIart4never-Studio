'use client';

import { motion } from 'motion/react';
import Image from 'next/image';
import { ReactNode } from 'react';

interface Feature {
  title: string;
  description: string;
  icon: ReactNode;
  /** Tailwind gradient pair for the icon container */
  tone: 'amber' | 'emerald' | 'fuchsia' | 'cyan';
  className?: string;
}

const features: Feature[] = [
  {
    title: 'Atomic post lifecycle',
    description:
      'Every post flows through a state machine that writes the post record and the hosted image URL in a single transaction. No more orphaned drafts — the v0.9.41 bug is structurally impossible.',
    icon: <AtomIcon />,
    tone: 'amber',
    className: 'md:col-span-2',
  },
  {
    title: 'Smart scheduler',
    description:
      "Posts land in your audience's peak-engagement windows. No manual calendar math.",
    icon: <ClockIcon />,
    tone: 'emerald',
  },
  {
    title: 'Caption co-pilot',
    description:
      'Tone, length, and hashtag density per platform. The MiniMax-M2.7 chain rewrites itself per post.',
    icon: <SparkleIcon />,
    tone: 'fuchsia',
  },
  {
    title: 'Reconciler on launch',
    description:
      'If anything looks off at startup, a single panel offers a one-click path to recover — no detective work.',
    icon: <ShieldIcon />,
    tone: 'cyan',
    className: 'md:col-span-2',
  },
  {
    title: 'Approval queue',
    description:
      'Carousel-aware cards, inline caption edits, undo for the 3am brain. Hit approve, ship it.',
    icon: <CheckIcon />,
    tone: 'amber',
  },
  {
    title: 'AGPL-3.0 forever',
    description:
      'Every commit public. Every dep pinned. Every post trace persisted. Own the pipeline that owns your channel.',
    icon: <LockIcon />,
    tone: 'emerald',
  },
];

const toneMap = {
  amber: {
    border: 'hover:border-amber-500/30',
    glow: 'from-amber-500/10',
    iconBg: 'from-amber-400/20 to-amber-500/10',
    iconText: 'text-amber-300',
    text: 'text-amber-400',
  },
  emerald: {
    border: 'hover:border-emerald-500/30',
    glow: 'from-emerald-500/10',
    iconBg: 'from-emerald-400/20 to-emerald-500/10',
    iconText: 'text-emerald-300',
    text: 'text-emerald-400',
  },
  fuchsia: {
    border: 'hover:border-fuchsia-500/30',
    glow: 'from-fuchsia-500/10',
    iconBg: 'from-fuchsia-400/20 to-fuchsia-500/10',
    iconText: 'text-fuchsia-300',
    text: 'text-fuchsia-400',
  },
  cyan: {
    border: 'hover:border-cyan-500/30',
    glow: 'from-cyan-500/10',
    iconBg: 'from-cyan-400/20 to-cyan-500/10',
    iconText: 'text-cyan-300',
    text: 'text-cyan-400',
  },
};

export function Features() {
  return (
    <section
      id="features"
      aria-labelledby="features-heading"
      className="relative bg-[#050505] py-24 sm:py-32 lg:py-40"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          backgroundImage:
            'radial-gradient(ellipse 50% 35% at 50% 0%, rgba(197,160,98,0.07), transparent 60%)',
        }}
      />

      <div className="mx-auto max-w-7xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-50px' }}
            transition={{ duration: 0.5 }}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-400"
          >
            <span className="h-1 w-1 rounded-full bg-amber-400" /> the why
          </motion.div>
          <motion.h2
            id="features-heading"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-50px' }}
            transition={{ duration: 0.6, delay: 0.05 }}
            className="mt-5 font-sans text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-6xl"
          >
            A pipeline that <span className="italic text-amber-400">remembers</span>
            <br />
            for you.
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-50px' }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="mt-5 text-base text-zinc-400 sm:text-lg"
          >
            MashupForge is built around one principle: a post that isn&apos;t on the
            feed is a post you lost. Every guardrail below exists to keep your
            content moving.
          </motion.p>
        </div>

        <div className="mt-16 grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-3">
          {features.map((f, i) => (
            <FeatureCard key={f.title} feature={f} index={i} />
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureCard({ feature, index }: { feature: Feature; index: number }) {
  const tone = toneMap[feature.tone];
  return (
    <motion.article
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-50px' }}
      transition={{ duration: 0.5, delay: index * 0.06, ease: 'easeOut' }}
      className={
        'group relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.03] to-white/[0.005] p-6 backdrop-blur-sm transition-all duration-300 hover:bg-white/[0.04] sm:p-8 ' +
        tone.border +
        ' ' +
        (feature.className ?? '')
      }
    >
      <div
        aria-hidden="true"
        className={
          'pointer-events-none absolute -inset-px -z-10 rounded-2xl bg-gradient-to-br to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100 ' +
          tone.glow
        }
      />
      <div
        className={
          'mb-5 inline-flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-gradient-to-br backdrop-blur sm:h-12 sm:w-12 ' +
          tone.iconBg
        }
      >
        <span className={tone.iconText}>{feature.icon}</span>
      </div>
      <h3 className="font-sans text-lg font-bold text-white sm:text-xl">
        {feature.title}
      </h3>
      <p className="mt-2.5 text-sm leading-relaxed text-zinc-400 sm:text-base">
        {feature.description}
      </p>
      {feature.className?.includes('col-span-2') && <FeatureImage tone={feature.tone} />}
    </motion.article>
  );
}

function FeatureImage({ tone }: { tone: Feature['tone'] }) {
  const ring =
    tone === 'amber'
      ? 'ring-amber-500/20'
      : tone === 'emerald'
      ? 'ring-emerald-500/20'
      : tone === 'fuchsia'
      ? 'ring-fuchsia-500/20'
      : 'ring-cyan-500/20';
  return (
    <div className="relative mt-6 aspect-[16/8] w-full overflow-hidden rounded-xl border border-white/5 ring-1 ring-inset">
      <Image
        src="/landing/hero-collage.webp"
        alt="Generated crossover art"
        fill
        sizes="(max-width: 768px) 100vw, 50vw"
        className="object-cover opacity-80 transition-opacity duration-500 group-hover:opacity-100"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-tr from-black/40 via-transparent to-transparent"
      />
      <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/80">
          pipeline output · sample
        </span>
        <span className={'h-2 w-2 rounded-full ' + ring.replace('ring-', 'bg-').replace('/20', '')} />
      </div>
    </div>
  );
}

function AtomIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-5 w-5">
      <circle cx="12" cy="12" r="2" fill="currentColor" />
      <ellipse cx="12" cy="12" rx="10" ry="4" />
      <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" strokeLinecap="round" />
    </svg>
  );
}
function SparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-5 w-5">
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
      <path d="M19 17l.7 1.8L21.5 19.5l-1.8.7L19 22l-.7-1.8L16.5 19.5l1.8-.7L19 17z" />
    </svg>
  );
}
function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-5 w-5">
      <path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z" />
      <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <path d="M4 12.5l5 5L20 6.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-5 w-5">
      <rect x="4" y="11" width="16" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
      <circle cx="12" cy="15.5" r="1" fill="currentColor" />
    </svg>
  );
}

export default Features;
