'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Loader2, X, CheckCircle2, AlertTriangle, RotateCw, Clock } from 'lucide-react';
import { useDesktopConfig } from '../hooks/useDesktopConfig';
import { isPipelineBusy, subscribePipelineBusy } from '@/lib/pipeline-busy';
import {
  PIPELINE_POSTPONE_POLL_MS,
  computePostponeDeadline,
  shouldFireInstall,
} from '@/lib/update-postpone';
import { traceUpdater } from '@/lib/updater-trace';

// Local minimal shape for the Tauri updater Update object — typed loosely
// because we import the real type dynamically and only touch a few fields.
interface UpdateLike {
  available: boolean;
  version: string;
  body?: string | null;
  downloadAndInstall: (
    onEvent?: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void,
  ) => Promise<void>;
}

type State =
  | { kind: 'idle' }
  // UPDATE-P0-2 (2026-05-21): downloadSize lets the banner show an
  // approximate size in MB so users on metered connections can make an
  // informed decision before clicking. Populated asynchronously after
  // the banner appears via a HEAD request against the platform asset
  // URL extracted from latest.json. null = still fetching / unavailable
  // (banner falls back to omitting the size hint, never shows a guess).
  | { kind: 'available'; update: UpdateLike; downloadSize: number | null }
  | { kind: 'postponed'; update: UpdateLike; deadline: number }
  | { kind: 'downloading'; update: UpdateLike; downloaded: number; total: number | null }
  // UPDATE-P0-4 (2026-05-21): bridge state between downloadAndInstall
  // resolving and the actual relaunch() call. Gives the user 10s to see
  // that a restart is imminent (mirrors VS Code's update flow). The
  // simpler variant per the brief — no cancel, since cancelling an in-
  // flight update is fraught; the user just gets a "Restart now" button
  // to skip the wait if they're ready. Auto-fires relaunch() when
  // secondsLeft hits 0.
  | { kind: 'restart-pending'; update: UpdateLike; secondsLeft: number }
  | { kind: 'download-error'; update: UpdateLike; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'post-update'; version: string };

const DISMISS_KEY = (version: string) => `mashup_update_dismissed_${version}`;
// UPDATE-P0-1 (2026-05-21): cross-version "remind me later" snooze.
// Stores an absolute epoch-ms wakeup time. Any banner attempt before
// the wakeup is silently skipped; the next launch-time check past the
// wakeup re-evaluates normally. Distinct from DISMISS_KEY which is
// per-version permanent — snooze is global and time-bounded.
const SNOOZE_KEY = 'mashup_update_snooze_until';
const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000; // 24h
// UPDATE-P0-4 (2026-05-21): countdown before the post-download
// relaunch. 10s mirrors VS Code's "Restarting to update" overlay —
// long enough to register, short enough to not feel like a hostage
// situation. Shipped as the simpler variant per the brief: no cancel
// button, just a "Restart now" to skip the wait. Cancelling an in-
// flight update is fraught — the install has already completed by
// this point and rolling back isn't trivially safe.
const RESTART_COUNTDOWN_SECONDS = 10;
const LAST_SEEN_KEY = 'mashup_update_last_seen_version';
// FEAT-002: surfaced in the Updates subsection of DesktopSettingsPanel.
export const LAST_CHECKED_AT_KEY = 'mashup_update_last_checked_at';

// FEAT-006: postpone-related constants + decision logic live in
// lib/update-postpone.ts so vitest can exercise them without jsdom.

// V083-UPDATE-UI — byte-size formatter for the download progress row.
// Human-readable, no i18n — matches the updater's existing English-only
// copy. Exported for test access.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function UpdateChecker() {
  const { isDesktop } = useDesktopConfig();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const ranRef = useRef(false);
  // V105.1-REACT-19: Date.now() during render is impure. Use a state-backed
  // "now" updated by an effect so the displayed minutesLeft in the
  // postponed banner is a pure function of (state, now). Tick at 30s —
  // we only render minutes, so 30s granularity is fine and the interval
  // cost is negligible.
  const [now, setNow] = useState<number | null>(null);
  // V105.1-REACT-19: setNow is deferred via queueMicrotask (project
  // convention) so the effect body only manages the 30s tick (external
  // system), not local state in the body itself.
  // V105.6-REACT-19-REVIEW: `active` flag prevents the microtask
  // from running setNow on an unmounted component (e.g. UpdateChecker
  // unmounts when the user navigates away from the studio).
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) setNow(Date.now());
    });
    const id = setInterval(() => {
      if (active) setNow(Date.now());
    }, 30_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);
  // FEAT-006: when the launch-time check resolves an update under 'auto'
  // mode, this ref is flipped so the auto-trigger effect knows to fire
  // handleUpdate as soon as state becomes 'available'.
  const autoInstallRef = useRef(false);

  // Run the check + post-update toast detection once per mount in desktop mode.
  useEffect(() => {
    traceUpdater('mount-effect', { isDesktop });
    if (isDesktop !== true) {
      traceUpdater('exit:not-desktop', { isDesktop });
      return;
    }
    if (ranRef.current) {
      traceUpdater('exit:already-ran');
      return;
    }
    ranRef.current = true;

    let cancelled = false;

    const run = async () => {
      traceUpdater('run:start');
      // Tauri's getVersion is the authoritative source for the running app's
      // version — the npm package is version-agnostic.
      let currentVersion: string | null = null;
      try {
        const appMod = await import('@tauri-apps/api/app');
        currentVersion = await appMod.getVersion();
        traceUpdater('run:got-current-version', { currentVersion });
      } catch (e) {
        // Non-desktop or plugin missing — silently skip.
        traceUpdater('run:getVersion-failed', { error: e instanceof Error ? e.message : String(e) });
      }

      // Post-restart "Updated to vX.Y.Z" toast: compare the running version
      // against the last-seen version from before the previous downloadAndInstall.
      if (currentVersion) {
        try {
          const lastSeen = localStorage.getItem(LAST_SEEN_KEY);
          if (lastSeen && lastSeen !== currentVersion) {
            if (!cancelled) setState({ kind: 'post-update', version: currentVersion });
            // Only reset to idle if the post-update toast is still showing —
            // the updater check below can set 'available' within this 5s
            // window and we must not clobber it.
            window.setTimeout(() => {
              if (cancelled) return;
              setState((prev) => (prev.kind === 'post-update' ? { kind: 'idle' } : prev));
            }, 5000);
          }
          localStorage.setItem(LAST_SEEN_KEY, currentVersion);
        } catch { /* storage quota / private mode — silent */ }
      }

      // FEAT-006: respect granular per-step toggles stored in config.json
      // via /api/desktop/config. Defaults: check=on, download=on, install=off.
      // Falls back to legacy UPDATE_BEHAVIOR for backwards compat.
      let checkOnStartup = true;
      let shouldAutoDownload = true;
      let shouldAutoInstall = false;
      try {
        const cfgRes = await fetch('/api/desktop/config');
        const cfg = (await cfgRes.json()) as { keys?: Record<string, string> };

        const hasGranular = cfg.keys?.AUTO_CHECK_ON_STARTUP !== undefined;
        if (hasGranular) {
          checkOnStartup = cfg.keys!.AUTO_CHECK_ON_STARTUP !== '0';
          shouldAutoDownload = cfg.keys!.AUTO_DOWNLOAD !== '0';
          shouldAutoInstall = cfg.keys!.AUTO_INSTALL === '1';
        } else {
          const raw = cfg.keys?.UPDATE_BEHAVIOR;
          if (raw === 'off') checkOnStartup = false;
          else if (raw === 'auto') { shouldAutoDownload = true; shouldAutoInstall = true; }
        }
        traceUpdater('run:resolved-config', {
          checkOnStartup, shouldAutoDownload, shouldAutoInstall, hasGranular,
        });
      } catch (e) {
        traceUpdater('run:config-fetch-failed', {
          error: e instanceof Error ? e.message : String(e),
        });
      }

      if (!checkOnStartup) {
        traceUpdater('exit:auto-check-disabled');
        return;
      }

      // V060-003: stamp the attempt timestamp BEFORE calling check() so
      // the Settings panel's "Last checked: <when>" reflects reality
      // even when the underlying check throws (BUG-ACL-005). Previously
      // the setItem fired only after a successful check, leaving the
      // panel stuck on "Last checked: never" on systems hitting the ACL
      // bug — which read as "the launch-time check is broken" when it
      // was just being silently swallowed.
      try { localStorage.setItem(LAST_CHECKED_AT_KEY, String(Date.now())); } catch { /* ignore */ }

      try {
        traceUpdater('run:importing-updater-plugin');
        const updaterMod = await import('@tauri-apps/plugin-updater');
        traceUpdater('run:calling-check');
        const update = (await updaterMod.check()) as unknown as UpdateLike | null;
        traceUpdater('run:check-returned', {
          available: update?.available ?? null,
          remoteVersion: update?.version ?? null,
          currentVersion,
        });
        if (!update?.available || cancelled) {
          traceUpdater('exit:no-update-or-cancelled', {
            available: update?.available ?? null,
            cancelled,
          });
          return;
        }

        // Skip if the user already dismissed this exact version.
        try {
          if (localStorage.getItem(DISMISS_KEY(update.version)) === '1') {
            traceUpdater('exit:version-dismissed', { version: update.version });
            return;
          }
        } catch { /* ignore */ }

        // UPDATE-P0-1 (2026-05-21): respect the 24h global snooze. Cleared
        // automatically on expiry — no need to delete the key — so the
        // banner reappears on the first launch-time check after wakeup.
        try {
          const snoozeRaw = localStorage.getItem(SNOOZE_KEY);
          if (snoozeRaw) {
            const snoozeUntil = Number.parseInt(snoozeRaw, 10);
            if (Number.isFinite(snoozeUntil) && Date.now() < snoozeUntil) {
              traceUpdater('exit:snoozed', { snoozeUntil, version: update.version });
              return;
            }
          }
        } catch { /* ignore */ }

        traceUpdater('run:setting-available-state', {
          version: update.version, shouldAutoDownload, shouldAutoInstall,
        });
        setState({ kind: 'available', update, downloadSize: null });
        if (shouldAutoDownload && shouldAutoInstall) {
          autoInstallRef.current = true;
        }

        // UPDATE-P0-2 (2026-05-21): fire a background HEAD against the
        // platform asset URL from latest.json to populate the banner's
        // size hint. Fully optional — every failure path silently leaves
        // downloadSize=null so the banner just omits the size string.
        // Done AFTER setState so the banner appears immediately and the
        // size fills in if/when the HEAD resolves.
        void (async () => {
          try {
            const latestRes = await fetch(
              'https://github.com/4neverCompany/MashupForge/releases/latest/download/latest.json',
              { cache: 'no-cache' },
            );
            if (!latestRes.ok) return;
            const manifest = (await latestRes.json()) as {
              platforms?: Record<string, { url?: string }>;
            };
            const platforms = manifest?.platforms ?? {};
            // Tauri convention: keys like `windows-x86_64`, `darwin-aarch64`.
            // The desktop is currently Windows-only in production (NSIS).
            // Future macOS/Linux builds will land their own keys; fall
            // through to "first available" so the size hint still works
            // before this code learns about new platforms.
            const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
            const preferredKey =
              Object.keys(platforms).find((k) =>
                ua.includes('Windows')
                  ? k.toLowerCase().startsWith('windows')
                  : ua.includes('Mac')
                    ? k.toLowerCase().startsWith('darwin')
                    : k.toLowerCase().startsWith('linux'),
              ) ?? Object.keys(platforms)[0];
            const assetUrl = preferredKey ? platforms[preferredKey]?.url : undefined;
            if (!assetUrl) return;
            const headRes = await fetch(assetUrl, { method: 'HEAD' });
            if (!headRes.ok) return;
            const lenStr = headRes.headers.get('content-length');
            if (!lenStr) return;
            const len = Number.parseInt(lenStr, 10);
            // GitHub's CDN occasionally returns 0 on HEAD even when the
            // asset is fine. Treat 0 (or anything non-positive / NaN) as
            // unavailable so the banner doesn't lie about a 0 MB update.
            if (!Number.isFinite(len) || len <= 0) return;
            traceUpdater('run:resolved-download-size', { bytes: len, key: preferredKey });
            if (cancelled) return;
            setState((prev) =>
              prev.kind === 'available' && prev.update.version === update.version
                ? { ...prev, downloadSize: len }
                : prev,
            );
          } catch (e) {
            // Network blip / parse failure — fall through, banner stays
            // sizeless. Don't surface to the user; the size hint is
            // purely informational.
            traceUpdater('run:download-size-failed', {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        })();
      } catch (e: unknown) {
        // Plugin unavailable, network failure, manifest missing, or ACL
        // denied — none are actionable from the banner, so we log loudly
        // and swallow. The Settings panel's manual Check Now button is
        // the recovery path.
        //
        // BUG-ACL-005: tauri-plugin-updater v2.10.1 sporadically raises
        // "plugin:updater|check not allowed by ACL" on Windows even when
        // updater:allow-check is explicitly granted (also implied by
        // updater:default). Suspected plugin-side bug. We log with a
        // distinct prefix so it's searchable in the console.
        const detail = e instanceof Error ? e.message : String(e);
        traceUpdater('exit:check-threw', { error: detail });
        if (/not allowed by ACL/i.test(detail)) {
          console.warn(
            '[UpdateChecker] updater ACL denied check() — capability is granted in source; likely tauri-plugin-updater v2.10.1 bug. Manual check in Settings still works.',
            detail,
          );
        } else {
          console.warn('[UpdateChecker] update check failed:', detail);
        }
        if (!cancelled) setState({ kind: 'error', message: detail });
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [isDesktop]);

  const performInstall = useCallback(async (update: UpdateLike) => {
    traceUpdater('install:start', { version: update.version });
    setState({ kind: 'downloading', update, downloaded: 0, total: null });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          traceUpdater('install:download-started', { contentLength: event.data?.contentLength ?? null });
          setState((prev) =>
            prev.kind === 'downloading'
              ? { ...prev, total: event.data?.contentLength ?? null }
              : prev,
          );
        } else if (event.event === 'Progress') {
          setState((prev) =>
            prev.kind === 'downloading'
              ? { ...prev, downloaded: prev.downloaded + (event.data?.chunkLength ?? 0) }
              : prev,
          );
        } else {
          traceUpdater('install:event', { event: event.event });
        }
      });
      traceUpdater('install:downloadAndInstall-resolved', { version: update.version });
      // UPDATE-P0-4 (2026-05-21): instead of relaunching immediately,
      // park in `restart-pending` with a 10s countdown so the user has
      // a chance to see what's happening before the app vanishes. The
      // dedicated countdown effect below fires relaunch() when the
      // timer hits 0 (or when the user clicks "Restart now").
      setState({ kind: 'restart-pending', update, secondsLeft: RESTART_COUNTDOWN_SECONDS });
    } catch (e: unknown) {
      const detail = e instanceof Error ? e.message : String(e);
      traceUpdater('install:failed', { error: detail });
      setState({ kind: 'download-error', update, message: detail });
    }
  }, []);

  // UPDATE-P0-4 (2026-05-21): the actual relaunch call, callable from
  // BOTH the countdown effect (when secondsLeft hits 0) AND the
  // "Restart now" button. BUG-002 context: NSIS only RELAUNCHES via
  // `/R`, it does NOT kill the parent. Without an explicit exit the
  // old instance keeps holding sidecar port 19782 (DESKTOP_PORT in
  // src-tauri/src/lib.rs) and the new instance installed by NSIS falls
  // back to an ephemeral port — which breaks the IndexedDB origin pin
  // (STORY-121) and orphans settings. `relaunch()` from
  // tauri-plugin-process triggers a clean exit, fires
  // WindowEvent::CloseRequested in lib.rs, the sidecar Child is
  // killed, port 19782 frees, and Tauri spawns the freshly installed
  // binary.
  const triggerRelaunch = useCallback(async () => {
    try {
      const processMod = await import('@tauri-apps/plugin-process');
      traceUpdater('install:calling-relaunch');
      await processMod.relaunch();
    } catch (e: unknown) {
      const detail = e instanceof Error ? e.message : String(e);
      traceUpdater('install:relaunch-failed', { error: detail });
      // If relaunch itself fails (unlikely once we reach this point) we
      // can't really recover here — the update is already installed.
      // Surface an error so the user knows to restart manually.
      setState({ kind: 'error', message: `Restart failed: ${detail}. Please restart MashupForge manually.` });
    }
  }, []);

  // UPDATE-P0-4 (2026-05-21): countdown effect — ticks once per second
  // while in `restart-pending` and fires relaunch() the instant it
  // reaches 0. Cleanup on unmount / state change prevents a stale timer
  // from firing after the user clicks "Restart now".
  // V105.1-REACT-19: triggerRelaunch and setState are deferred via
  // queueMicrotask (project convention) so the effect body only
  // manages the countdown timer (external system), not local state
  // in the body itself.
  // V105.6-REACT-19-REVIEW: `active` flag prevents the timer
  // callback from running setState / triggerRelaunch after the
  // effect has been cleaned up (e.g. the user clicks "Restart now"
  // while the 1-second tick is in flight, cancelling the countdown).
  useEffect(() => {
    if (state.kind !== 'restart-pending') return;
    let active = true;
    let handle: ReturnType<typeof setTimeout> | undefined;
    queueMicrotask(() => {
      if (!active) return;
      if (state.secondsLeft <= 0) {
        void triggerRelaunch();
        return;
      }
      handle = setTimeout(() => {
        if (!active) return;
        setState((prev) =>
          prev.kind === 'restart-pending'
            ? { ...prev, secondsLeft: Math.max(0, prev.secondsLeft - 1) }
            : prev,
        );
      }, 1000);
    });
    return () => {
      active = false;
      if (handle !== undefined) clearTimeout(handle);
    };
  }, [state, triggerRelaunch]);

  const handleUpdate = useCallback(async () => {
    if (state.kind !== 'available') return;
    const update = state.update;
    // FEAT-006: never interrupt a running pipeline. If a run is in flight
    // we postpone the install — the postponement effect below polls every
    // minute and fires performInstall() the moment the pipeline goes
    // idle, OR when the 120-min cap is reached (whichever comes first).
    if (isPipelineBusy()) {
      setState({
        kind: 'postponed',
        update,
        deadline: computePostponeDeadline(Date.now()),
      });
      return;
    }
    await performInstall(update);
  }, [state, performInstall]);

  // FEAT-006: postponement watchdog. While in 'postponed' state, fire
  // performInstall as soon as the pipeline becomes idle OR the 120-min
  // deadline elapses. We subscribe to the busy pub/sub for the
  // edge-trigger AND set up an interval as a defensive backstop.
  useEffect(() => {
    if (state.kind !== 'postponed') return;
    const update = state.update;
    const deadline = state.deadline;

    let fired = false;
    const tryInstall = () => {
      if (fired) return;
      if (shouldFireInstall(Date.now(), deadline, isPipelineBusy())) {
        fired = true;
        void performInstall(update);
      }
    };

    const unsub = subscribePipelineBusy((busy) => {
      if (!busy) tryInstall();
    });
    const interval = window.setInterval(tryInstall, PIPELINE_POSTPONE_POLL_MS);
    // Also try immediately in case the pipeline finished between
    // handleUpdate's check and this effect mounting.
    tryInstall();

    return () => {
      unsub();
      window.clearInterval(interval);
    };
  }, [state, performInstall]);

  // FEAT-006: auto-mode trigger. When the launch-time check sets state
  // to 'available' under 'auto' behavior, fire handleUpdate without
  // waiting for a user click. handleUpdate itself respects the
  // pipeline-busy gate, so this is safe even mid-run.
  useEffect(() => {
    if (state.kind !== 'available') return;
    if (!autoInstallRef.current) return;
    autoInstallRef.current = false;
    void handleUpdate();
  }, [state, handleUpdate]);

  const handleRetry = useCallback(() => {
    if (state.kind !== 'download-error') return;
    setState({ kind: 'available', update: state.update, downloadSize: null });
  }, [state]);

  const handleDismissError = useCallback(() => {
    setState({ kind: 'idle' });
  }, []);

  // UPDATE-P0-1 (2026-05-21): "Skip this version" — per-version permanent
  // dismissal. Identical to the prior single "Later" behaviour; renamed
  // to make the irreversibility-within-this-version explicit. A new
  // version released later will trigger a fresh banner.
  const handleSkipVersion = useCallback(() => {
    if (state.kind !== 'available') return;
    try {
      localStorage.setItem(DISMISS_KEY(state.update.version), '1');
    } catch { /* ignore */ }
    setState({ kind: 'idle' });
  }, [state]);

  // UPDATE-P0-1 (2026-05-21): "Remind me tomorrow" — global 24h snooze.
  // Re-evaluated by the launch-time `run()` effect on every mount; the
  // banner returns automatically after the wakeup elapses.
  const handleRemindTomorrow = useCallback(() => {
    if (state.kind !== 'available') return;
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_DURATION_MS));
    } catch { /* ignore */ }
    setState({ kind: 'idle' });
  }, [state]);

  if (state.kind === 'idle' || state.kind === 'error') return null;

  // UPDATE-P0-4 (2026-05-21): full-screen restart-pending overlay. Sits
  // on top of everything (z-[200] vs the corner banners at z-[100]) so
  // the user can't miss that the app is about to restart. Single
  // "Restart now" button — no cancel, per the simpler-variant brief.
  if (state.kind === 'restart-pending') {
    return (
      <div
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-restart-heading"
      >
        <div className="max-w-md w-[calc(100%-2rem)] rounded-2xl border border-[#c5a062]/40 bg-[#050505]/95 shadow-2xl p-6 space-y-4">
          <div className="flex items-center gap-3">
            <RotateCw className="w-5 h-5 text-[#c5a062]" />
            <h2 id="update-restart-heading" className="text-sm font-semibold text-white">
              Restarting in {state.secondsLeft} {state.secondsLeft === 1 ? 'second' : 'seconds'}
            </h2>
          </div>
          <p className="text-xs text-zinc-400 leading-relaxed">
            MashupForge is restarting to apply update{' '}
            <span className="font-mono text-[#c5a062]">v{state.update.version}</span>. Any
            in-flight pipeline work has finished — you can wait or restart now.
          </p>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => void triggerRelaunch()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-semibold bg-[#00e6ff] hover:bg-[#33eaff] active:bg-[#00b8cc] text-[#050505] transition-colors"
              aria-label="Restart MashupForge now"
            >
              <RotateCw className="w-3 h-3" />
              Restart now
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (state.kind === 'download-error') {
    return (
      <div className="fixed bottom-4 right-4 z-[100] max-w-sm w-[calc(100%-2rem)] sm:w-96">
        <div className="rounded-xl border border-red-500/40 bg-[#050505]/95 backdrop-blur-md shadow-2xl p-4 space-y-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-white">
                Update failed — <span className="text-red-300 font-mono">v{state.update.version}</span>
              </p>
              <p className="text-[10px] text-zinc-400 mt-1 font-mono line-clamp-3 break-words">
                {state.message}
              </p>
            </div>
            <button
              type="button"
              onClick={handleDismissError}
              aria-label="Dismiss update error"
              className="text-zinc-500 hover:text-zinc-300 transition-colors -mt-0.5 -mr-0.5"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRetry}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-semibold bg-[#c5a062] hover:bg-[#d4b478] active:bg-[#a68748] text-[#050505] transition-colors"
              aria-label="Retry update"
            >
              <RotateCw className="w-3 h-3" />
              Retry
            </button>
            <button
              type="button"
              onClick={handleDismissError}
              className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors px-2 py-1.5"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (state.kind === 'post-update') {
    return (
      <div className="fixed bottom-4 right-4 z-[100] max-w-sm">
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-[#050505]/95 backdrop-blur-md px-4 py-3 shadow-xl">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span className="text-xs text-zinc-200">
            Updated to <span className="font-mono text-emerald-300">v{state.version}</span>
          </span>
        </div>
      </div>
    );
  }

  // FEAT-006: postponed banner — non-dismissable, lets the user know the
  // update will install as soon as the pipeline finishes (or in 2h).
  if (state.kind === 'postponed') {
    const minutesLeft = now === null ? 0 : Math.max(0, Math.round((state.deadline - now) / 60000));
    return (
      <div className="fixed bottom-4 right-4 z-[100] max-w-sm w-[calc(100%-2rem)] sm:w-96">
        <div className="rounded-xl border border-[#c5a062]/30 bg-[#050505]/95 backdrop-blur-md shadow-xl p-4">
          <div className="flex items-start gap-2">
            <Clock className="w-4 h-4 text-[#c5a062] mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-white">
                Update <span className="font-mono text-[#c5a062]">v{state.update.version}</span> waiting
              </p>
              <p className="text-[11px] text-zinc-400 mt-1">
                Pipeline is running. Install will start as soon as the current run finishes
                {minutesLeft > 0 ? ` or in ${minutesLeft} min` : ' (or now — deadline reached)'}.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const update = state.update;
  const body = (update.body ?? '').trim();
  const isDownloading = state.kind === 'downloading';
  const progress =
    isDownloading && state.total ? Math.min(100, Math.round((state.downloaded / state.total) * 100)) : null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] max-w-sm w-[calc(100%-2rem)] sm:w-96">
      <div className="rounded-xl border border-[#c5a062]/40 bg-[#050505]/95 backdrop-blur-md shadow-2xl p-4 space-y-3">
        <div className="flex items-start gap-2">
          <Download className="w-4 h-4 text-[#c5a062] mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-white">
              Update available — <span className="text-[#c5a062] font-mono">v{update.version}</span>
              {/* UPDATE-P0-2 (2026-05-21): size hint rendered only when
                  the background HEAD resolved a positive content-length.
                  Silent omission on any failure path (CDN returns 0,
                  HEAD fails, network blip). Uses ~ prefix to signal the
                  ballpark nature — the actual download may differ if
                  GitHub recompresses between HEAD and GET. */}
              {state.kind === 'available' && state.downloadSize !== null && (
                <span className="text-zinc-500 font-mono"> · ~{formatBytes(state.downloadSize)}</span>
              )}
            </p>
          </div>
          {!isDownloading && (
            <button
              type="button"
              onClick={handleSkipVersion}
              aria-label="Skip this version"
              className="text-zinc-500 hover:text-zinc-300 transition-colors -mt-0.5 -mr-0.5"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {body && !isDownloading && (
          <p className="text-[10px] text-zinc-400 leading-relaxed line-clamp-3 whitespace-pre-wrap font-mono">
            {body}
          </p>
        )}

        {/* V083-UPDATE-UI: visual progress bar during download. Renders
            an indeterminate pulse when content-length is unknown so the
            user still has visible proof the download is running. */}
        {isDownloading && (
          <div className="space-y-1.5" role="status" aria-live="polite">
            <div className="flex items-center justify-between text-[10px] text-zinc-400 font-mono">
              <span>{progress !== null ? `Downloading ${progress}%` : 'Downloading…'}</span>
              {state.total && (
                <span>
                  {formatBytes(state.downloaded)} / {formatBytes(state.total)}
                </span>
              )}
            </div>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress ?? undefined}
              aria-label="Update download progress"
              className="relative h-1.5 w-full overflow-hidden rounded-full bg-zinc-800/80"
            >
              {progress !== null ? (
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#c5a062] to-[#00e6ff] transition-[width] duration-200 ease-out"
                  style={{ width: `${progress}%` }}
                />
              ) : (
                <div className="absolute inset-0 rounded-full bg-gradient-to-r from-[#c5a062]/60 via-[#00e6ff]/80 to-[#c5a062]/60 animate-pulse" />
              )}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleUpdate}
            disabled={isDownloading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-semibold bg-[#00e6ff] hover:bg-[#33eaff] active:bg-[#00b8cc] disabled:opacity-60 disabled:cursor-wait text-[#050505] transition-colors"
            aria-label="Download and install update now"
          >
            {isDownloading ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                {progress !== null ? `Downloading ${progress}%` : 'Downloading…'}
              </>
            ) : (
              <>
                <Download className="w-3 h-3" />
                Update Now
              </>
            )}
          </button>
          {!isDownloading && (
            <button
              type="button"
              onClick={handleRemindTomorrow}
              className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors px-2 py-1.5"
            >
              Remind me tomorrow
            </button>
          )}
        </div>
        {!isDownloading && (
          <div className="pt-1 -mt-1">
            <button
              type="button"
              onClick={handleSkipVersion}
              className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors underline-offset-2 hover:underline"
            >
              Skip this version
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
