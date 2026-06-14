'use client';

import { motion } from 'motion/react';
import { useEffect, useState } from 'react';

const links = [
  { href: '#features', label: 'Features' },
  { href: '#pipeline', label: 'Pipeline' },
  { href: '#stack', label: 'Stack' },
  { href: 'https://github.com/4neverCompany/MashupForge', label: 'GitHub', external: true },
];

export function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <motion.header
      initial={{ y: -32, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-4 sm:pt-6"
    >
      <nav
        className={
          'flex w-full max-w-5xl items-center justify-between gap-4 rounded-2xl border px-3 py-2.5 backdrop-blur-xl transition-all duration-300 sm:px-5 ' +
          (scrolled
            ? 'border-white/10 bg-black/60 shadow-[0_8px_32px_rgba(0,0,0,0.4)]'
            : 'border-white/5 bg-black/30')
        }
      >
        <a href="#top" className="group flex items-center gap-2.5">
          <span className="relative inline-flex h-7 w-7 items-center justify-center">
            <span className="absolute inset-0 rounded-md bg-gradient-to-br from-amber-400 via-amber-500 to-emerald-500 opacity-90 blur-[1px]" />
            <span className="absolute inset-[2px] rounded-[5px] bg-[#050505]" />
            <span className="relative font-mono text-[10px] font-bold text-amber-400">M</span>
          </span>
          <span className="font-sans text-sm font-bold tracking-tight text-white">
            Mashup<span className="text-amber-400">Forge</span>
          </span>
        </a>

        <div className="hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              target={l.external ? '_blank' : undefined}
              rel={l.external ? 'noopener noreferrer' : undefined}
              className="rounded-lg px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-zinc-400 transition-colors hover:bg-white/5 hover:text-white"
            >
              {l.label}
            </a>
          ))}
        </div>

        <a
          href="/studio"
          className="group inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 font-sans text-xs font-bold text-black transition-all hover:bg-amber-400 hover:shadow-[0_0_24px_rgba(197,160,98,0.4)] sm:text-sm"
        >
          Open Studio
          <span className="transition-transform group-hover:translate-x-0.5" aria-hidden="true">→</span>
        </a>
      </nav>
    </motion.header>
  );
}

export default Nav;
