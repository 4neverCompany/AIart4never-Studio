'use client';

/**
 * V082 — Vercel AI SDK model picker for the AI Engine settings tab.
 *
 * Mirrors the nca model picker (SettingsModal lines ~1126) but for
 * the vercel-ai backend. Reads the model catalog from
 * `/api/ai/models` (server-side rendered with env-var availability
 * flags), renders each entry as a radio-style row with family /
 * generation / context window / recommended use case, and writes
 * the user's selection to:
 *   1. `settings.activeTextModel` (preferred — per-user, persisted to IDB)
 *   2. `process.env.NEXT_PUBLIC_VERCEL_AI_MODEL` for the client
 *   3. (the server also honours VERCEL_AI_MODEL if set, but that's
 *      a global override — Settings writes the per-user one)
 *
 * Unavailable models (provider's env-var API key not set on the
 * server) are still rendered but greyed out, with a hint pointing
 * at the env var name. The user can pre-pick a model in the UI; the
 * next /api/ai/prompt call will 503 if the env var is still unset,
 * matching the current behaviour of "Vercel.ai unavailable" banner.
 */

import { useEffect, useState, useCallback } from 'react';
import { Sparkles, Cpu, Zap, AlertCircle, Check, Loader2 } from 'lucide-react';
import {
  type TextModelCatalogEntry,
  getDefaultTextModelForProvider,
} from '@/lib/text-model-catalog';

interface CatalogEntryDto extends TextModelCatalogEntry {
  available: boolean;
  envKeyName: string | null;
}

interface ModelsResponse {
  models: CatalogEntryDto[];
  envKeys: { minimax: boolean; openai: boolean };
}

interface VercelAiModelPickerProps {
  /**
   * Currently selected model id, from `settings.activeTextModel` or
   * a sensible default if unset.
   */
  selected: string | null;
  /**
   * Called when the user picks a new model. The parent persists the
   * selection to `settings.activeTextModel`.
   */
  onSelect: (modelId: string) => void;
  /**
   * Whether the user has interacted with the picker. Used to
   * distinguish "user explicitly chose X" from "user accepted default".
   */
  saving?: boolean;
}

const PROVIDER_LABEL: Record<string, string> = {
  minimax: 'MiniMax',
  openai: 'OpenAI',
};

const PROVIDER_COLOR: Record<string, string> = {
  minimax: 'text-amber-300',
  openai: 'text-emerald-300',
};

const MODE_LABEL: Record<string, string> = {
  chat: 'chat',
  generate: 'image prompts',
  idea: 'ideas',
  enhance: 'prompt enhance',
  caption: 'captions',
  tag: 'hashtags',
  'negative-prompt': 'negatives',
  'collection-info': 'collection info',
};

export function VercelAiModelPicker({
  selected,
  onSelect,
  saving,
}: VercelAiModelPickerProps) {
  const [data, setData] = useState<ModelsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ai/models', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ModelsResponse;
      setData(json);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load models');
    } finally {
      setLoading(false);
    }
  }, []);

  // V105.1-REACT-19: refresh is called via queueMicrotask (project
  // convention) so the effect body only triggers a re-fetch, not local
  // state in the body itself.
  useEffect(() => {
    queueMicrotask(() => void refresh());
  }, [refresh]);

  if (loading && !data) {
    return (
      <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-4 text-[11px] text-zinc-500">
        Loading model catalog…
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-[11px] text-red-300 flex items-start gap-2">
        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="flex-1">
          <p className="font-medium">Could not load model catalog</p>
          <p className="text-red-300/80 mt-0.5">{error}</p>
          <button
            onClick={() => void refresh()}
            className="mt-2 px-2 py-1 text-[10px] bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  // Group entries by provider for the picker layout. Within each
  // provider, newer generations go first (catalog is already in
  // display order so a flat filter is fine).
  const grouped = data.models.reduce<Record<string, CatalogEntryDto[]>>(
    (acc, m) => {
      (acc[m.provider] ||= []).push(m);
      return acc;
    },
    {},
  );
  const providerOrder = Object.keys(grouped);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono">
          Model
        </p>
        <div className="flex items-center gap-2">
          {/* V082: subtle "saved" indicator. The user picked a model;
              the IDB write goes through useSettings' 300ms debounce.
              Show a brief ✓ so the user knows their pick took, and
              fade it after 1.5s. This is purely visual feedback —
              not a real loading state. */}
          {saving && (
            <span
              data-testid="model-saved-indicator"
              className="inline-flex items-center gap-1 text-[10px] text-[#00e6ff] font-mono"
            >
              <Loader2 className="w-2.5 h-2.5 animate-spin" aria-hidden="true" />
              saving…
            </span>
          )}
          <button
            onClick={() => void refresh()}
            disabled={loading}
            className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {providerOrder.map((provider) => {
          const entries = grouped[provider];
          const providerLabel = PROVIDER_LABEL[provider] ?? provider;
          const providerColor = PROVIDER_COLOR[provider] ?? 'text-zinc-300';
          const anyAvailable = entries.some((e) => e.available);
          return (
            <fieldset key={provider} className="space-y-1.5">
              <legend className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.16em] text-zinc-500">
                <Cpu className={`w-3 h-3 ${providerColor}`} aria-hidden="true" />
                <span className={providerColor}>{providerLabel}</span>
                <span className="text-zinc-700">·</span>
                <span>{entries.length} models</span>
                {!anyAvailable && (
                  <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-300 text-[9px] font-mono uppercase tracking-wider">
                    <AlertCircle className="w-2.5 h-2.5" aria-hidden="true" />
                    no key
                  </span>
                )}
              </legend>
              <div className="space-y-1.5">
                {entries.map((m) => {
                  const id = `vercel-ai-model-${provider}-${m.modelId}`;
                  const checked = selected === m.modelId;
                  const isThisSaving = saving && checked;
                  return (
                    <label
                      key={id}
                      htmlFor={id}
                      className={`flex items-start gap-2.5 px-3 py-2.5 rounded-lg border transition-colors cursor-pointer ${
                        !m.available
                          ? 'border-zinc-800/60 bg-zinc-900/30 opacity-50 cursor-not-allowed'
                          : checked
                          ? 'bg-[#c5a062]/10 border-[#c5a062]/40'
                          : 'border-zinc-800/60 hover:border-zinc-700 hover:bg-zinc-900/40'
                      }`}
                      title={
                        m.available
                          ? `${m.description}\n\nContext: ${m.contextWindow.toLocaleString()} tokens\nDefault max output: ${m.defaultMaxTokens.toLocaleString()} tokens`
                          : `Set ${m.envKeyName ?? 'the API key'} on the server to use this model.`
                      }
                    >
                      <input
                        id={id}
                        type="radio"
                        name="vercel-ai-model"
                        value={m.modelId}
                        checked={checked}
                        disabled={!m.available || !!saving}
                        onChange={() => onSelect(m.modelId)}
                        className="mt-0.5 accent-[#c5a062]"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-[12px] text-white">
                            {m.modelId}
                          </span>
                          {m.isDefault && (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-[9px] font-mono uppercase tracking-wider">
                              <Check className="w-2.5 h-2.5" aria-hidden="true" />
                              Default
                            </span>
                          )}
                          {m.isHighspeed && (
                            <span
                              data-testid={`highspeed-${m.modelId}`}
                              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-300 text-[9px] font-mono uppercase tracking-wider"
                            >
                              <Zap className="w-2.5 h-2.5" aria-hidden="true" />
                              Fast
                            </span>
                          )}
                          {m.isDefault && (
                            <Sparkles className="w-3 h-3 text-emerald-400" aria-hidden="true" />
                          )}
                        </div>
                        <p className="text-[10.5px] text-zinc-400 mt-0.5 leading-relaxed">
                          {m.description}
                        </p>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1 text-[9.5px] font-mono text-zinc-500">
                          <span>{m.contextWindow.toLocaleString()} ctx</span>
                          <span className="text-zinc-700">·</span>
                          <span>{m.defaultMaxTokens.toLocaleString()} out</span>
                          <span className="text-zinc-700">·</span>
                          <span>temp {m.defaultTemperature}</span>
                          <span className="text-zinc-700">·</span>
                          <span>
                            for {m.recommendedFor.slice(0, 4).map((m) => MODE_LABEL[m] ?? m).join(', ')}
                            {m.recommendedFor.length > 4 ? '…' : ''}
                          </span>
                        </div>
                        {!m.available && m.envKeyName && (
                          <p className="text-[10px] text-amber-300/80 mt-1 font-mono">
                            Set <code className="bg-amber-500/10 px-1 rounded">{m.envKeyName}</code> on the server to enable.
                          </p>
                        )}
                      </div>
                      {isThisSaving && (
                        <span className="text-[10px] text-[#c5a062] self-center shrink-0">
                          Saving…
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Resolve a sensible default for the vercel-ai model when the user
 * hasn't yet picked one. Falls back to the first MiniMax model in
 * the catalog (which is the latest generation, M3).
 */
export function defaultVercelAiModel(): string {
  return (
    getDefaultTextModelForProvider('minimax') ||
    getDefaultTextModelForProvider('openai') ||
    'MiniMax-M3'
  );
}
