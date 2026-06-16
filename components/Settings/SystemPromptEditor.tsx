'use client';

import { useMemo, useState } from 'react';
import { Cpu, Minus, Plus, X } from 'lucide-react';
import {
  DEFAULT_NICHES as RECOMMENDED_NICHES,
  DEFAULT_GENRES as RECOMMENDED_GENRES,
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
 * AGENT.md REWIRE (chat-agent rework): the in-app agent is now a GENUINE
 * intelligent agent driven by the repo-root `AGENT.md` instruction file + the
 * structured canon — NOT a user-edited settings "system prompt". So the old
 * "AI System Prompt" editor (the `agentPrompt` textarea + Saved Personalities +
 * the Reset-to-default-personality button) is GONE: nothing on the agent/chat
 * path reads `settings.agentPrompt` anymore, and showing an editable system
 * prompt would falsely imply it still shapes the agent.
 *
 * What remains here is the still-live operator configuration the AgentConsole
 * and the image pipeline DO consume:
 *   - Content Pillars (`settings.agentNiches`) + Style Tags (`settings.agentGenres`)
 *     — forwarded to the Director loop on every chat turn.
 *   - the Trademark Blocklist — the image retry pipeline's auto-managed
 *     name-swap store + the user's whitelist override.
 *
 * The `settings.agentPrompt` key itself is intentionally left on the type for a
 * later cleanup (the legacy Sidebar + image routes still reference it); it is
 * simply no longer read or shown on the agent path. The component name is kept
 * to avoid churn in `SettingsModal.tsx`'s import.
 */
export interface SystemPromptEditorProps {
  settings: UserSettings;
  updateSettings: (
    patch:
      | Partial<UserSettings>
      | ((prev: UserSettings) => Partial<UserSettings>),
  ) => void;
}

export function SystemPromptEditor({
  settings,
  updateSettings,
}: SystemPromptEditorProps) {
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
      title="Content Pillars & Style Tags"
      subtitle="The canon pillars + styles the AIart4never agent draws on. The agent's persona itself is defined by AGENT.md + the structured canon — not an editable system prompt."
      tone="cyan"
    >
      <div className="space-y-6 bg-zinc-950/50 p-4 rounded-xl border border-zinc-800/60">
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
                className="w-full bg-zinc-900 border border-zinc-800/60 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:ring-2 focus:ring-[#ff7a18]/30"
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
      </div>
    </SettingsSection>
  );
}
