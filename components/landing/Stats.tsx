'use client';

import { motion, useInView } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

interface Stat {
  label: string;
  value: number;
  suffix?: string;
  prefix?: string;
  hint: string;
}

const stats: Stat[] = [
  { label: 'AI calls per pipeline', value: 1, suffix: '', hint: 'one prompt → one image + caption' },
  { label: 'Failure modes guarded', value: 12, hint: 'state machine rejects broken records' },
  { label: 'Routes wired', value: 14, hint: 'all atomic, all post-lifecycle' },
  { label: 'Open-source license', value: 0, suffix: '-cost', hint: 'AGPL-3.0 · forever' },
];

function Counter({ target, suffix = '', prefix = '' }: { target: number; suffix?: string; prefix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '-50px' });
  const [val, setVal] = useState(0);

  useEffect(() => {
    if (!inView) return;
    const start = performance.now();
    const dur = 1100;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(eased * target));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [inView, target]);

  return (
    <span ref={ref} className="tabular-nums">
      {prefix}
      {val}
      {suffix}
    </span>
  );
}

export function Stats() {
  return (
    <section aria-label="Project metrics" className="relative border-y border-white/5 bg-black/40 py-12 backdrop-blur-sm sm:py-16">
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 opacity-50"
        style={{
          backgroundImage:
            'linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px)',
          backgroundSize: '120px 100%',
        }}
      />
      <div className="mx-auto max-w-7xl px-6">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/5 bg-white/[0.02] lg:grid-cols-4">
          {stats.map((s, i) => (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-50px' }}
              transition={{ duration: 0.5, delay: i * 0.08, ease: 'easeOut' }}
              className="group relative bg-[#050505] p-6 sm:p-8"
            >
              <div
                aria-hidden="true"
                className="absolute inset-0 -z-10 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
                style={{
                  background:
                    'radial-gradient(ellipse at top, rgba(197,160,98,0.08), transparent 60%)',
                }}
              />
              <div className="font-sans text-3xl font-bold tracking-tight text-white sm:text-4xl lg:text-5xl">
                <span className="bg-gradient-to-br from-white to-white/60 bg-clip-text text-transparent">
                  <Counter target={s.value} suffix={s.suffix} prefix={s.prefix} />
                </span>
              </div>
              <div className="mt-3 font-sans text-sm font-semibold text-zinc-300">
                {s.label}
              </div>
              <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                {s.hint}
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

export default Stats;
