'use client';

import { useMemo, useState } from 'react';
import {
  Check,
  Cpu,
  FolderOpen,
  Minus,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import {
  DEFAULT_NICHES as RECOMMENDED_NICHES,
  DEFAULT_GENRES as RECOMMENDED_GENRES,
  buildDefaultAgentPrompt,
} from '@/lib/agent-prompt';
import {
  getAllBlocked,
  getBlockedByModel,
  getAllUserWhitelisted,
  addUserWhitelist,
  removeUserWhitelist,
} from '@/lib/trademark-outcomes';
import type { UserSettings } from '@/types/mashup';
import { SettingsSection } from './SettingsSection';

/**
 * M3.4-P4-B2: AI System Prompt + Personalities + Trademark
 * Blocklist, extracted from `components/SettingsModal.tsx`.
 *
 * Owns its own local state for the in-flight "Save personality" name
 * input and the trademark-store tick (which forces a re-read of the
 * persistent blocklist on every whitelist/blacklist mutation). The
 * `settings` and `updateSettings` pair flows through unchanged —
 * this component never reaches into the parent modal's state, so
 * swapping it back in is a one-line change in SettingsModal.
 *
 * The `activeAiAgent` prop is used to swap the "Restart pi" hint
 * text after the textarea. With the v3.3 default-flip the value is
 * always `'vercel-ai'`; the `'pi'` branch is left in place for
 * older payloads during the migration window.
 */
export interface SystemPromptEditorProps {
  settings: UserSettings;
  updateSettings: (
    patch:
      | Partial<UserSettings>
      | ((prev: UserSettings) => Partial<UserSettings>),
  ) => void;
  activeAiAgent: 'vercel-ai' | 'pi' | undefined;
}

export function SystemPromptEditor({
  settings,
  updateSettings,
  activeAiAgent,
}: SystemPromptEditorProps) {
  // Inline personality-save input — replaces the blocking prompt() dialog.
  const [personalityName, setPersonalityName] = useState<string | null>(null);

  // TRADEMARK-STAGED-PIPELINE (2026-05-22): bump on every blocklist /
  // whitelist mutation. The store lives in localStorage; this tick
  // forces the next render to re-read it.
  const [trademarkStoreTick, setTrademarkStoreTick] = useState(0);
  const bumpTrademarkStore = () => setTrademarkStoreTick((t) => t + 1);
  // The trademark store lives in localStorage; bumping the tick forces
  // a re-read on mutation. The lint rule can't see the read-through dep.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const trademarkBlocklist = useMemo(() => getAllBlocked(), [trademarkStoreTick]);
  // BUG-FIX-2026-06-06: per-model breakdown of the blocklist.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const trademarkBlockedByModel = useMemo(() => getBlockedByModel(), [trademarkStoreTick]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const trademarkWhitelist = useMemo(() => getAllUserWhitelisted(), [trademarkStoreTick]);

  return (
    <SettingsSection
      icon={Cpu}
      title="AI System Prompt"
      subtitle="Shapes every AI interaction: idea generation, prompt enhancement, captions, and parameter selection."
      tone="cyan"
    >
      <div className="space-y-6 bg-zinc-950/50 p-4 rounded-xl border border-zinc-800/60">
        <div className="space-y-2">
          <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider">System Prompt</label>
          <textarea
            value={settings.agentPrompt}
            onChange={(e) => updateSettings({ agentPrompt: e.target.value })}
            placeholder="Define who the AI is, how it speaks, and what it focuses on..."
            className="w-full bg-zinc-900 border border-zinc-800/60 rounded-xl px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30 min-h-[220px] resize-y leading-relaxed font-mono"
          />
          <p className="text-[10px] text-zinc-500 leading-tight">
            {activeAiAgent === 'vercel-ai'
              ? 'This prompt shapes every AI interaction: idea generation, prompt enhancement, captions, and parameter selection. Changes apply immediately to the active Vercel.ai backend.'
              : 'This prompt shapes every AI interaction: idea generation, prompt enhancement, captions, and parameter selection. Applied to every pi request on top of the mode directive. Restart pi (Settings → Pi.dev AI Engine → Stop + Start) after editing.'}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider">Content Pillars</label>
              <div className="flex flex-wrap gap-2 mb-2">
                {settings.agentNiches?.map((n) => (
                  <span
                    key={n}
                    className="px-2 py-1 bg-[#00e6ff]/10 text-[#00e6ff] text-[10px] rounded-lg border border-[#00e6ff]/20 flex items-center gap-1 group"
                  >
                    {n}
                    <button
                      onClick={() => updateSettings({ agentNiches: settings.agentNiches?.filter((t) => t !== n) })}
                      className="text-[#00e6ff] hover:text-red-400 transition-all"
                    >
                      <Minus className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
              <input
                type="text"
                placeholder="Add custom niche..."
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const val = e.currentTarget.value.trim();
                    if (val && !settings.agentNiches?.includes(val)) {
                      updateSettings({ agentNiches: [...(settings.agentNiches || []), val] });
                      e.currentTarget.value = '';
                    }
                  }
                }}
                className="w-full bg-zinc-900 border border-zinc-800/60 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:ring-2 focus:ring-[#00e6ff]/30"
              />
              <div className="pt-2">
                <p className="text-[10px] text-zinc-500 mb-2 uppercase tracking-tight font-semibold">Recommended Niches</p>
                <div className="flex flex-wrap gap-1.5">
                  {RECOMMENDED_NICHES.filter((n) => !settings.agentNiches?.includes(n)).map((n) => (
                    <button
                      key={n}
                      onClick={() => updateSettings({ agentNiches: [...(settings.agentNiches || []), n] })}
                      className="px-2 py-1 bg-zinc-900 hover:bg-zinc-800 text-zinc-500 hover:text-[#00e6ff] text-[9px] rounded-xl border border-zinc-800/60 transition-all flex items-center gap-1"
                    >
                      <Plus className="w-2 h-2" />
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider">Style Tags</label>
              <div className="flex flex-wrap gap-2 mb-2">
                {settings.agentGenres?.map((g) => (
                  <span
                    key={g}
                    className="px-2 py-1 bg-[#00e6ff]/10 text-[#00e6ff] text-[10px] rounded-lg border border-[#00e6ff]/20 flex items-center gap-1 group"
                  >
                    {g}
                    <button
                      onClick={() => updateSettings({ agentGenres: settings.agentGenres?.filter((t) => t !== g) })}
                      className="text-[#00e6ff] hover:text-red-400 transition-all"
                    >
                      <Minus className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
              <input
                type="text"
                placeholder="Add custom genre..."
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const val = e.currentTarget.value.trim();
                    if (val && !settings.agentGenres?.includes(val)) {
                      updateSettings({ agentGenres: [...(settings.agentGenres || []), val] });
                      e.currentTarget.value = '';
                    }
                  }
                }}
                className="w-full bg-zinc-900 border border-zinc-800/60 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:ring-2 focus:ring-[#c5a062]/30"
              />
              <div className="pt-2">
                <p className="text-[10px] text-zinc-500 mb-2 uppercase tracking-tight font-semibold">Recommended Genres</p>
                <div className="flex flex-wrap gap-1.5">
                  {RECOMMENDED_GENRES.filter((g) => !settings.agentGenres?.includes(g)).map((g) => (
                    <button
                      key={g}
                      onClick={() => updateSettings({ agentGenres: [...(settings.agentGenres || []), g] })}
                      className="px-2 py-1 bg-zinc-900 hover:bg-zinc-800 text-zinc-500 hover:text-[#00e6ff] text-[9px] rounded-xl border border-zinc-800/60 transition-all flex items-center gap-1"
                    >
                      <Plus className="w-2 h-2" />
                      {g}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Saved Personalities */}
        <div className="space-y-4 pt-4 border-t border-zinc-800/50">
          <div className="flex items-center justify-between">
            <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider">Saved Personalities</label>
            {personalityName === null ? (
              <button
                onClick={() => setPersonalityName('')}
                className="text-[10px] text-[#00e6ff] hover:text-[#33eaff] flex items-center gap-1 transition-colors"
              >
                <Save className="w-3 h-3" />
                Save Current
              </button>
            ) : (
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  type="text"
                  value={personalityName}
                  onChange={(e) => setPersonalityName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && personalityName.trim()) {
                      updateSettings({
                        savedPersonalities: [
                          ...(settings.savedPersonalities || []),
                          {
                            id: `p-${Date.now()}`,
                            name: personalityName.trim(),
                            prompt: settings.agentPrompt || '',
                            niches: settings.agentNiches || [],
                            genres: settings.agentGenres || [],
                          },
                        ],
                      });
                      setPersonalityName(null);
                    }
                    if (e.key === 'Escape') setPersonalityName(null);
                  }}
                  placeholder="Personality name…"
                  className="text-[10px] bg-zinc-900 border border-zinc-700 rounded px-2 py-0.5 text-zinc-200 w-28 focus:outline-none focus:ring-1 focus:ring-[#00e6ff]/40"
                />
                <button
                  disabled={!personalityName.trim()}
                  onClick={() => {
                    if (!personalityName.trim()) return;
                    updateSettings({
                      savedPersonalities: [
                        ...(settings.savedPersonalities || []),
                        {
                          id: `p-${Date.now()}`,
                          name: personalityName.trim(),
                          prompt: settings.agentPrompt || '',
                          niches: settings.agentNiches || [],
                          genres: settings.agentGenres || [],
                        },
                      ],
                    });
                    setPersonalityName(null);
                  }}
                  className="text-[10px] text-emerald-400 hover:text-emerald-300 disabled:opacity-40 transition-colors"
                >
                  <Check className="w-3 h-3" />
                </button>
                <button
                  onClick={() => setPersonalityName(null)}
                  className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2 max-h-[200px] overflow-y-auto pr-2 custom-scrollbar">
            {settings.savedPersonalities?.map((p) => (
              <div key={p.id} className="flex items-center justify-between bg-zinc-900/50 border border-zinc-800/60 rounded-xl p-3 group">
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-white">{p.name}</span>
                  <span className="text-[10px] text-zinc-500">{p.niches.length} Niches • {p.genres.length} Genres</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => updateSettings({
                      agentPrompt: p.prompt,
                      agentNiches: p.niches,
                      agentGenres: p.genres,
                    })}
                    className="p-2 bg-[#00e6ff]/10 text-[#00e6ff] hover:bg-[#00e6ff]/20 rounded-lg transition-all"
                    title="Load Personality"
                  >
                    <FolderOpen className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => updateSettings({
                      savedPersonalities: settings.savedPersonalities?.filter((pers) => pers.id !== p.id),
                    })}
                    className="p-2 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
            {(!settings.savedPersonalities || settings.savedPersonalities.length === 0) && (
              <div className="text-center py-4 border border-dashed border-zinc-800 rounded-xl">
                <p className="text-xs text-zinc-500 italic">No saved personalities yet.</p>
              </div>
            )}
          </div>
        </div>

        {/* TRADEMARK-STAGED-PIPELINE (2026-05-22): visibility +
            control surface for the auto-managed blocklist. Auto-
            blocked names come from Leonardo TRADEMARK errors
            observed in past runs; whitelist is a hard override
            the user controls. */}
        <div className="space-y-4 pt-4 border-t border-zinc-800/50">
          <div>
            <label className="block text-xs font-bold text-zinc-500 uppercase tracking-wider">Trademark Blocklist</label>
            <p className="text-[10px] text-zinc-500 leading-tight mt-1">
              Names Leonardo has rejected in the past. The retry pipeline swaps these on stage 2/3 of a TRADEMARK block. Whitelist a name to let it pass verbatim.
            </p>
          </div>

          <div className="space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Auto-blocked ({trademarkBlocklist.length})</div>
            {trademarkBlocklist.length === 0 ? (
              <div className="text-center py-3 border border-dashed border-zinc-800 rounded-xl">
                <p className="text-[10px] text-zinc-500 italic">No auto-blocked names yet.</p>
              </div>
            ) : (
              <>
                {/* BUG-FIX-2026-06-06: per-model breakdown. If the
                    store has at least one modelId key, render the
                    grouped view (shows which model blocks which
                    names); otherwise fall back to a flat list. */}
                {Object.keys(trademarkBlockedByModel).length > 0 ? (
                  <div className="space-y-3">
                    {Object.entries(trademarkBlockedByModel).map(([modelId, names]) => (
                      <div key={modelId} className="space-y-1">
                        <div className="text-[9px] font-mono text-zinc-600 uppercase tracking-wider">
                          {modelId} ({names.length})
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {names.map((name) => (
                            <span key={`${modelId}:${name}`} className="inline-flex items-center gap-1 px-2 py-1 bg-red-500/10 text-red-300 text-[10px] rounded-xl border border-red-500/30">
                              {name}
                              <button
                                type="button"
                                onClick={() => { addUserWhitelist(name); bumpTrademarkStore(); }}
                                title={`Whitelist "${name}" (let it pass on next attempt across all models)`}
                                className="ml-1 text-[9px] uppercase tracking-wider text-emerald-300 hover:text-emerald-200"
                              >
                                Whitelist
                              </button>
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {trademarkBlocklist.map((name) => (
                      <span key={name} className="inline-flex items-center gap-1 px-2 py-1 bg-red-500/10 text-red-300 text-[10px] rounded-xl border border-red-500/30">
                        {name}
                        <button
                          type="button"
                          onClick={() => { addUserWhitelist(name); bumpTrademarkStore(); }}
                          title="Whitelist this name (let it pass on next attempt)"
                          className="ml-1 text-[9px] uppercase tracking-wider text-emerald-300 hover:text-emerald-200"
                        >
                          Whitelist
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">User-whitelisted ({trademarkWhitelist.length})</div>
            {trademarkWhitelist.length === 0 ? (
              <div className="text-center py-3 border border-dashed border-zinc-800 rounded-xl">
                <p className="text-[10px] text-zinc-500 italic">No whitelisted names yet.</p>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {trademarkWhitelist.map((name) => (
                  <span key={name} className="inline-flex items-center gap-1 px-2 py-1 bg-emerald-500/10 text-emerald-300 text-[10px] rounded-xl border border-emerald-500/30">
                    {name}
                    <button
                      type="button"
                      onClick={() => { removeUserWhitelist(name); bumpTrademarkStore(); }}
                      title="Remove from whitelist (let auto-block take over again)"
                      className="ml-1"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <button
          onClick={() => {
            // V080-DES-003: build the prompt against the user's
            // CURRENT niches/genres (or curated defaults if they
            // have nothing selected) so Reset doesn't quietly
            // overwrite their personalisation with a hardcoded
            // franchise list. The runtime call sites then append
            // the live tag list on every request.
            const niches = (settings.agentNiches && settings.agentNiches.length > 0)
              ? settings.agentNiches
              : [...RECOMMENDED_NICHES];
            const genres = (settings.agentGenres && settings.agentGenres.length > 0)
              ? settings.agentGenres
              : [...RECOMMENDED_GENRES];
            updateSettings({
              agentPrompt: buildDefaultAgentPrompt({ niches, genres }),
              agentNiches: niches,
              agentGenres: genres,
            });
          }}
          className="w-full py-3 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white rounded-xl font-bold transition-all border border-zinc-800/60 flex items-center justify-center gap-2 text-[10px] uppercase tracking-widest"
        >
          <RefreshCw className="w-3 h-3" />
          Reset to Default Agent Personality
        </button>
      </div>
    </SettingsSection>
  );
}
