'use client';

import { motion } from 'motion/react';

const linkGroups: Array<{ title: string; links: Array<{ label: string; href: string }> }> = [
  {
    title: 'Product',
    links: [
      { label: 'Launch Studio', href: '/studio' },
      { label: 'Latest release', href: 'https://github.com/4neverCompany/MashupForge/releases/latest' },
      { label: 'Roadmap', href: 'https://github.com/4neverCompany/MashupForge/issues' },
      { label: 'Brand kit', href: 'https://github.com/4neverCompany/MashupForge/blob/main/BRAND.md' },
    ],
  },
  {
    title: 'Source',
    links: [
      { label: 'Repository', href: 'https://github.com/4neverCompany/MashupForge' },
      { label: 'Contributing', href: 'https://github.com/4neverCompany/MashupForge/blob/main/CONTRIBUTING.md' },
      { label: 'Security', href: 'https://github.com/4neverCompany/MashupForge/blob/main/SECURITY.md' },
      { label: 'License (AGPL-3.0)', href: 'https://github.com/4neverCompany/MashupForge/blob/main/LICENSE' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: '4neverCompany', href: 'https://4nevercompany.com' },
      { label: 'Contact', href: 'mailto:hello@4nevercompany.com' },
      { label: 'Changelog', href: 'https://github.com/4neverCompany/MashupForge/releases' },
      { label: 'Status', href: 'https://github.com/4neverCompany/MashupForge' },
    ],
  },
];

export function Footer() {
  return (
    <footer className="relative overflow-hidden border-t border-white/5 bg-[#050505] pb-12 pt-20 sm:pt-24">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{
          background:
            'linear-gradient(to right, transparent, rgba(197,160,98,0.4), rgba(0,230,255,0.4), transparent)',
        }}
      />
      <div className="mx-auto max-w-7xl px-6">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12 lg:gap-8">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="lg:col-span-5"
          >
            <a href="#top" className="inline-flex items-center gap-2.5">
              <span className="relative inline-flex h-7 w-7 items-center justify-center">
                <span className="absolute inset-0 rounded-md bg-gradient-to-br from-amber-400 via-amber-500 to-emerald-500 opacity-90 blur-[1px]" />
                <span className="absolute inset-[2px] rounded-[5px] bg-[#050505]" />
                <span className="relative font-mono text-[10px] font-bold text-amber-400">M</span>
              </span>
              <span className="font-sans text-base font-bold tracking-tight text-white">
                Mashup<span className="text-amber-400">Forge</span>
              </span>
            </a>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-zinc-400">
              A desktop content studio for AI-driven crossover art. Open
              source, AGPL-3.0, built by{' '}
              <a
                href="https://4nevercompany.com"
                className="text-amber-400 hover:underline"
              >
                4neverCompany
              </a>
              .
            </p>
            <div className="mt-6 flex items-center gap-3">
              <a
                href="https://github.com/4neverCompany/MashupForge"
                target="_blank"
                rel="noopener noreferrer"
                className="group flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.02] text-zinc-400 transition-all hover:border-white/20 hover:bg-white/[0.06] hover:text-white"
                aria-label="GitHub"
              >
                <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                </svg>
              </a>
              <a
                href="https://leonardo.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="group flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.02] text-zinc-400 transition-all hover:border-white/20 hover:bg-white/[0.06] hover:text-white"
                aria-label="Leonardo.ai"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4">
                  <path d="M12 2l9 16H3l9-16z" strokeLinejoin="round" />
                  <path d="M12 9l4 7H8l4-7z" strokeLinejoin="round" />
                </svg>
              </a>
              <a
                href="mailto:hello@4nevercompany.com"
                className="group flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.02] text-zinc-400 transition-all hover:border-white/20 hover:bg-white/[0.06] hover:text-white"
                aria-label="Email"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="M3 7l9 7 9-7" />
                </svg>
              </a>
            </div>
          </motion.div>

          <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 lg:col-span-7">
            {linkGroups.map((g, i) => (
              <motion.div
                key={g.title}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.05 }}
              >
                <h3 className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                  {g.title}
                </h3>
                <ul className="mt-4 space-y-2.5">
                  {g.links.map((l) => (
                    <li key={l.label}>
                      <a
                        href={l.href}
                        target={l.href.startsWith('http') ? '_blank' : undefined}
                        rel={l.href.startsWith('http') ? 'noopener noreferrer' : undefined}
                        className="text-sm text-zinc-300 transition-colors hover:text-amber-400"
                      >
                        {l.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </motion.div>
            ))}
          </div>
        </div>

        <div className="mt-16 flex flex-col items-start justify-between gap-4 border-t border-white/5 pt-8 text-xs text-zinc-500 sm:flex-row sm:items-center">
          <div className="flex flex-wrap items-center gap-3">
            <span>© 2026 4neverCompany.</span>
            <span className="hidden h-3 w-px bg-zinc-700 sm:block" />
            <span>Licensed under AGPL-3.0-or-later.</span>
          </div>
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em]">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]" />
            all systems operational
          </div>
        </div>
      </div>
    </footer>
  );
}

export default Footer;
