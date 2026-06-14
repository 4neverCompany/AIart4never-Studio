'use client';

import { useEffect, useState } from 'react';
import { Sparkles, X, Settings as SettingsIcon } from 'lucide-react';

const SEEN_KEY = 'mashup_welcome_seen';
const AUTO_DISMISS_MS = 10_000;

export function FirstRunBanner() {
  const [visible, setVisible] = useState(false);

  // V105.1-REACT-19: setVisible is deferred via queueMicrotask (project
  // convention) so the effect body only reads localStorage + sets a
  // timeout (external system), not local state.
  // V105.6-REACT-19-REVIEW: the microtask body and the timer callback
  // both read the cleanup-active flag, so if React cleans up the effect
  // before the microtask runs (or before the AUTO_DISMISS timeout
  // fires), we skip the setState + skip the timer (no "setState on
  // unmounted" warning, no leaked timer).
  useEffect(() => {
    let active = true;
    let dismissTimer: number | undefined;
    queueMicrotask(() => {
      if (!active) return;
      try {
        if (localStorage.getItem(SEEN_KEY) === '1') return;
        localStorage.setItem(SEEN_KEY, '1');
      } catch {
        return;
      }
      if (!active) return;
      setVisible(true);
      dismissTimer = window.setTimeout(() => {
        if (active) setVisible(false);
      }, AUTO_DISMISS_MS);
    });
    return () => {
      active = false;
      if (dismissTimer !== undefined) window.clearTimeout(dismissTimer);
    };
  }, []);

  if (!visible) return null;

  const openSettings = () => {
    window.dispatchEvent(new CustomEvent('mashup:open-settings'));
    setVisible(false);
  };

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[90] max-w-md w-[calc(100%-2rem)]">
      <div className="flex items-start gap-3 rounded-xl border border-[#c5a062]/40 bg-[#050505]/95 backdrop-blur-md shadow-2xl px-4 py-3">
        <Sparkles className="w-4 h-4 text-[#c5a062] mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs text-zinc-200 leading-relaxed">
            Welcome to <span className="text-[#c5a062] font-semibold">MashupForge</span> — configure your API keys in{' '}
            <button
              type="button"
              onClick={openSettings}
              className="inline-flex items-center gap-1 text-[#c5a062] hover:text-[#d4b478] underline underline-offset-2 font-medium transition-colors"
            >
              <SettingsIcon className="w-3 h-3" />
              Settings
            </button>{' '}
            to get started.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setVisible(false)}
          aria-label="Dismiss welcome message"
          className="text-zinc-500 hover:text-zinc-300 transition-colors -mt-0.5 -mr-0.5"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
