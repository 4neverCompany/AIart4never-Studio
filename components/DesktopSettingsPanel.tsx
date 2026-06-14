'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Monitor, CheckCircle2, AlertCircle, Loader2, Camera, MessageCircle, Pin, Hash } from 'lucide-react';
import {
  DESKTOP_CONFIG_KEYS,
  PLATFORM_GROUPS,
  PLATFORM_OWNED_KEYS,
  UPDATER_KEYS,
  isPlatformEnabled,
  type DesktopConfigFieldMeta,
  type PlatformGroupMeta,
} from '@/lib/desktop-config-keys';
import { PortConflictBanner } from './PortConflictBanner';
import { AutoUpdateSettings } from './Settings/AutoUpdateSettings';
import { AutoStartSettings } from './Settings/AutoStartSettings';
import { Switch } from './Settings/Switch';

// Provider/model changes need pi to respawn so the new env reaches the
// child process. The next prompt will auto-restart pi after stop().
// M3.3-P3 commit c: the pi-restart logic + PI_RESTART_KEYS set are
// gone with the pi routes. The persist() function still exists for
// the non-pi desktop config keys (api keys, model defaults, etc.).

// V1.9.1: the inline PROP-005 "Launch at startup" toggle + its useAutolaunch
// hook were removed — they drove the SAME @tauri-apps/plugin-autostart OS
// state as the dedicated <AutoStartSettings> ("Start with Windows") rendered
// below, so the panel showed two identical autostart toggles. AutoStartSettings
// is the canonical one (better copy + useAutostartFirstRun integration).

// STORY-131: debounce window between the last keystroke and the auto-PATCH.
// 800 ms is long enough that rapid typing doesn't thrash the file system but
// short enough that closing the modal after a single edit almost always
// finishes the write before the panel unmounts.
const AUTOSAVE_DEBOUNCE_MS = 800;

// ── Types ────────────────────────────────────────────────────────────────────

interface DesktopConfigResponse {
  isDesktop: boolean;
  configPath: string;
  keys: Record<string, string>;
  error?: string;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

// ── Field rows ───────────────────────────────────────────────────────────────

function SecretField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="space-y-1.5">
      <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
        {label}
      </label>
      <div className="relative">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={visible ? 'Paste key here…' : '••••••••••••••••'}
          className="w-full bg-[#050505] border border-zinc-800/60 hover:border-[#c5a062]/30 focus:border-[#c5a062]/60 rounded-lg px-3 py-2.5 pr-10 text-sm text-white placeholder:text-zinc-700 focus:outline-none focus:ring-1 focus:ring-[#c5a062]/25 transition-colors font-mono"
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300 transition-colors"
          aria-label={visible ? 'Hide key' : 'Show key'}
          tabIndex={-1}
        >
          {visible
            ? <EyeOff className="w-3.5 h-3.5" />
            : <Eye     className="w-3.5 h-3.5" />
          }
        </button>
      </div>
      <p className="text-[10px] text-zinc-600">{hint}</p>
    </div>
  );
}

function TextField({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-[#050505] border border-zinc-800/60 hover:border-[#c5a062]/30 focus:border-[#c5a062]/60 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-zinc-700 focus:outline-none focus:ring-1 focus:ring-[#c5a062]/25 transition-colors font-mono"
        spellCheck={false}
        autoComplete="off"
      />
      <p className="text-[10px] text-zinc-600">{hint}</p>
    </div>
  );
}

function SelectField({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
        {label}
      </label>
      <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {options.map((opt) => {
          const selected = value === opt;
          return (
            <button
              key={opt}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(opt)}
              className={[
                'flex items-center justify-center rounded-lg border px-2.5 py-2 text-xs font-medium capitalize transition-colors',
                selected
                  ? 'border-[#c5a062] bg-[#c5a062]/10 text-[#c5a062]'
                  : 'border-zinc-800/60 bg-[#050505] text-zinc-400 hover:border-[#c5a062]/30 hover:text-zinc-200',
              ].join(' ')}
            >
              {opt}
            </button>
          );
        })}
      </div>
      <p className="text-[10px] text-zinc-600">{hint}</p>
    </div>
  );
}

function FieldRouter({
  meta,
  value,
  onChange,
}: {
  meta: DesktopConfigFieldMeta;
  value: string;
  onChange: (v: string) => void;
}) {
  if (meta.kind === 'select') {
    return <SelectField label={meta.label} hint={meta.hint} value={value} options={meta.options} onChange={onChange} />;
  }
  if (meta.kind === 'text') {
    return <TextField label={meta.label} hint={meta.hint} value={value} onChange={onChange} />;
  }
  return <SecretField label={meta.label} hint={meta.hint} value={value} onChange={onChange} />;
}

// ── V060-002: Platform group ─────────────────────────────────────────────────

const PLATFORM_ICONS: Record<PlatformGroupMeta['id'], typeof Camera> = {
  instagram: Camera,
  twitter: MessageCircle,
  pinterest: Pin,
  discord: Hash,
};

interface PlatformGroupSectionProps {
  group: PlatformGroupMeta;
  enabled: boolean;
  fieldMetas: ReadonlyArray<DesktopConfigFieldMeta>;
  draft: Record<string, string>;
  onToggle: (next: boolean) => void;
  onFieldChange: (key: string, value: string) => void;
}

function PlatformGroupSection({
  group,
  enabled,
  fieldMetas,
  draft,
  onToggle,
  onFieldChange,
}: PlatformGroupSectionProps) {
  const Icon = PLATFORM_ICONS[group.id];
  const showToggle = !group.alwaysOn;

  return (
    <div className="rounded-lg border border-zinc-800/60 bg-[#050505]/40">
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="w-3.5 h-3.5 text-[#c5a062] shrink-0" />
          <span className="text-xs font-semibold text-white truncate">{group.label}</span>
          {group.alwaysOn && (
            <span className="text-[9px] uppercase tracking-wider text-zinc-600">core</span>
          )}
        </div>
        {showToggle && (
          <Switch checked={enabled} onChange={onToggle} label={group.label} size="sm" />
        )}
      </div>
      {enabled && fieldMetas.length > 0 && (
        <div className="space-y-3 px-3 pb-3 pt-1 border-t border-zinc-800/60">
          {fieldMetas.map((meta) => (
            <FieldRouter
              key={meta.key}
              meta={meta}
              value={draft[meta.key] ?? ''}
              onChange={(v) => onFieldChange(meta.key, v)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
// ── Main component ────────────────────────────────────────────────────────────

/**
 * Desktop-specific settings panel for the Tauri build.
 * Renders nothing when running in web/serverless mode (isDesktop: false).
 * Reads and writes config.json via /api/desktop/config.
 */
export function DesktopSettingsPanel() {
  const [config, setConfig] = useState<DesktopConfigResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState('');
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Skip the initial save trigger when `draft` is first seeded from the GET
  // response — otherwise we'd PATCH on mount and race with the initial read.
  const seededRef = useRef(false);

  // ── Load ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/desktop/config')
      .then((r) => r.json())
      .then((data: DesktopConfigResponse) => {
        setConfig(data);
        // Seed draft with existing values
        const seed: Record<string, string> = {};
        for (const { key } of DESKTOP_CONFIG_KEYS) {
          seed[key] = data.keys[key] ?? '';
        }
        setDraft(seed);
        seededRef.current = true;
      })
      .catch(() => {
        // Not desktop — silently show nothing
        setConfig({ isDesktop: false, configPath: '', keys: {} });
      });
  }, []);

  // ── Save ──────────────────────────────────────────────────────────────────

  const persist = useCallback(async (snapshot: Record<string, string>) => {
    setSaveState('saving');
    setSaveError('');
    try {
      const res = await fetch('/api/desktop/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: snapshot }),
      });
      const data = await res.json() as DesktopConfigResponse & { success?: boolean };
      if (!res.ok || data.success === false) {
        setSaveState('error');
        setSaveError(data.error ?? 'Save failed.');
        return;
      }
      setSaveState('saved');
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaveState('idle'), 2500);
      // Refresh config so configPath / savedKeys reflect the write.
      const refreshed = await fetch('/api/desktop/config').then((r) => r.json() as Promise<DesktopConfigResponse>);
      setConfig(refreshed);
      // M3.3-P3 commit c: the pi-respawn side-effect is gone with the
      // pi routes. The desktop config still persists cleanly without it.
    } catch (e) {
      setSaveState('error');
      setSaveError((e as Error).message ?? 'Network error.');
    }
  }, []);

  // STORY-131 — auto-save. Debounce keystroke-level edits and PATCH when
  // the draft differs from the last-known config. No manual button needed.
  useEffect(() => {
    if (!seededRef.current || !config?.isDesktop) return;
    const changedKeys = DESKTOP_CONFIG_KEYS.filter(
      ({ key }) => (draft[key] ?? '') !== (config.keys[key] ?? '')
    );
    if (changedKeys.length === 0) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      void persist(draft);
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [draft, config, persist]);

  useEffect(() => () => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  // Still loading
  if (config === null) {
    return (
      <div className="flex items-center gap-2 py-4 text-zinc-600">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span className="text-xs">Checking desktop mode…</span>
      </div>
    );
  }

  // Web / serverless — render nothing
  if (!config.isDesktop) return null;

  return (
    <div className="space-y-5 pt-4 border-t border-[#c5a062]/20">
      {/* Section header */}
      <div className="flex items-center gap-2">
        <Monitor className="w-4 h-4 text-[#c5a062] shrink-0" />
        <h4 className="text-sm font-semibold text-white">Desktop Configuration</h4>
        <span className="ml-auto text-[10px] text-zinc-600 font-mono truncate max-w-[120px] sm:max-w-[220px]" title={config.configPath}>
          {config.configPath}
        </span>
      </div>

      <p className="text-[11px] text-zinc-500 -mt-1">
        API keys stored in <code className="text-zinc-400">config.json</code> on your machine — never sent to any server.
        Injected into the sidecar process at launch.
      </p>

      {/* PORT-001: Warn when ephemeral-port fallback fired */}
      <PortConflictBanner />

      {/* V1.9.1: the duplicate inline "Launch at startup" toggle was removed.
          The single autostart control is <AutoStartSettings> ("Start with
          Windows") rendered in the Auto-Start subsection below. */}

      {/* Config fields — kind-discriminated dispatch.
          UPDATER_KEYS render in the dedicated Updates subsection below.
          PLATFORM_OWNED_KEYS render in the Platforms section so the
          per-platform toggle controls visibility (V060-002). */}
      <div className="space-y-4">
        {DESKTOP_CONFIG_KEYS
          .filter((meta) => !UPDATER_KEYS.has(meta.key) && !PLATFORM_OWNED_KEYS.has(meta.key))
          .map((meta) => (
            <FieldRouter
              key={meta.key}
              meta={meta}
              value={draft[meta.key] ?? ''}
              onChange={(v) => setDraft((prev) => ({ ...prev, [meta.key]: v }))}
            />
          ))}
      </div>

      {/* V060-002: Platforms section — each non-core platform has a toggle
          that hides its API fields when off. Instagram is core and always
          renders its fields. Disabled platforms keep their stored creds
          on disk; the toggle is a visibility control, not a wipe. */}
      <div className="space-y-2">
        <h5 className="text-xs font-semibold text-white">Platforms</h5>
        {PLATFORM_GROUPS.map((group) => {
          const fieldMetas = DESKTOP_CONFIG_KEYS.filter((m) => group.fieldKeys.includes(m.key));
          const enabled = isPlatformEnabled(group, draft);
          return (
            <PlatformGroupSection
              key={group.id}
              group={group}
              enabled={enabled}
              fieldMetas={fieldMetas}
              draft={draft}
              onToggle={(next) =>
                setDraft((prev) =>
                  group.enabledKey ? { ...prev, [group.enabledKey]: next ? '1' : '0' } : prev,
                )
              }
              onFieldChange={(key, value) =>
                setDraft((prev) => ({ ...prev, [key]: value }))
              }
            />
          );
        })}
      </div>

      {/* Auto-Update subsection — granular toggles, manual check, update card. */}
      <AutoUpdateSettings
        draft={draft}
        onFieldChange={(key, value) => setDraft((prev) => ({ ...prev, [key]: value }))}
        isDesktop={config.isDesktop}
      />

      {/* Auto-Start subsection — Windows tray-icon companion (FEAT-TRAY-AUTOSTART). */}
      <AutoStartSettings isDesktop={config.isDesktop} />

      {/* Auto-save status row (STORY-131) */}
      <div className="flex items-center gap-2 min-h-[1.25rem]" aria-live="polite">
        {saveState === 'saving' && (
          <span className="flex items-center gap-1 text-[11px] text-zinc-500">
            <Loader2 className="w-3 h-3 animate-spin" />
            Saving…
          </span>
        )}
        {saveState === 'saved' && (
          <span className="flex items-center gap-1 text-[11px] text-[#00e6ff]">
            <CheckCircle2 className="w-3 h-3" />
            Saved to config.json
          </span>
        )}
        {saveState === 'error' && (
          <span className="flex items-center gap-1 text-[11px] text-red-400">
            <AlertCircle className="w-3 h-3" />
            {saveError || 'Save failed.'}
          </span>
        )}
        {saveState === 'idle' && (
          <span className="text-[11px] text-zinc-600">
            Changes are saved automatically.
          </span>
        )}
      </div>
    </div>
  );
}
