'use client';

import { useState } from 'react';
import { Camera, MessageCircle, Hash, Pin, ExternalLink } from 'lucide-react';
import { useMashup } from '../../MashupContext';

export type OnboardingPlatform = 'instagram' | 'pinterest' | 'twitter' | 'discord';

interface Step1Props {
  /** Currently selected platform; null = none yet. */
  selected: OnboardingPlatform | null;
  onSelect: (p: OnboardingPlatform | null) => void;
  /** True once credentials have been saved for the selected platform. */
  saved: boolean;
  onSaved: (s: boolean) => void;
  /** User explicitly skipped credentialling. */
  onSkip: () => void;
}

const TILES: ReadonlyArray<{
  key: OnboardingPlatform;
  label: string;
  subtitle: string;
  icon: typeof Camera;
  helpUrl: string;
}> = [
  { key: 'instagram', label: 'Instagram', subtitle: 'Photos, carousels, reels', icon: Camera,
    helpUrl: 'https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/get-started' },
  { key: 'pinterest', label: 'Pinterest', subtitle: 'Vertical pins, boards', icon: Pin,
    helpUrl: 'https://developers.pinterest.com/docs/getting-started/introduction/' },
  { key: 'twitter', label: 'Twitter / X', subtitle: 'Single + thread posts', icon: MessageCircle,
    helpUrl: 'https://developer.twitter.com/en/docs/authentication/oauth-1-0a' },
  { key: 'discord', label: 'Discord', subtitle: 'Webhook to a channel', icon: Hash,
    helpUrl: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks' },
];

/**
 * Step 1 — pick a platform + fill credentials. Real test-connection
 * endpoints don't exist yet (PROP); we do presence-check validation
 * and write straight to settings.apiKeys. The "Test connection"
 * button reads "Save credentials" so we don't oversell behavior we
 * don't have.
 */
export function Step1Platform({ selected, onSelect, saved, onSaved, onSkip }: Step1Props) {
  const { settings, updateSettings } = useMashup();

  // Local form state per platform — kept here so unmount/remount of
  // the credential form doesn't lose typing while the user toggles
  // tiles. Intentionally not persisted across wizard sessions.
  const [igToken, setIgToken] = useState(settings.apiKeys.instagram?.accessToken || '');
  const [igAccountId, setIgAccountId] = useState(settings.apiKeys.instagram?.igAccountId || '');
  const [twAppKey, setTwAppKey] = useState(settings.apiKeys.twitter?.appKey || '');
  const [twAppSecret, setTwAppSecret] = useState(settings.apiKeys.twitter?.appSecret || '');
  const [twAccessToken, setTwAccessToken] = useState(settings.apiKeys.twitter?.accessToken || '');
  const [twAccessSecret, setTwAccessSecret] = useState(settings.apiKeys.twitter?.accessSecret || '');
  const [piToken, setPiToken] = useState(settings.apiKeys.pinterest?.accessToken || '');
  const [piBoardId, setPiBoardId] = useState(settings.apiKeys.pinterest?.boardId || '');
  const [discordHook, setDiscordHook] = useState(settings.apiKeys.discordWebhook || '');

  function handleSelect(key: OnboardingPlatform) {
    if (selected !== key) onSaved(false);
    onSelect(key);
  }

  function handleSave() {
    if (!selected) return;
    if (selected === 'instagram') {
      updateSettings({
        apiKeys: { ...settings.apiKeys, instagram: { accessToken: igToken.trim(), igAccountId: igAccountId.trim() } },
      });
    } else if (selected === 'twitter') {
      updateSettings({
        apiKeys: { ...settings.apiKeys, twitter: {
          appKey: twAppKey.trim(), appSecret: twAppSecret.trim(),
          accessToken: twAccessToken.trim(), accessSecret: twAccessSecret.trim(),
        } },
      });
    } else if (selected === 'pinterest') {
      updateSettings({
        apiKeys: { ...settings.apiKeys, pinterest: { accessToken: piToken.trim(), boardId: piBoardId.trim() || undefined } },
      });
    } else if (selected === 'discord') {
      updateSettings({
        apiKeys: { ...settings.apiKeys, discordWebhook: discordHook.trim() },
      });
    }
    onSaved(true);
  }

  function isFormValid(): boolean {
    if (!selected) return false;
    if (selected === 'instagram') return igToken.trim().length > 0 && igAccountId.trim().length > 0;
    if (selected === 'twitter') return twAppKey.trim().length > 0 && twAppSecret.trim().length > 0
      && twAccessToken.trim().length > 0 && twAccessSecret.trim().length > 0;
    if (selected === 'pinterest') return piToken.trim().length > 0;
    if (selected === 'discord') return discordHook.trim().length > 0;
    return false;
  }

  const tile = selected ? TILES.find((t) => t.key === selected) : null;

  return (
    <div className="space-y-6">
      <div>
        <h3 id="onboarding-title" className="text-xl font-bold text-white">Where do you post?</h3>
        <p className="text-sm text-zinc-400 mt-1">Pick one to get started. You can add more later.</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {TILES.map((t) => {
          const Icon = t.icon;
          const isSel = selected === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => handleSelect(t.key)}
              className={`aspect-[3/2] rounded-xl border p-4 text-left transition-colors flex flex-col justify-between ${
                isSel
                  ? 'border-[#c5a062] bg-[#c5a062]/5 ring-2 ring-[#c5a062]/30'
                  : 'border-zinc-800 hover:border-[#c5a062]/40'
              }`}
            >
              <Icon className={`w-6 h-6 ${isSel ? 'text-[#c5a062]' : 'text-zinc-300'}`} />
              <div>
                <div className={`text-sm font-bold ${isSel ? 'text-white' : 'text-zinc-200'}`}>{t.label}</div>
                <div className="text-xs text-zinc-500 mt-0.5">{t.subtitle}</div>
              </div>
            </button>
          );
        })}
      </div>

      {tile && (
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-bold text-zinc-100">{tile.label} credentials</h4>
            <a
              href={tile.helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[#c5a062] hover:underline inline-flex items-center gap-1"
            >
              Where do I find these? <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          {selected === 'instagram' && (
            <>
              <Field label="Access Token" value={igToken} onChange={setIgToken} type="password" />
              <Field label="Instagram Account ID" value={igAccountId} onChange={setIgAccountId} />
            </>
          )}
          {selected === 'twitter' && (
            <>
              <Field label="App Key" value={twAppKey} onChange={setTwAppKey} />
              <Field label="App Secret" value={twAppSecret} onChange={setTwAppSecret} type="password" />
              <Field label="Access Token" value={twAccessToken} onChange={setTwAccessToken} type="password" />
              <Field label="Access Secret" value={twAccessSecret} onChange={setTwAccessSecret} type="password" />
            </>
          )}
          {selected === 'pinterest' && (
            <>
              <Field label="Access Token" value={piToken} onChange={setPiToken} type="password" />
              <Field label="Board ID (optional)" value={piBoardId} onChange={setPiBoardId} />
            </>
          )}
          {selected === 'discord' && (
            <Field label="Webhook URL" value={discordHook} onChange={setDiscordHook} />
          )}

          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={!isFormValid()}
              className="px-3 py-1.5 text-xs bg-[#c5a062] hover:bg-[#d4b478] disabled:opacity-40 disabled:cursor-not-allowed text-zinc-950 font-medium rounded-lg transition-colors"
            >
              {saved ? 'Saved ✓' : 'Save credentials'}
            </button>
            <button
              type="button"
              onClick={onSkip}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              I&apos;ll do this later — let me explore first
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label, value, onChange, type = 'text',
}: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wide text-zinc-400 block mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:border-[#c5a062]/60 focus:outline-none"
      />
    </div>
  );
}
