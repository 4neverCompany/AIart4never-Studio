'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  Settings as SettingsIcon,
  X,
  Check,
  Trash2,
  Folder,
  Plus,
  Tag,
  Eye,
  EyeOff,
  Copy,
  AlertCircle,
  Loader2,
  KeyRound,
  Cpu,
  Video as VideoIcon,
  Monitor,
  Sliders,
  Bot,
  Sparkles,
  Coins,
  Image as ImageIcon,
} from 'lucide-react';
import { showToast } from '@/components/Toast';
import {
  LEONARDO_MODELS,
  type Collection,
  type GeneratedImage,
} from './MashupContext';
import type { UserSettings, WatermarkSettings } from '@/types/mashup';
// M3.4-P4-B2: Watermark helpers moved to ./Settings/WatermarkSettings.tsx
// along with the Watermark JSX block. The store-side types and the
// `imageRef` flow are unchanged.
import { getAllTextModelSpecs } from '@/lib/text-model-specs';
import { DesktopSettingsPanel } from './DesktopSettingsPanel';
import { VercelAiModelPicker, defaultVercelAiModel } from './Settings/VercelAiModelPicker';
import { HiggsfieldConnection } from './Settings/HiggsfieldConnection';
import { CameraAnglePicker } from './Settings/CameraAnglePicker';
import { CreditBudgetSettings } from './Settings/CreditBudgetSettings';
import { SettingsSection } from './Settings/SettingsSection';
import { Switch } from './Settings/Switch';
// M3.4-P4-B2: Watermark JSX moved into the WatermarkSettings
// sub-component. Aliased on import to avoid a name clash with the
// `WatermarkSettings` store type above.
import { WatermarkSettings as WatermarkSettingsPanel } from './Settings/WatermarkSettings';
import { SystemPromptEditor } from './Settings/SystemPromptEditor';
import {
  HIGGSFIELD_DEFAULT_IMAGE_MODEL,
  HIGGSFIELD_DEFAULT_VIDEO_MODEL,
  HIGGSFIELD_IMAGE_MODELS,
  type HiggsfieldImageModelSlug,
  type HiggsfieldVideoModelSlug,
} from '@/lib/higgsfield/models';
import { getImageModel } from '@/lib/image-models';

/**
 * V082: runtime type guard for the `modelInfo` field returned by
 * /api/ai/status. The route shape is a structural type; the setter
 * needs to verify the response actually conforms before binding it
 * to the strongly-typed state. Untyped responses (e.g. an older
 * server build, a 200 with an error wrapper) get coerced to null
 * rather than throwing during render.
 */
function isTextModelInfo(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.modelId === 'string' &&
    typeof r.family === 'string' &&
    typeof r.generation === 'string' &&
    typeof r.description === 'string' &&
    typeof r.contextWindow === 'number' &&
    typeof r.defaultMaxTokens === 'number' &&
    typeof r.isDefault === 'boolean'
  );
}
import type { SettingsSaveState } from '@/hooks/useSettings';
import { APP_VERSION, getAppVersion } from '@/lib/app-version';

// M4: information-architecture reshuffle, 5 → 6 tabs. The old AI-Agent and
// AI-Engine tabs merge into one text-AI "AI Engine" tab; the image/video
// generation controls (previously buried under "General") get their own
// "Image & Video" tab; the per-cycle Credit Budget gets its own "Credits"
// tab; "API Keys" becomes "Providers & Keys" and "Desktop" becomes
// "Desktop / Advanced". Pure UI move — no settings shape change. Every block
// is relocated verbatim; the only de-dup is the Higgsfield video-model
// select (HiggsfieldConnection already owns defaultHiggsfieldVideoModel).
//   general     — collections, channel name, watermark
//   aiEngine    — active agent + model picker + system prompt + skills
//   imageVideo  — image-model defaults, Higgsfield connection, prompt
//                 controls (anti-AI-look / Director / camera), video settings
//   apiKeys     — web-only provider credentials + a desktop hint
//   credits     — per-cycle Higgsfield credit budget
//   desktop     — auto-update + Tauri-native config panel
type TabId = 'general' | 'aiEngine' | 'imageVideo' | 'apiKeys' | 'credits' | 'desktop';

/**
 * V082: SettingsSection — moved to `components/Settings/SettingsSection.tsx`
 * in M3.4-P4-B2 so the Settings sub-components can wrap their own
 * content without depending on this modal. Re-imported below.
 */

const TABS: ReadonlyArray<{ id: TabId; label: string; icon: typeof SettingsIcon }> = [
  { id: 'general', label: 'General', icon: Sliders },
  { id: 'aiEngine', label: 'AI Engine', icon: Cpu },
  { id: 'imageVideo', label: 'Image & Video', icon: ImageIcon },
  { id: 'apiKeys', label: 'Providers & Keys', icon: KeyRound },
  { id: 'credits', label: 'Credits', icon: Coins },
  { id: 'desktop', label: 'Desktop / Advanced', icon: Monitor },
];

// M3.3-P3 commit b: NcaStatus + NcaModel interfaces deleted.
// M3.3-P3 commit c: PiStatus + PiBusy types deleted with the pi routes
// (MainContent no longer imports them either).
// M3.4-P4-B2: agent-prompt defaults + builder + trademark-outcome store
// all moved to ./Settings/SystemPromptEditor.tsx alongside the JSX
// block that uses them. The modal no longer touches the trademark
// store directly.

interface SettingsModalProps {
  onClose: () => void;
  settings: UserSettings;
  updateSettings: (
    patch: Partial<UserSettings> | ((prev: UserSettings) => Partial<UserSettings>),
  ) => void;
  /** V1.1.1-CAMERA-ANGLE-CLEAR: explicit key-removal path. `updateSettings`
   *  can't actually delete a setting (the `mergeSettings` helper strips
   *  `undefined` patches), so the CameraAnglePicker "Clear" button goes
   *  through this instead. */
  clearSettings: (keys: (keyof UserSettings)[]) => void;
  /** FEAT-002b S1: lifecycle of the debounced IDB save — drives the header pill. */
  saveState: SettingsSaveState;
  isDesktop: boolean | null;
  // M3.3-P3 commit c: piStatus / piBusy / piError / piSetupMsg /
  // handlePiSetup / refreshPiStatus props deleted with the pi routes.
  collections: Collection[];
  savedImages: GeneratedImage[];
  deleteCollection: (id: string) => void;
  openCollectionModal: () => void;
}

export function SettingsModal({
  onClose,
  settings,
  updateSettings,
  clearSettings,
  saveState,
  isDesktop,
  // M3.3-P3 commit c: piStatus / piBusy / piError / piSetupMsg /
  // handlePiSetup / refreshPiStatus destructured deleted with the
  // pi routes.
  collections,
  savedImages,
  deleteCollection,
  openCollectionModal,
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<TabId>('general');
  // BUG-ACL-006: app version chip in the modal footer. Seeded from the
  // package.json constant so the footer renders something on the first
  // paint; upgraded to the Tauri-reported value when the runtime API
  // resolves. The runtime call is wrapped in try/catch inside
  // `getAppVersion` so the BUG-ACL-006 throw can't leave the footer
  // blank — falls back to APP_VERSION on ACL denial.
  const [appVersion, setAppVersion] = useState<string>(APP_VERSION);
  useEffect(() => {
    let cancelled = false;
    void getAppVersion().then((v) => {
      if (!cancelled) setAppVersion(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // M3.4-P4-B2: personalityName + trademarkStoreTick + the trademark
  // selectors moved to ./Settings/SystemPromptEditor.tsx (the only
  // component that used them). revealedFields stays here because the
  // password reveal toggles are spread across the API Keys tab.
  // Which password fields are currently revealed.
  const [revealedFields, setRevealedFields] = useState<Set<string>>(new Set());
  const toggleReveal = (field: string) =>
    setRevealedFields((prev) => {
      const next = new Set(prev);
      next.has(field) ? next.delete(field) : next.add(field);
      return next;
    });
  const copyField = (value: string) =>
    navigator.clipboard.writeText(value).then(
      () => showToast('Copied to clipboard', 'success'),
      () => showToast('Failed to copy', 'error'),
    );

  // M3.3-P3 commit b: ncaBusyRef + ncaApiKey + ncaJustAuthed state deleted with the nca routes.
  // M3.3-P3 commit b: refreshNcaStatus + postNcaSetup + auto-dismiss useEffect + handleNcaSetup + handleNcaApiKeySave deleted with the nca routes.
  // MMX status polling — runs once when the AI Agent tab is opened.
  // M3.3-P3 commit b: ncaAvailable + ncaStatus + ncaBusy + ncaError state deleted with the nca routes.
  // LLM-INTEGRATION-0513: status for the Vercel AI SDK provider.
  // Same shape as NcaStatus but `provider` is the resolved upstream
  // (openai / anthropic / openrouter) so the card can render which API
  // key is wired up. `available` ↔ at least one key is set on the server.
  // V082: `modelInfo` carries the catalog entry for the resolved
  // model so the AI Engine tab can render the active-model card
  // (family / generation / context window / description) without a
  // second round-trip to /api/ai/models.
  const [aiStatus, setAiStatus] = useState<{
    available: boolean;
    authenticated: boolean;
    provider: string | null;
    model: string | null;
    modelInfo: {
      modelId: string;
      family: string;
      generation: string;
      description: string;
      contextWindow: number;
      defaultMaxTokens: number;
      isDefault: boolean;
    } | null;
  } | null>(null);
  // Model list from /api/nca/models. Populated lazily once nca is
  // M3.3-P3 commit b: nca-status useEffect deleted with the nca routes.
  // LLM-INTEGRATION-0513: probe /api/ai/status for the vercel-ai card.
  // M4: the agent card + the active-model card both moved into the merged
  // "AI Engine" tab, so the probe now fires when that tab opens — no point
  // burning a server hop on every tab change.
  useEffect(() => {
    if (activeTab !== 'aiEngine') return;
    let cancelled = false;
    fetch('/api/ai/status', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setAiStatus({
          available: !!data.available,
          authenticated: !!data.authenticated,
          provider: typeof data.provider === 'string' ? data.provider : null,
          model: typeof data.model === 'string' ? data.model : null,
          // V082: include the catalog entry so the active-model card
          // in the AI Engine tab can render family / generation /
          // context window without a second round-trip.
          modelInfo: isTextModelInfo(data.modelInfo) ? data.modelInfo : null,
        });
      })
      .catch(() => { /* leave null — card renders "Checking…" until probe lands */ });
    return () => { cancelled = true; };
  }, [activeTab]);

  // Fetch the model list when (and only when) nca is authenticated. The
  // M3.3-P3 commit b: nca-models useEffect deleted with the nca routes.
  // M3.3-P3 commit b: handleNcaModelSelect deleted with the nca routes.
  // The runtime default flips to 'vercel-ai' for any payload that
  // predates the migration (a one-shot IDB rewrite in useSettings.ts
  // handles persisted user choices too). The two-field fall-through
  // (aiAgentProvider → activeAiAgent → 'vercel-ai') is preserved for
  // the same back-compat reason the field was kept on the type.
  const activeAiAgent: 'vercel-ai' =
    settings.aiAgentProvider ?? settings.activeAiAgent ?? 'vercel-ai';


  // FEAT-002b S1: drive the saved/saving/error pill from the real lifecycle
  // exposed by useSettings instead of an ephemeral local timer. The "Saved"
  // pill only shows for ~1.5s after each successful write so the header
  // doesn't permanently advertise "Saved" the entire session — once the
  // window elapses we hide it via the local fade flag below.
  const [showSavedPill, setShowSavedPill] = useState(false);
  // V105.1-REACT-19: setState deferred via queueMicrotask (project
  // convention) so the effect body only manages the fade-out timer
  // (external system), not local state in the body.
  // V105.6-REACT-19-REVIEW: `active` flag prevents the microtask
  // body and the timer callback from running setState after the
  // effect has been cleaned up (avoid "setState on unmounted"
  // and a leaked timer if saveState changes during the microtask
  // scheduling window).
  useEffect(() => {
    let active = true;
    let fadeTimer: ReturnType<typeof setTimeout> | undefined;
    queueMicrotask(() => {
      if (!active) return;
      if (saveState.kind !== 'saved') {
        setShowSavedPill(false);
        return;
      }
      setShowSavedPill(true);
      fadeTimer = setTimeout(() => {
        if (active) setShowSavedPill(false);
      }, 1500);
    });
    return () => {
      active = false;
      if (fadeTimer !== undefined) clearTimeout(fadeTimer);
    };
  }, [saveState]);

  // ── MMX setup form (shared between hoisted CTA and active-agent panel) ───
  // Defined inline so both render sites get pixel-identical UX. The caption
  // is state-aware so a single block covers Loading / Not Installed /
  // Not Authenticated. The authenticated-and-ready state is rendered
  // separately by the active-agent panel since the hoisted CTA hides itself
  // in that case.
  // M3.3-P3 commit b: ncaCaption + ncaIsNotInstalled + ncaInstallBlock + ncaApiKeyForm deleted with the nca routes.

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-0 sm:p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
        className="bg-[#0d0d0d]/99 backdrop-blur-xl border-0 sm:border border-[#c5a062]/30 rounded-none sm:rounded-2xl w-full sm:max-w-2xl overflow-hidden shadow-[0_8px_48px_rgba(0,0,0,0.8),0_0_60px_rgba(197,160,98,0.08),0_0_0_1px_rgba(197,160,98,0.06)] flex flex-col h-full sm:h-auto max-h-[100dvh] sm:max-h-[90vh]"
      >
        <div className="flex items-center justify-between p-6 border-b border-[#c5a062]/20 bg-[#050505]/60 shrink-0">
          <h3 className="type-title flex items-center gap-2">
            <SettingsIcon className="w-5 h-5 text-[#c5a062]" />
            Settings
          </h3>
          <div className="flex items-center gap-3">
            {/* FEAT-002b S1: real save lifecycle pill — emerald Saved /
                blue Saving… / red Save failed: msg. Replaces the prior
                ephemeral local timer that fired regardless of whether
                the IDB write actually succeeded. */}
            {saveState.kind === 'error' && (
              <span
                role="alert"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-red-500/15 text-red-300 border border-red-500/40 max-w-[260px]"
                title={saveState.message}
              >
                <AlertCircle className="w-3 h-3 shrink-0" />
                <span className="truncate">Save failed: {saveState.message}</span>
              </span>
            )}
            {saveState.kind === 'saving' && (
              <span className="inline-flex items-center gap-1.5 text-xs text-[#00e6ff] pointer-events-none select-none">
                <Loader2 className="w-3 h-3 animate-spin" />
                Saving…
              </span>
            )}
            {saveState.kind !== 'error' && saveState.kind !== 'saving' && (
              <motion.span
                animate={{ opacity: showSavedPill ? 1 : 0 }}
                transition={{ duration: 0.2 }}
                className="text-xs text-emerald-400 flex items-center gap-1 pointer-events-none select-none"
              >
                <Check className="w-3 h-3" />
                Saved
              </motion.span>
            )}
            <button
              onClick={onClose}
              className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-full transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* FEAT-002b: tab bar — sticky between header and scroll body. */}
        <div className="flex items-stretch gap-1 px-3 pt-2 border-b border-zinc-800/60 bg-[#050505]/40 shrink-0 overflow-x-auto custom-scrollbar">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                aria-current={active ? 'page' : undefined}
                className={`relative inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap rounded-t-lg ${
                  active
                    ? 'text-white bg-zinc-900/60'
                    : 'text-zinc-500 hover:text-zinc-200'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
                {active && (
                  <span className="absolute left-2 right-2 -bottom-px h-0.5 bg-[#c5a062] rounded-full" />
                )}
              </button>
            );
          })}
        </div>

        <div className="p-6 space-y-6 overflow-y-auto">
          {activeTab === 'apiKeys' && (
          <>
          {/* FEAT-002b: in desktop mode all API credentials are owned by
              DesktopSettingsPanel (config.json). Surface a hint here so
              users land on the right place instead of pondering an empty
              tab. The actual web-only inputs below are gated by
              `isDesktop === false` for STORY-130 / INSTAGRAM-CRED-FIX. */}
          {isDesktop === true && (
            <div className="rounded-xl border border-[#c5a062]/30 bg-[#c5a062]/5 p-4 flex items-start gap-3">
              <Monitor className="w-4 h-4 text-[#c5a062] shrink-0 mt-0.5" />
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-white">Managed in Desktop Configuration</p>
                <p className="text-[11px] text-zinc-400 leading-relaxed">
                  Leonardo, Instagram, and Pinterest credentials are stored in <code className="text-zinc-300">config.json</code> on disk and injected into the pi sidecar at start. Edit them in the Desktop tab.
                </p>
                <button
                  type="button"
                  onClick={() => setActiveTab('desktop')}
                  className="text-[11px] text-[#00e6ff] hover:text-[#33eaff] transition-colors"
                >
                  Open Desktop tab →
                </button>
              </div>
            </div>
          )}
          {/* API Keys Section */}
          <div className="space-y-4 pt-4 border-t border-zinc-800">
            <label className="text-sm font-medium text-zinc-300">API Keys</label>
            {/*
              STORY-130: In desktop mode the Leonardo API key is owned by
              DesktopSettingsPanel (writes to config.json + injects env var
              into the sidecar). Rendering a second input here persisted to
              origin-scoped IndexedDB and silently shadowed the real value
              — top appeared broken while bottom worked. Hide in desktop.
            */}
            {isDesktop === false && (
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Leonardo API Key</label>
                <div className="relative">
                  <input
                    type={revealedFields.has('leonardo') ? 'text' : 'password'}
                    value={settings.apiKeys.leonardo || ''}
                    onChange={(e) => updateSettings({ apiKeys: { ...settings.apiKeys, leonardo: e.target.value } })}
                    placeholder="••••••••••••••••"
                    className="w-full bg-zinc-950 border border-zinc-800/60 rounded-lg px-3 py-2 pr-16 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30"
                  />
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    {settings.apiKeys.leonardo && (
                      <button type="button" onClick={() => copyField(settings.apiKeys.leonardo!)} className="text-zinc-500 hover:text-zinc-300 transition-colors" aria-label="Copy API key">
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button type="button" onClick={() => toggleReveal('leonardo')} className="text-zinc-500 hover:text-zinc-300 transition-colors" aria-label={revealedFields.has('leonardo') ? 'Hide API key' : 'Show API key'}>
                      {revealedFields.has('leonardo') ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-4 pt-4 border-t border-zinc-800">
              <h4 className="text-sm font-bold text-white">Free Social Posting Setup</h4>

              {/*
                INSTAGRAM-CRED-FIX: In desktop mode IG creds are owned by
                DesktopSettingsPanel (writes to config.json, stable on-disk
                location). Rendering a second input here persisted to
                origin-scoped IndexedDB silently lost data on webview origin
                drift (STORY-121 fallback path). Hide in desktop.
              */}
              {isDesktop === false && (
                <div className="space-y-2">
                  <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Instagram Graph API (Free)</label>
                  <div className="grid grid-cols-1 gap-2">
                    <input
                      type="text"
                      value={settings.apiKeys.instagram?.igAccountId || ''}
                      onChange={(e) => updateSettings({ apiKeys: { ...settings.apiKeys, instagram: { accessToken: settings.apiKeys.instagram?.accessToken ?? '', igAccountId: e.target.value } } })}
                      placeholder="Instagram Business Account ID"
                      className="w-full bg-zinc-950 border border-zinc-800/60 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30"
                    />
                    <div className="relative">
                      <input
                        type={revealedFields.has('ig-token') ? 'text' : 'password'}
                        value={settings.apiKeys.instagram?.accessToken || ''}
                        onChange={(e) => updateSettings({ apiKeys: { ...settings.apiKeys, instagram: { accessToken: e.target.value, igAccountId: settings.apiKeys.instagram?.igAccountId ?? '' } } })}
                        placeholder="Long-lived Page Access Token"
                        className="w-full bg-zinc-950 border border-zinc-800/60 rounded-lg px-3 py-2 pr-16 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30"
                      />
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                        {settings.apiKeys.instagram?.accessToken && (
                          <button type="button" onClick={() => copyField(settings.apiKeys.instagram!.accessToken)} className="text-zinc-500 hover:text-zinc-300 transition-colors" aria-label="Copy access token">
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button type="button" onClick={() => toggleReveal('ig-token')} className="text-zinc-500 hover:text-zinc-300 transition-colors" aria-label={revealedFields.has('ig-token') ? 'Hide token' : 'Show token'}>
                          {revealedFields.has('ig-token') ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>
                  </div>
                  <p className="text-[10px] text-zinc-500 mt-1">Requires a Facebook Developer App linked to an Instagram Business account.</p>
                </div>
              )}

              {/* Pinterest — hidden on desktop; config.json owns these keys */}
              {isDesktop === false && (
              <div className="space-y-2 pt-3 border-t border-zinc-800/60">
                <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Pinterest API</label>
                <div className="grid grid-cols-1 gap-2">
                  <div className="relative">
                    <input
                      type={revealedFields.has('pinterest-token') ? 'text' : 'password'}
                      value={settings.apiKeys.pinterest?.accessToken || ''}
                      onChange={(e) => updateSettings({ apiKeys: { ...settings.apiKeys, pinterest: { accessToken: e.target.value, boardId: settings.apiKeys.pinterest?.boardId } } })}
                      placeholder="Pinterest Access Token"
                      className="w-full bg-zinc-950 border border-zinc-800/60 rounded-lg px-3 py-2 pr-16 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30"
                    />
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                      {settings.apiKeys.pinterest?.accessToken && (
                        <button type="button" onClick={() => copyField(settings.apiKeys.pinterest!.accessToken)} className="text-zinc-500 hover:text-zinc-300 transition-colors" aria-label="Copy access token">
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button type="button" onClick={() => toggleReveal('pinterest-token')} className="text-zinc-500 hover:text-zinc-300 transition-colors" aria-label={revealedFields.has('pinterest-token') ? 'Hide token' : 'Show token'}>
                        {revealedFields.has('pinterest-token') ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>
                  <input
                    type="text"
                    value={settings.apiKeys.pinterest?.boardId || ''}
                    onChange={(e) => updateSettings({ apiKeys: { ...settings.apiKeys, pinterest: { accessToken: settings.apiKeys.pinterest?.accessToken ?? '', boardId: e.target.value } } })}
                    placeholder="Board ID (optional — defaults to account's first board)"
                    className="w-full bg-zinc-950 border border-zinc-800/60 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30"
                  />
                </div>
                <p className="text-[10px] text-zinc-500 mt-1">
                  Create an app at developers.pinterest.com with <code>pins:write</code> and <code>boards:read</code> scopes.
                </p>
              </div>
              )}
            </div>
          </div>
          </>
          )}

          {activeTab === 'aiEngine' && (
          <>
          <div className="space-y-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="p-1.5 bg-[#c5a062]/10 rounded-lg">
                <Bot className="w-4 h-4 text-[#c5a062]" />
              </div>
              <h4 className="text-sm font-bold text-white uppercase tracking-wider">Active AI Agent</h4>
            </div>
            <p className="text-[11px] text-zinc-500 -mt-2">
              Pick the backend that handles ideas, captions, prompt enhancement, and tagging. The active agent is used for every text-AI call across the app.
            </p>

            {/* FIRSTRUN-503: fresh installs default to vercel-ai (types/mashup.ts:847)
                but ship with no API keys, so the first chat hits a 503 with no
                explanation. Surface the missing-key state at the top of the tab
                whenever vercel-ai is active and /api/ai/status reports
                available=false. Keys are server-side env vars, so we point at
                them by name instead of pretending there's an in-UI form. */}
            {activeAiAgent === 'vercel-ai' && aiStatus?.available === false && (
              <div
                role="status"
                className="flex items-start gap-2.5 rounded-xl border border-amber-400/40 bg-amber-400/10 px-3 py-2.5"
              >
                <AlertCircle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-semibold text-amber-200 mb-0.5">
                    AI chat is unavailable — vercel-ai has no API key.
                  </p>
                  <p className="text-[11px] text-amber-200/80 leading-relaxed">
                    Set one of <code className="text-[10px] bg-amber-400/10 px-1 rounded">MINIMAX_API_KEY</code>,{' '}
                    <code className="text-[10px] bg-amber-400/10 px-1 rounded">OPENAI_API_KEY</code>,{' '}
                    <code className="text-[10px] bg-amber-400/10 px-1 rounded">ANTHROPIC_API_KEY</code>, or{' '}
                    <code className="text-[10px] bg-amber-400/10 px-1 rounded">OPENROUTER_API_KEY</code> on the server, or pick a different agent below.
                  </p>
                </div>
              </div>
            )}

            {/* M3.3-P3 commit c: the Pi.dev card deleted. The grid is
                now 1-col (vercel-ai only) — no other AI Engine option
                remains. */}
            <div className="grid grid-cols-1 gap-3">

              {/* LLM-INTEGRATION-0513: Vercel AI SDK card — stateless direct
                  HTTPS calls to the configured provider (OpenAI / Anthropic
                  / OpenRouter). No subprocess, no binary, no install flow.
                  Availability flips on the moment one of the *_API_KEY env
                  vars is set on the server. */}
              {(() => {
                const selected = activeAiAgent === 'vercel-ai';
                const available = aiStatus?.available;
                let dot = 'bg-zinc-600';
                let label = 'Checking…';
                let labelColor = 'text-zinc-400';
                if (available === true) {
                  dot = 'bg-emerald-400';
                  label = 'Available';
                  labelColor = 'text-emerald-300';
                } else if (available === false) {
                  dot = 'bg-amber-400';
                  label = 'No API key';
                  labelColor = 'text-amber-300';
                }
                return (
                  <button
                    type="button"
                    onClick={() => updateSettings({ activeAiAgent: 'vercel-ai', aiAgentProvider: 'vercel-ai' })}
                    aria-pressed={selected}
                    className={`text-left rounded-xl border p-4 transition-all ${
                      selected
                        ? 'border-[#c5a062] bg-[#c5a062]/10 shadow-[0_0_0_1px_rgba(197,160,98,0.3)]'
                        : 'border-zinc-800/60 bg-zinc-950/40 hover:border-zinc-700'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Cpu className="w-4 h-4 text-[#c5a062]" />
                        <span className="text-sm font-bold text-white">vercel-ai</span>
                      </div>
                      <span className={`text-[10px] font-semibold uppercase tracking-wider ${selected ? 'text-[#c5a062]' : 'text-zinc-500'}`}>
                        {selected ? '● Selected' : '○ Select'}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
                      <span className={`text-[11px] ${labelColor}`}>{label}</span>
                      {aiStatus?.provider && aiStatus?.model && (
                        <span className="text-[10px] text-zinc-500 ml-1 truncate">{aiStatus.provider}/{aiStatus.model}</span>
                      )}
                    </div>
                    <p className="text-[10px] text-zinc-500 leading-relaxed">
                      Vercel AI SDK — direct MiniMax / OpenAI / Anthropic / OpenRouter streaming.
                      Set MINIMAX_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or OPENROUTER_API_KEY on the server.
                    </p>
                  </button>
                );
              })()}
            </div>

            {/* M3.3-P3 commit c: the entire active-agent panel block
                (nca-install CTA + Pi.dev-active panel + piStatus /
                piSetupMsg / piError surface) deleted. The aiAgent tab
                is now just the card grid + the "Engine details live in
                the AI Engine tab" footer. */}
            <p className="text-[10px] text-zinc-500 pt-2 border-t border-zinc-800/60">
              Engine details (system prompt, niches, genres) live in the AI Engine tab.
            </p>
          </div>
          </>
          )}

          {activeTab === 'general' && (
          <>
          {/* FEAT-002b: Manage Collections (lifted out of watermark conditional) */}
          <div className="space-y-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className="p-1.5 bg-[#c5a062]/10 rounded-lg">
                  <Folder className="w-4 h-4 text-[#c5a062]" />
                </div>
                <h4 className="text-sm font-bold text-white uppercase tracking-wider">Manage Collections</h4>
              </div>
              <button
                onClick={openCollectionModal}
                className="btn-blue-sm px-3 py-1 text-[10px] rounded-lg gap-2"
              >
                <Plus className="w-3 h-3" />
                New
              </button>
            </div>
            <div className="grid grid-cols-1 gap-2 max-h-[200px] overflow-y-auto custom-scrollbar pr-2">
              {collections.map((col) => (
                <div key={col.id} className="group bg-zinc-900 border border-zinc-800/60 rounded-xl p-3 flex items-center justify-between hover:border-zinc-700 transition-all">
                  <div className="space-y-0.5">
                    <h5 className="text-xs font-bold text-white">{col.name}</h5>
                    <p className="text-[9px] text-zinc-600 uppercase tracking-tighter">
                      {savedImages.filter((img) => img.collectionId === col.id).length} Images
                    </p>
                  </div>
                  <button
                    onClick={() => deleteCollection(col.id)}
                    className="p-1.5 text-zinc-600 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                    title="Delete Collection"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
              {collections.length === 0 && (
                <div className="text-center py-4 border border-dashed border-zinc-800 rounded-xl">
                  <p className="text-[10px] text-zinc-500 italic">No collections created yet.</p>
                </div>
              )}
            </div>
          </div>

          {/* FEAT-002b: Channel Name (lifted out of watermark conditional) */}
          <div className="space-y-4 pt-4 border-t border-zinc-800/50">
            <div className="flex items-center gap-2 mb-2">
              <div className="p-1.5 bg-[#c5a062]/10 rounded-lg">
                <Tag className="w-4 h-4 text-[#c5a062]" />
              </div>
              <h4 className="text-sm font-bold text-white uppercase tracking-wider">Social Media</h4>
            </div>
            <div className="space-y-2">
              <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-[0.1em]">Channel Name (for Hashtags)</label>
              <input
                type="text"
                value={settings.channelName || ''}
                onChange={(e) => updateSettings({ channelName: e.target.value })}
                placeholder="e.g. MultiverseMashupAI"
                className="w-full bg-zinc-900 border border-zinc-800/60 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30 transition-all"
              />
            </div>
          </div>
          </>
          )}

          {/* M4: image-generation defaults (Higgsfield add-on, default image
              model, default text model) relocated from "General" to the new
              "Image & Video" tab. Block content is unchanged. */}
          {activeTab === 'imageVideo' && (
          <>
          <div className="space-y-4 pt-4 border-t border-zinc-800">
            <h4 className="text-lg font-medium text-white mb-2">Image Generation Settings</h4>

            {/* V1.4.0: Higgsfield add-on toggle. The user keeps their
                existing Leonardo workflow; toggling this on adds a
                parallel Higgsfield generation per idea. Multiple
                Higgsfield models are exercised via the multi-select
                below. */}
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
                <input
                  type="checkbox"
                  checked={!!settings.higgsfieldEnabled}
                  onChange={(e) => updateSettings({ higgsfieldEnabled: e.target.checked })}
                  className="h-4 w-4 rounded border-zinc-700 bg-zinc-950 text-[#c5a062] focus:ring-[#c5a062]/30"
                />
                <span>Also generate with Higgsfield (in addition to Leonardo)</span>
              </label>
              <p className="text-[10px] text-zinc-600 ml-6">
                Opt-in add-on. Your existing Leonardo workflow stays the primary path. When enabled, one Higgsfield
                variant per idea is generated in parallel using the models selected below. Round-robin across
                multiple models so you see different aesthetic per run.
              </p>
            </div>

            {settings.higgsfieldEnabled && (
              <div className="space-y-2 ml-6 p-3 rounded border border-zinc-800/60 bg-zinc-950/40">
                <label className="block text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
                  Higgsfield Models (one image per idea, round-robin)
                </label>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {HIGGSFIELD_IMAGE_MODELS.map((m) => {
                    const enabled = settings.higgsfieldImageModels ?? ['nano_banana_2']
                    const isChecked = enabled.includes(m.slug)
                    const unified = getImageModel(`higgsfield:${m.slug}`)
                    return (
                      <label key={m.slug} className="flex items-start gap-2 text-[11px] text-zinc-300">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...enabled, m.slug]
                              : enabled.filter((s) => s !== m.slug)
                            updateSettings({ higgsfieldImageModels: next })
                          }}
                          className="mt-0.5 h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-950 text-[#c5a062] focus:ring-[#c5a062]/30"
                        />
                        <span>
                          <span className="font-medium">{m.displayName}</span>
                          {unified?.skillBinding && (
                            <span className="block text-[10px] text-zinc-600 mt-0.5">
                              skill: {unified.skillBinding.skillName} · {unified.skillBinding.blurb}
                            </span>
                          )}
                        </span>
                      </label>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <label className="block text-[10px] font-medium text-zinc-500 uppercase tracking-wider">Default Image Model</label>
                <select
                  value={settings.defaultLeonardoModel}
                  onChange={(e) => updateSettings({ defaultLeonardoModel: e.target.value })}
                  className="w-full bg-zinc-950 border border-zinc-800/60 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30"
                >
                  {/* P3 of PROV-AGNOSTIC-PARAMS: group models by backend
                      provider so the user can see at a glance which
                      models go through Leonardo vs MiniMax's native
                      image_generation endpoint. Undefined `provider` on
                      pre-MXIMG-001 models bucketises as Leonardo. */}
                  {(() => {
                    const buckets = new Map<string, typeof LEONARDO_MODELS>();
                    for (const m of LEONARDO_MODELS) {
                      const p = m.provider ?? 'leonardo';
                      const list = buckets.get(p) ?? [];
                      list.push(m);
                      buckets.set(p, list);
                    }
                    const providerLabel = (p: string) =>
                      p === 'leonardo' ? 'Leonardo' :
                      p === 'minimax' ? 'MiniMax' :
                      p.charAt(0).toUpperCase() + p.slice(1);
                    // Stable display order: Leonardo first (historical
                    // default), then everything else alphabetical.
                    const orderedProviders = Array.from(buckets.keys()).sort((a, b) => {
                      if (a === 'leonardo') return -1;
                      if (b === 'leonardo') return 1;
                      return a.localeCompare(b);
                    });
                    return orderedProviders.map((p) => (
                      <optgroup key={p} label={providerLabel(p)}>
                        {(buckets.get(p) ?? []).map((m) => (
                          <option key={m.id} value={m.id}>{m.name}</option>
                        ))}
                      </optgroup>
                    ));
                  })()}
                </select>
              </div>

              {/* P3 of PROV-AGNOSTIC-PARAMS: text-model picker. Only
                  visible when vercel-ai is active — pi/nca/mmx select
                  their text model server-side via subprocess flags and
                  ignore body.model from this client. An empty selection
                  means "use server default" (VERCEL_AI_MODEL env or the
                  provider-built-in fallback in resolveProvider). */}
              {activeAiAgent === 'vercel-ai' && (
                <div className="space-y-2">
                  <label className="block text-[10px] font-medium text-zinc-500 uppercase tracking-wider">Default Text Model</label>
                  <select
                    value={settings.activeTextModel ?? ''}
                    onChange={(e) => updateSettings({ activeTextModel: e.target.value || undefined })}
                    className="w-full bg-zinc-950 border border-zinc-800/60 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30"
                  >
                    <option value="">— Server default —</option>
                    {(() => {
                      const buckets = new Map<string, ReturnType<typeof getAllTextModelSpecs>>();
                      for (const s of getAllTextModelSpecs()) {
                        const list = buckets.get(s.provider) ?? [];
                        list.push(s);
                        buckets.set(s.provider, list);
                      }
                      const providerLabel = (p: string) =>
                        p === 'minimax' ? 'MiniMax' :
                        p === 'openai' ? 'OpenAI' :
                        p === 'anthropic' ? 'Anthropic' :
                        p === 'openrouter' ? 'OpenRouter' :
                        p.charAt(0).toUpperCase() + p.slice(1);
                      // MiniMax-first ordering: the route's
                      // resolveProvider chain prioritises MINIMAX_API_KEY,
                      // so the picker mirrors that hierarchy.
                      const order = ['minimax', 'openai', 'anthropic', 'openrouter'];
                      return order
                        .filter((p) => buckets.has(p))
                        .map((p) => (
                          <optgroup key={p} label={providerLabel(p)}>
                            {(buckets.get(p) ?? []).map((s) => (
                              <option key={s.modelId} value={s.modelId}>{s.modelId}</option>
                            ))}
                          </optgroup>
                        ));
                    })()}
                  </select>
                </div>
              )}
            </div>
          </div>
          </>
          )}

          {activeTab === 'aiEngine' && (
          <>
          {/* M3.3-P3 commit c: the pi-specific sub-block deleted. The
              AI Engine tab is now vercel-ai-only; the ternary
              branching around 'Vercel.ai AI Engine' vs 'Pi.dev AI
              Engine' is gone too. */}
          <div className="space-y-4 pt-4 border-t border-zinc-800">
            <h4 className="text-lg font-medium text-white mb-2">
              Vercel.ai AI Engine
            </h4>
            <div className="space-y-2 -mt-2">
              <p className="text-[11px] text-zinc-500">
                Text AI runs through Vercel&apos;s AI gateway — no local subprocess.
                Pick a model below; provider keys are stored in <code>.env.local</code>.
              </p>
              {aiStatus?.modelInfo && (
                <div
                  data-testid="active-model-card"
                  className="rounded-lg border border-zinc-800/60 bg-zinc-950/40 p-3"
                >
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <div>
                      <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-zinc-500 mb-0.5">
                        Active model
                      </div>
                      <div className="font-mono text-sm text-white">
                        {aiStatus.modelInfo.modelId}
                      </div>
                      <div className="text-[10.5px] text-zinc-400 mt-0.5">
                        {aiStatus.modelInfo.family} · {aiStatus.modelInfo.generation}
                      </div>
                    </div>
                    <div className="text-right text-[9.5px] font-mono text-zinc-500 leading-tight">
                      <div>{aiStatus.modelInfo.contextWindow.toLocaleString()} ctx</div>
                      <div>{aiStatus.modelInfo.defaultMaxTokens.toLocaleString()} out</div>
                    </div>
                  </div>
                  <p className="text-[10.5px] text-zinc-400 leading-relaxed">
                    {aiStatus.modelInfo.description}
                  </p>
                </div>
              )}
              <VercelAiModelPicker
                selected={settings.activeTextModel ?? null}
                onSelect={(modelId) => updateSettings({ activeTextModel: modelId })}
              />
            </div>

            <p className="text-[10px] text-zinc-500 pt-2 border-t border-zinc-800/60">
              This prompt shapes every AI interaction across the app. Changes apply immediately.
            </p>
          </div>
          </>
          )}

          {/* M4: Higgsfield connection (OAuth/CLI + default image/video models)
              relocated from "AI Engine" to "Image & Video" so all image/video
              provider config lives in one tab. Component + props unchanged. It
              is the single owner of defaultHiggsfieldVideoModel (the duplicate
              per-provider video select in the Video block below was removed). */}
          {activeTab === 'imageVideo' && (
          <>
          <div className="space-y-4 pt-4 border-t border-zinc-800">
            {/* HIGGSFIELD-INTEGRATION: image generation provider
                alongside Leonardo. OAuth-based — each user connects
                their own Higgsfield account. Peer, not replacement. */}
            <HiggsfieldConnection
              selectedImageModel={
                (settings.defaultHiggsfieldImageModel as never) ||
                HIGGSFIELD_DEFAULT_IMAGE_MODEL
              }
              selectedVideoModel={
                (settings.defaultHiggsfieldVideoModel as never) ||
                HIGGSFIELD_DEFAULT_VIDEO_MODEL
              }
              onSelectImageModel={(slug) =>
                updateSettings({ defaultHiggsfieldImageModel: slug })
              }
              onSelectVideoModel={(slug) =>
                updateSettings({ defaultHiggsfieldVideoModel: slug })
              }
              cliToken={settings.higgsfieldCliToken}
              onSaveCliToken={(token) =>
                updateSettings({ higgsfieldCliToken: token })
              }
              onConnectionChange={(connected) =>
                updateSettings({ higgsfieldConnected: connected })
              }
            />
          </div>
          </>
          )}

          {activeTab === 'general' && (
          <>
          {/* M3.4-P4-B2: Watermark block moved to ./Settings/WatermarkSettings.tsx.
              Aliased on import as `WatermarkSettingsPanel` to avoid clashing with
              the `WatermarkSettings` type from @/types/mashup. */}
          <WatermarkSettingsPanel
            settings={settings}
            updateSettings={updateSettings}
          />
          </>
          )}

          {/* M4: the per-cycle Higgsfield credit budget gets its own
              "Credits" tab. Block content unchanged. */}
          {activeTab === 'credits' && (
          <>
          {/* V1.0.7-PROMPT-ENG-D: per-cycle credit budget. The gate only
              affects the Higgsfield provider; users who don't enable a cap
              see nothing here. */}
          <SettingsSection
            icon={Coins}
            title="Credit Budget"
            subtitle="Optional cap on monthly Higgsfield credits. Leave the field blank to disable."
            tone="cyan"
          >
            <CreditBudgetSettings
              cap={settings.higgsfieldMonthlyCreditCap}
              onChange={(next) => updateSettings({ higgsfieldMonthlyCreditCap: next })}
            />
          </SettingsSection>
          </>
          )}

          {/* M4: image prompt-engineering controls (anti-AI-look / Director /
              camera) + the video settings render under "Image & Video".
              Block content unchanged except the de-duped Higgsfield video
              select (see the Video block below). */}
          {activeTab === 'imageVideo' && (
          <>
          {/* V1.0.7-PROMPT-ENG-A4: anti-AI-look toggle. Wired through
              useImageGeneration → submitLeonardoAndPoll / submitViaAiImage
              (PR #35). Hidden behind a default-OFF switch so the
              curated negative list only kicks in when the user
              explicitly opts in. */}
          <SettingsSection
            icon={Sparkles}
            title="Image Generation"
            subtitle="Prompt-engineering controls applied to every new image idea."
            tone="cyan"
          >
            <div className="flex items-center justify-between bg-zinc-950/50 p-4 rounded-xl border border-zinc-800/60">
              <div className="flex-1 min-w-0 pr-4">
                <div className="text-sm text-zinc-300">Anti-AI-look negatives</div>
                <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
                  Append a curated list of negative cues (no plastic skin, no airbrushed
                  lighting, no studio backdrop) to every Leonardo / Higgsfield prompt.
                  Helps portraits and product shots feel less rendered. Off by default.
                </p>
              </div>
              <Switch
                checked={settings.antiAiLook === true}
                onChange={(v) => updateSettings({ antiAiLook: v })}
                label="anti-AI-look negatives"
                size="md"
              />
            </div>

            {/* V1.6: agentic Director pipeline — the default path since
                v1.6.0 (shipped opt-in in v1.5.0). Every click stamps
                directorPipelineUserSet so the explicit choice survives
                future default migrations. */}
            <div className="flex items-center justify-between bg-zinc-950/50 p-4 rounded-xl border border-zinc-800/60">
              <div className="flex-1 min-w-0 pr-4">
                <div className="text-sm text-zinc-300">
                  Agentic Director pipeline
                  <span className="ml-2 align-middle text-[10px] uppercase tracking-wide text-[#00e6ff]/90 bg-[#00e6ff]/10 border border-[#00e6ff]/20 rounded px-1.5 py-0.5">
                    default
                  </span>
                </div>
                <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
                  The AI plans each pipeline prompt with a multi-step tool loop
                  (trend search → draft → self-critique → refine) instead of sending
                  the idea verbatim. Needs at least one Content Pillar and a text-AI
                  key (MiniMax / OpenAI); each idea spends a few cents. Falls back to
                  the fast verbatim path automatically if the Director is
                  unavailable. On by default — switch off to always use the fast
                  path.
                </p>
              </div>
              <Switch
                checked={settings.useDirectorPipeline === true}
                onChange={(v) =>
                  updateSettings({ useDirectorPipeline: v, directorPipelineUserSet: true })
                }
                label="the agentic Director pipeline"
                size="md"
              />
            </div>

            {/* V1.0.7-PROMPT-ENG-A3: 14-angle camera picker. Wired
                into the MCSLA C: fragment by hooks/useImageGeneration. */}
            <div className="bg-zinc-950/50 p-4 rounded-xl border border-zinc-800/60">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-zinc-300">Default camera angle</div>
                  <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
                    Pick a single angle to fold into the MCSLA director protocol —
                    lens, tilt, and emotional intent are appended to every prompt.
                  </p>
                </div>
              </div>
              <CameraAnglePicker
                settings={settings}
                value={settings.cameraAngle}
                onChange={(next) => {
                  if (next === undefined) {
                    // V1.1.1-CAMERA-ANGLE-CLEAR: `mergeSettings` strips
                    // undefined patches, so the previous wiring
                    // `updateSettings({ cameraAngle: undefined })` did
                    // nothing. Use the explicit clear primitive from
                    // useSettings to actually drop the key. The
                    // `useImageGeneration` consumer's truthy check
                    // (`settings.cameraAngle ? ...`) then drops the
                    // MCSLA C: fragment on the next render.
                    clearSettings(['cameraAngle']);
                  } else {
                    updateSettings({ cameraAngle: next });
                  }
                }}
              />
            </div>
          </SettingsSection>

          {/* Video Generation Settings */}
          <SettingsSection
            icon={VideoIcon}
            title="Default Video Settings"
            subtitle="Frame count, animation style, and resolution applied to every new video idea."
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-zinc-950/50 p-4 rounded-xl border border-zinc-800/60">
              <div className="space-y-2">
                <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Default Duration</label>
                <select
                  value={settings.defaultAnimationDuration || 5}
                  onChange={(e) => updateSettings({ defaultAnimationDuration: Number(e.target.value) as 5 | 10 })}
                  className="w-full bg-zinc-900 border border-zinc-800/60 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30 cursor-pointer"
                >
                  <option value={5}>5 Seconds</option>
                  <option value={10}>10 Seconds</option>
                </select>
              </div>
              <div className="space-y-2">
                <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Animation Style</label>
                <select
                  value={settings.defaultAnimationStyle || 'DYNAMIC'}
                  onChange={(e) => updateSettings({ defaultAnimationStyle: e.target.value })}
                  className="w-full bg-zinc-900 border border-zinc-800/60 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30 cursor-pointer"
                >
                  <option value="DYNAMIC">Dynamic</option>
                  <option value="STATIC">Static</option>
                  <option value="CINEMATIC">Cinematic</option>
                </select>
              </div>
            </div>

            {/* V1.1.1-MULTI-PROVIDER-VIDEO: per-provider picker.
                Replaces the v1.1.0 single-select "Leonardo Video
                Model" dropdown. The user can check one or more
                providers; the Studio's Animate button fans out to
                all selected ones in parallel. Each provider has
                its own model field so switching providers doesn't
                clobber the others' choice. */}
            <div className="space-y-4 bg-zinc-950/50 p-4 rounded-xl border border-zinc-800/60 mt-4">
              <div>
                <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-2">
                  Active Video Providers
                </label>
                <p className="text-[10px] text-zinc-500 mb-3 leading-relaxed">
                  Pick one or more. The Studio fires parallel
                  submissions to every selected provider and saves
                  all successful results to the gallery.
                </p>
                {(['leonardo', 'minimax', 'higgsfield', 'mmx'] as const).map((p) => {
                  const active = (settings.videoProviders ?? ['minimax']).includes(p);
                  const labels: Record<typeof p, { name: string; cost: string }> = {
                    leonardo: { name: 'Leonardo.AI', cost: '$$$ (credits)' },
                    minimax: { name: 'MiniMax (Hailuo 2.3)', cost: '$ (Token Plan)' },
                    higgsfield: { name: 'Higgsfield MCP', cost: '$$ (credits)' },
                    mmx: { name: 'mmx CLI (Hailuo via shell)', cost: '$ (Token Plan)' },
                  };
                  return (
                    <label key={p} className="flex items-center gap-2 py-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={(e) => {
                          const current = settings.videoProviders ?? ['minimax'];
                          const next = e.target.checked
                            ? Array.from(new Set([...current, p]))
                            : current.filter((x) => x !== p);
                          updateSettings({ videoProviders: next });
                        }}
                        className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-[#c5a062] focus:ring-[#c5a062]"
                      />
                      <span className="text-sm text-zinc-200">{labels[p].name}</span>
                      <span className="text-[10px] text-zinc-500">{labels[p].cost}</span>
                    </label>
                  );
                })}
              </div>

              {/* Per-provider model picker. Renders only for the
                  providers the user has selected, so the UI stays
                  scannable. The mmx picker just defaults to
                  Hailuo 2.3 (mmx is a CLI wrapper around that
                  same model). */}
              {(settings.videoProviders ?? ['minimax']).includes('leonardo') && (
                <div className="space-y-2">
                  <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Leonardo Video Model</label>
                  <select
                    value={settings.defaultVideoModel || 'kling-3.0'}
                    onChange={(e) => updateSettings({ defaultVideoModel: e.target.value })}
                    className="w-full bg-zinc-900 border border-zinc-800/60 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30 cursor-pointer"
                  >
                    <option value="kling-video-o-3">Kling O3 Omni (New)</option>
                    <option value="kling-3.0">Kling 3.0 (Pro Quality)</option>
                    <option value="ray-v2">Ray V2 (High Quality)</option>
                    <option value="ray-v1">Ray V1 (Standard)</option>
                    <option value="seedance-2.0">Seedance 2.0</option>
                    <option value="seedance-2.0-fast">Seedance 2.0 Fast</option>
                    <option value="veo-3.1">Veo 3.1</option>
                    <option value="VEO3_1FAST">Veo 3.1 Fast</option>
                  </select>
                </div>
              )}
              {(settings.videoProviders ?? ['minimax']).includes('minimax') && (
                <div className="space-y-2">
                  <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-wider">MiniMax Video Model</label>
                  <select
                    value={settings.defaultMinimaxVideoModel || 'MiniMax-Hailuo-2.3'}
                    onChange={(e) => updateSettings({ defaultMinimaxVideoModel: e.target.value })}
                    className="w-full bg-zinc-900 border border-zinc-800/60 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30 cursor-pointer"
                  >
                    <option value="MiniMax-Hailuo-2.3">Hailuo 2.3 (Latest, recommended)</option>
                    <option value="MiniMax-Hailuo-02">Hailuo 02 (Mature)</option>
                    <option value="T2V-01-Director">T2V-01 Director</option>
                    <option value="T2V-01">T2V-01</option>
                  </select>
                </div>
              )}
              {(settings.videoProviders ?? ['minimax']).includes('higgsfield') && (
                <p className="text-[10px] text-zinc-500 leading-relaxed">
                  {/* M4 de-dup: this select used to write
                      defaultHiggsfieldVideoModel — the same key the
                      Higgsfield connection card owns. Removed to keep a
                      single source of truth; pick the model in the
                      Higgsfield connection above. */}
                  Higgsfield video model is chosen in the{' '}
                  <span className="text-zinc-400">Higgsfield connection</span> above.
                </p>
              )}
              {(settings.videoProviders ?? ['minimax']).includes('mmx') && (
                <p className="text-[10px] text-zinc-500 leading-relaxed">
                  mmx uses <code className="text-zinc-400">MiniMax-Hailuo-2.3</code> by default. Install the mmx CLI on the server and ensure it is on PATH.
                </p>
              )}
            </div>
          </SettingsSection>
          </>
          )}

          {activeTab === 'aiEngine' && (
          <>
          {/* M3.4-P4-B2: AI System Prompt block (incl. Saved Personalities
              + Trademark Blocklist + Reset button) moved to
              ./Settings/SystemPromptEditor.tsx. The editor owns its
              own local state for the in-flight personality name and
              the trademark-store tick. */}
          <SystemPromptEditor
            settings={settings}
            updateSettings={updateSettings}
            activeAiAgent={activeAiAgent}
          />

          {/* V1.1.1-SKILLS-AUTO-USE: toggle list of [agents.md] skills
              from docs/research/higgsfield-skills/. The list is
              hard-coded here (the loader discovers them on the
              server, but the Settings UI shows the curated set
              we ship with v1.1.1). The user can enable/disable
              each; the active list is forwarded to /api/ai/prompt
              on every stream so the model sees the skill bodies
              as authoritative directives. */}
          <SettingsSection
            icon={Sparkles}
            title="Active Skills"
            subtitle="Auto-inject skill bodies into the system prompt. The Studio will use them as authoritative directives for every generation."
          >
            <div className="space-y-2 bg-zinc-950/50 p-4 rounded-xl border border-zinc-800/60">
              {[
                {
                  name: 'banana-pro-director',
                  label: 'Banana Pro Director (SLCT + Skin Study)',
                  blurb: 'Cinematic direction protocol — Surface, Lumina, Capture, Texture layers. Strong for cinematic realism.',
                },
                {
                  name: 'cinema-world-builder',
                  label: 'Cinema World Builder',
                  blurb: 'World-building and lighting recipes for cinematic scenes.',
                },
              ].map((skill) => {
                const active = (settings.activeSkills ?? ['banana-pro-director']).includes(skill.name);
                return (
                  <label key={skill.name} className="flex items-start gap-2 py-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={(e) => {
                        const current = settings.activeSkills ?? ['banana-pro-director'];
                        const next = e.target.checked
                          ? Array.from(new Set([...current, skill.name]))
                          : current.filter((x) => x !== skill.name);
                        updateSettings({ activeSkills: next });
                      }}
                      className="mt-1 h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-[#c5a062] focus:ring-[#c5a062]"
                    />
                    <div>
                      <div className="text-sm text-zinc-200">{skill.label}</div>
                      <div className="text-[10px] text-zinc-500">{skill.blurb}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          </SettingsSection>
          </>
          )}

          {activeTab === 'desktop' && (
            <>
              {/* Desktop configuration — DesktopSettingsPanel auto-renders
                  nothing on web builds, so a "use the desktop app" hint is
                  rendered in its place when running in the browser. */}
              <DesktopSettingsPanel />
              {isDesktop === false && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <Monitor className="w-4 h-4 text-zinc-500" />
                    <p className="text-xs font-semibold text-white">Desktop-only</p>
                  </div>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    The desktop app stores credentials in <code className="text-zinc-300">config.json</code>, bundles the Higgsfield CLI, and ships with auto-update. Run the Tauri build to access these settings.
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        <div className="p-6 border-t border-zinc-800 bg-zinc-950/50 flex items-center justify-between gap-3">
          <span
            className="text-[10px] text-zinc-500 font-mono select-text"
            title="MashupForge app version"
          >
            v{appVersion}
          </span>
          <button
            onClick={onClose}
            className="btn-blue-sm px-6 py-2 rounded-lg"
          >
            Done
          </button>
        </div>
      </motion.div>
    </div>
  );
}
