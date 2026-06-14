'use client';

import { useState, useEffect, useCallback } from 'react';
import { Power } from 'lucide-react';
import { ToggleRow } from './AutoUpdateSettings';

// FEAT-TRAY-AUTOSTART (2026-05-20): the OS is the source of truth for
// autostart — Windows registry / Linux .desktop / macOS LaunchAgent.
// `@tauri-apps/plugin-autostart` exposes isEnabled / enable / disable
// against that source of truth, so this component does not need a
// matching field in UserSettings.
//
// First-launch behavior: see hooks/useAutostartFirstRun.ts. The toggle
// here only reflects + mutates the current OS state once the user (or
// the first-launch effect) has set it.

export interface AutoStartSettingsProps {
  /** Whether we're running inside the Tauri desktop shell. */
  isDesktop: boolean;
}

export function AutoStartSettings({ isDesktop }: AutoStartSettingsProps) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Read the current OS-level autostart state on mount. Stays null while
  // the read is in flight so the toggle doesn't flicker from default-off
  // to actual-on.
  useEffect(() => {
    if (!isDesktop) return;
    let cancelled = false;
    void (async () => {
      try {
        const mod = await import('@tauri-apps/plugin-autostart');
        const current = await mod.isEnabled();
        if (!cancelled) setEnabled(current);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setEnabled(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [isDesktop]);

  const handleToggle = useCallback(async (next: boolean) => {
    setError(null);
    try {
      const mod = await import('@tauri-apps/plugin-autostart');
      if (next) await mod.enable();
      else await mod.disable();
      setEnabled(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  if (!isDesktop) return null;

  return (
    <div className="space-y-3 pt-4 border-t border-zinc-800/60">
      <div className="flex items-center gap-2">
        <Power className="w-3.5 h-3.5 text-[#c5a062] shrink-0" />
        <h5 className="text-xs font-semibold text-white">Auto-Start</h5>
      </div>

      <div className="rounded-lg border border-zinc-800/60 bg-[#050505]/40 px-3">
        <ToggleRow
          label="Start with Windows"
          description="Launch MashupForge in the background when you sign in. The window minimises to the system tray so the auto-poster can keep firing while you work."
          enabled={enabled ?? false}
          onToggle={handleToggle}
          disabled={enabled === null}
        />
      </div>

      {error && (
        <p className="text-[10px] text-red-400 px-3">Auto-start error: {error}</p>
      )}
    </div>
  );
}
