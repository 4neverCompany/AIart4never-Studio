'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Download, RefreshCw, Loader2, CheckCircle2, AlertCircle,
  History, Sparkles,
} from 'lucide-react';
import { recentReleases } from '@/lib/release-history';
import { LAST_CHECKED_AT_KEY } from '../UpdateChecker';
import {
  traceUpdater,
  getUpdaterTrace,
  clearUpdaterTrace,
  formatTraceEntry,
} from '@/lib/updater-trace';
import { Switch } from './Switch';

// ── Types ─────────────────────────────────────────────────────────────────────

type CheckResult =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'none' }
  | { kind: 'available'; version: string; body: string }
  | { kind: 'installing'; version: string; pct: number | null }
  | { kind: 'unavailable'; releasesUrl: string }
  | { kind: 'error'; message: string };

interface UpdaterModule {
  check: () => Promise<{
    available: boolean;
    version: string;
    body?: string | null;
    downloadAndInstall: (
      onEvent?: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void,
    ) => Promise<void>;
  } | null>;
}

const RELEASES_URL = 'https://github.com/4neverCompany/MashupForge/releases';

const WIN_MODES = ['passive', 'basicUi', 'quiet'] as const;
type WinInstallMode = typeof WIN_MODES[number];

const WIN_MODE_LABELS: Record<WinInstallMode, string> = {
  passive: 'Passive',
  basicUi: 'Basic UI',
  quiet: 'Quiet',
};
const WIN_MODE_HINTS: Record<WinInstallMode, string> = {
  passive: 'Small progress window, no interaction needed (recommended)',
  basicUi: 'Standard installer dialog — requires user interaction',
  quiet: 'No feedback during install (not recommended)',
};

// ── Sub-components ────────────────────────────────────────────────────────────

export function ToggleRow({
  label,
  description,
  enabled,
  onToggle,
  disabled = false,
}: {
  label: string;
  description: string;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className={`text-xs ${disabled ? 'text-zinc-500' : 'text-zinc-300'}`}>{label}</p>
        <p className="text-[10px] text-zinc-600 leading-snug">{description}</p>
      </div>
      <Switch checked={enabled} onChange={onToggle} label={label} disabled={disabled} size="sm" />
    </div>
  );
}

function UpdateProgressBar({ percent }: { percent: number | null }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      aria-label="Update download progress"
      className="relative h-1.5 w-full overflow-hidden rounded-full bg-zinc-800/80"
    >
      {percent === null ? (
        <div className="absolute inset-0 rounded-full bg-gradient-to-r from-[#c5a062]/60 via-[#00e6ff]/80 to-[#c5a062]/60 animate-pulse" />
      ) : (
        <div
          className="h-full rounded-full bg-gradient-to-r from-[#c5a062] to-[#00e6ff] transition-[width] duration-200 ease-out"
          style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
        />
      )}
    </div>
  );
}

function ReleaseHistoryList({ currentVersion }: { currentVersion: string | null }) {
  const releases = recentReleases(5);
  if (releases.length === 0) return null;
  return (
    <details className="text-[11px] group">
      <summary className="flex items-center gap-1.5 cursor-pointer text-zinc-400 hover:text-zinc-200 select-none">
        <History className="w-3 h-3 text-[#c5a062] shrink-0" />
        Release history
        <span className="text-zinc-600">({releases.length})</span>
      </summary>
      <ol className="mt-2 space-y-3 border-l border-zinc-800/60 pl-3">
        {releases.map((r) => {
          const isCurrent = currentVersion === r.version;
          return (
            <li key={r.version} className="space-y-1">
              <div className="flex items-center gap-2">
                <span className={[
                  'inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] border',
                  isCurrent
                    ? 'bg-[#00e6ff]/10 border-[#00e6ff]/40 text-[#00e6ff]'
                    : 'bg-[#c5a062]/10 border-[#c5a062]/30 text-[#c5a062]',
                ].join(' ')}>
                  {isCurrent && <Sparkles className="w-2.5 h-2.5" aria-hidden />}
                  v{r.version}
                </span>
                <span className="text-[10px] text-zinc-600 font-mono">{r.date}</span>
                {isCurrent && (
                  <span className="text-[9px] uppercase tracking-wider text-[#00e6ff]">installed</span>
                )}
              </div>
              <ul className="list-disc list-outside ml-4 marker:text-zinc-700 text-zinc-400 space-y-0.5">
                {r.highlights.map((h, i) => (
                  <li key={i} className="leading-snug">{h}</li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

function DiagnosticLog() {
  const [open, setOpen] = useState(false);
  const [trace, setTrace] = useState<ReturnType<typeof getUpdaterTrace>>([]);

  const refresh = useCallback(() => setTrace(getUpdaterTrace()), []);
  // V105.1-REACT-19: refresh (setState) deferred via queueMicrotask
  // (project convention) so the effect body only watches `open`.
  useEffect(() => {
    if (open) queueMicrotask(refresh);
  }, [open, refresh]);

  const handleCopy = useCallback(() => {
    try { void navigator.clipboard.writeText(trace.map(formatTraceEntry).join('\n')); } catch { /* best-effort */ }
  }, [trace]);
  const handleClear = useCallback(() => { clearUpdaterTrace(); refresh(); }, [refresh]);

  return (
    <details
      className="text-[10px]"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300 select-none">
        Diagnostic log {trace.length > 0 ? `(${trace.length})` : ''}
      </summary>
      <div className="mt-2 space-y-2">
        <div className="flex items-center gap-2">
          <button type="button" onClick={refresh}
            className="px-2 py-1 rounded text-[10px] bg-zinc-800 hover:bg-zinc-700 text-zinc-200">
            Refresh
          </button>
          <button type="button" onClick={handleCopy} disabled={trace.length === 0}
            className="px-2 py-1 rounded text-[10px] bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200">
            Copy
          </button>
          <button type="button" onClick={handleClear} disabled={trace.length === 0}
            className="px-2 py-1 rounded text-[10px] bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200">
            Clear
          </button>
        </div>
        {trace.length === 0 ? (
          <p className="text-zinc-600">No trace entries yet.</p>
        ) : (
          <pre className="max-h-40 overflow-auto rounded bg-[#050505] border border-zinc-800/60 p-2 font-mono text-zinc-400 whitespace-pre-wrap">
            {trace.map(formatTraceEntry).join('\n')}
          </pre>
        )}
      </div>
    </details>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface AutoUpdateSettingsProps {
  /** Full draft from DesktopSettingsPanel — read auto-update keys from here. */
  draft: Record<string, string>;
  /** Called when a single key changes (mirrors DesktopSettingsPanel's onFieldChange). */
  onFieldChange: (key: string, value: string) => void;
  /** Whether we're running inside the Tauri desktop shell. */
  isDesktop: boolean;
}

export function AutoUpdateSettings({ draft, onFieldChange, isDesktop }: AutoUpdateSettingsProps) {
  const [version, setVersion] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [result, setResult] = useState<CheckResult>({ kind: 'idle' });
  const installRef = useRef<(() => Promise<void>) | null>(null);

  // Derive booleans from draft. Default: check=on, download=on, install=off.
  const autoCheck    = draft['AUTO_CHECK_ON_STARTUP'] !== '0';
  const autoDownload = draft['AUTO_DOWNLOAD']          !== '0';
  const autoInstall  = draft['AUTO_INSTALL']           === '1';
  const winMode: WinInstallMode =
    (WIN_MODES as readonly string[]).includes(draft['WIN_INSTALL_MODE'] ?? '')
      ? (draft['WIN_INSTALL_MODE'] as WinInstallMode)
      : 'passive';

  useEffect(() => {
    void (async () => {
      if (!isDesktop) return;
      try {
        const appMod = await import('@tauri-apps/api/app');
        setVersion(await appMod.getVersion());
      } catch { /* web build */ }
      try {
        const raw = localStorage.getItem(LAST_CHECKED_AT_KEY);
        if (raw) setLastCheckedAt(Number(raw));
      } catch { /* private mode */ }
    })();
  }, [isDesktop]);

  const handleCheckNow = useCallback(async () => {
    traceUpdater('manual:check-clicked');
    setResult({ kind: 'checking' });
    const startedAt = Date.now();
    try { localStorage.setItem(LAST_CHECKED_AT_KEY, String(startedAt)); } catch { /* ignore */ }
    setLastCheckedAt(startedAt);
    try {
      const updaterMod = (await import('@tauri-apps/plugin-updater')) as unknown as UpdaterModule;
      const update = await updaterMod.check();
      traceUpdater('manual:check-returned', { available: update?.available ?? null, version: update?.version ?? null });
      if (!update?.available) { setResult({ kind: 'none' }); return; }
      setResult({ kind: 'available', version: update.version, body: (update.body ?? '').trim() });
      installRef.current = () => update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          setResult({ kind: 'installing', version: update.version, pct: null });
        } else if (event.event === 'Progress') {
          setResult((prev) => {
            if (prev.kind !== 'installing') return prev;
            const total = event.data?.contentLength;
            const chunk = event.data?.chunkLength ?? 0;
            const next = (prev.pct ?? 0) + (total ? (chunk / total) * 100 : 0);
            return { ...prev, pct: total ? Math.min(99, Math.round(next)) : null };
          });
        }
      });
    } catch (e: unknown) {
      const detail = e instanceof Error ? e.message : String(e);
      traceUpdater('manual:check-threw', { error: detail });
      if (/not allowed by ACL/i.test(detail)) {
        setResult({ kind: 'unavailable', releasesUrl: RELEASES_URL });
      } else {
        setResult({ kind: 'error', message: detail });
      }
    }
  }, []);

  const handleInstall = useCallback(async () => {
    if (!installRef.current) return;
    try {
      await installRef.current();
      setResult({ kind: 'none' });
    } catch (e: unknown) {
      setResult({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const busy = result.kind === 'checking' || result.kind === 'installing';
  const lastCheckedLabel = lastCheckedAt ? new Date(lastCheckedAt).toLocaleString() : 'never';

  return (
    <div className="space-y-3 pt-4 border-t border-zinc-800/60">

      {/* Section header */}
      <div className="flex items-center gap-2">
        <Download className="w-3.5 h-3.5 text-[#c5a062] shrink-0" />
        <h5 className="text-xs font-semibold text-white">Auto-Update</h5>
        {version && (
          <span className="ml-auto text-[10px] text-zinc-500 font-mono">v{version}</span>
        )}
      </div>

      {/* Toggle rows */}
      <div className="rounded-lg border border-zinc-800/60 bg-[#050505]/40 divide-y divide-zinc-800/40 px-3">
        <ToggleRow
          label="Auto-check on startup"
          description="Run an update check each time the app launches"
          enabled={autoCheck}
          onToggle={(v) => onFieldChange('AUTO_CHECK_ON_STARTUP', v ? '1' : '0')}
        />
        <ToggleRow
          label="Auto-download"
          description="Download in the background when a new version is found"
          enabled={autoDownload}
          onToggle={(v) => onFieldChange('AUTO_DOWNLOAD', v ? '1' : '0')}
          disabled={!autoCheck}
        />
        <ToggleRow
          label="Auto-install"
          description="Install immediately after download — app will relaunch"
          enabled={autoInstall}
          onToggle={(v) => onFieldChange('AUTO_INSTALL', v ? '1' : '0')}
          disabled={!autoDownload}
        />
      </div>

      {/* UPDATE-P0-3 (2026-05-21): Windows install mode — hidden on
          non-Windows platforms entirely. The NSIS install modes
          (passive/basicUi/quiet) are Windows-specific by construction;
          on macOS / Linux this section telegraphed unfinished work that
          was never coming to those platforms in this shape. Runtime
          selection is still pending an app build wire-up even on
          Windows; the "Coming soon" badge stays for that reason.
          Detection via navigator.userAgent matches the rest of the
          codebase (e.g. P0-1 / P0-3 brief recommendation); a future
          tauri-plugin-os switch would be a nicer source of truth but
          isn't installed yet. */}
      {typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows') && (
        <div className="space-y-1.5 opacity-60">
          <div className="flex items-center gap-2">
            <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
              Windows install mode
            </p>
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide bg-zinc-800 text-zinc-500 border border-zinc-700/60">
              Coming soon
            </span>
          </div>
          <div
            role="radiogroup"
            aria-label="Windows install mode (coming soon)"
            className="grid grid-cols-3 gap-1.5 pointer-events-none"
          >
            {WIN_MODES.map((mode) => {
              const selected = winMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled
                  className={[
                    'flex items-center justify-center rounded-lg border px-2.5 py-2 text-xs font-medium cursor-not-allowed',
                    selected
                      ? 'border-zinc-700 bg-zinc-800/50 text-zinc-400'
                      : 'border-zinc-800/40 bg-[#050505] text-zinc-600',
                  ].join(' ')}
                >
                  {WIN_MODE_LABELS[mode]}
                </button>
              );
            })}
          </div>
          <p className="text-[10px] text-zinc-600">
            {WIN_MODE_HINTS[winMode]} — runtime selection requires a future app build
          </p>
        </div>
      )}

      {/* Manual check button + last-checked label */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleCheckNow()}
          disabled={busy || !isDesktop}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-semibold bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-wait text-white transition-colors"
        >
          {result.kind === 'checking'
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <RefreshCw className="w-3 h-3" />
          }
          Check for updates
        </button>
        <span className="text-[10px] text-zinc-600">Last checked: {lastCheckedLabel}</span>
      </div>

      {/* Status / result rows */}
      {result.kind === 'none' && (
        <p className="text-[11px] text-emerald-400 flex items-center gap-1">
          <CheckCircle2 className="w-3 h-3" />
          You&apos;re on the latest version.
        </p>
      )}

      {result.kind === 'available' && (
        <div className="rounded-lg border border-[#c5a062]/30 bg-[#c5a062]/5 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] border bg-[#c5a062]/10 border-[#c5a062]/30 text-[#c5a062]">
              v{result.version} available
            </span>
          </div>
          {result.body && (
            <p className="text-[10px] text-zinc-400 leading-relaxed line-clamp-3 whitespace-pre-wrap font-mono">
              {result.body}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleInstall()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-semibold bg-[#00e6ff] hover:bg-[#33eaff] active:bg-[#00b8cc] text-[#050505] transition-colors"
            >
              <Download className="w-3 h-3" />
              Download and install
            </button>
            <a
              href={RELEASES_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[11px] text-[#c5a062] hover:text-[#d4b478] transition-colors"
            >
              Release notes
            </a>
          </div>
        </div>
      )}

      {result.kind === 'installing' && (
        <div className="space-y-1.5" role="status" aria-live="polite">
          <div className="flex items-center justify-between text-[11px] text-zinc-300">
            <span className="flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin text-[#00e6ff]" />
              Installing v{result.version}
            </span>
            <span className="font-mono text-[#00e6ff]">
              {result.pct !== null ? `${result.pct}%` : '…'}
            </span>
          </div>
          <UpdateProgressBar percent={result.pct} />
        </div>
      )}

      {result.kind === 'unavailable' && (
        <div
          role="status"
          aria-label="Auto-update unavailable on this system"
          className="rounded-lg border border-zinc-800/60 bg-[#050505]/40 p-3 space-y-1"
        >
          <p className="text-[11px] text-zinc-300">
            Auto-update isn&apos;t available on this system. The latest installer is on GitHub.
          </p>
          <a
            href={result.releasesUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#00e6ff] hover:text-[#33eaff]"
          >
            <Download className="w-3 h-3" />
            Visit GitHub Releases
          </a>
        </div>
      )}

      {result.kind === 'error' && (
        <p className="text-[11px] text-red-400 flex items-center gap-1">
          <AlertCircle className="w-3 h-3" />
          {result.message}
        </p>
      )}

      <ReleaseHistoryList currentVersion={version} />
      <DiagnosticLog />
    </div>
  );
}
