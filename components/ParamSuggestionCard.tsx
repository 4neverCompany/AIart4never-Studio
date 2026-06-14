'use client';

import { useEffect, useState } from 'react';
import { Lightbulb, Check, X, Edit3 } from 'lucide-react';
import type {
  ParamSuggestion,
  PerModelSuggestion,
  PerModelImageSuggestion,
  PerModelVideoSuggestion,
} from '@/lib/param-suggest';
import { buildRuleFallbackForModel } from '@/lib/param-suggest';
import { LEONARDO_MODELS, type GenerateOptions } from '@/types/mashup';
import { getModelSpec } from '@/lib/model-specs';

interface Props {
  suggestion: ParamSuggestion;
  availableStyles: { name: string; uuid: string }[];
  /**
   * Apply path. The card hands back BOTH the legacy "shared" options
   * (used to overwrite the global `comparisonOptions`) and the full
   * per-model map so callers can plumb per-model values into per-model
   * state when they have one.
   */
  onApply: (
    modelIds: string[],
    options: Partial<GenerateOptions>,
    perModel: Record<string, PerModelSuggestion>,
  ) => void;
  onDismiss: () => void;
}

/**
 * V030-008-per-model: card now renders one section per shortlisted
 * model with that model's optimal parameters and a 1-2 sentence reason.
 * Edit mode exposes per-model overrides; apply emits both shared
 * options (legacy) and the full per-model map.
 */
export function ParamSuggestionCard({
  suggestion,
  availableStyles,
  onApply,
  onDismiss,
}: Props) {
  const [editMode, setEditMode] = useState(false);
  // Per-model editable state. Cloned from suggestion on first render.
  const [perModel, setPerModel] = useState<Record<string, PerModelSuggestion>>(
    () => structuredClone(suggestion.perModel),
  );
  const [modelIds, setModelIds] = useState<string[]>(() => [...suggestion.modelIds]);

  // Resync local editable state when a fresh suggestion arrives. Without
  // this, the card keeps showing the previous suggestion's modelIds /
  // perModel until the user toggles the card off and on — which is the
  // "press suggest twice" bug.
  //
  // V105.1-REACT-19: setState deferred via queueMicrotask (project
  // convention) so the effect body only triggers a re-sync, not local
  // state updates in the effect body itself.
  useEffect(() => {
    queueMicrotask(() => {
      setPerModel(structuredClone(suggestion.perModel));
      setModelIds([...suggestion.modelIds]);
      setEditMode(false);
    });
  }, [suggestion]);

  const updateImageField = <K extends keyof PerModelImageSuggestion>(
    modelId: string,
    field: K,
    value: PerModelImageSuggestion[K],
  ) => {
    setPerModel(prev => {
      const cur = prev[modelId];
      if (!cur || cur.type !== 'image') return prev;
      return { ...prev, [modelId]: { ...cur, [field]: value } };
    });
  };

  const updateVideoField = <K extends keyof PerModelVideoSuggestion>(
    modelId: string,
    field: K,
    value: PerModelVideoSuggestion[K],
  ) => {
    setPerModel(prev => {
      const cur = prev[modelId];
      if (!cur || cur.type !== 'video') return prev;
      return { ...prev, [modelId]: { ...cur, [field]: value } };
    });
  };

  const toggleModel = (id: string) => {
    setModelIds(prev => {
      if (prev.includes(id)) return prev.filter(m => m !== id);
      setPerModel(p => {
        if (p[id]) return p;
        const fallback = buildRuleFallbackForModel(id, { availableModels: LEONARDO_MODELS });
        return fallback ? { ...p, [id]: fallback } : p;
      });
      return [...prev, id];
    });
  };

  const handleApply = () => {
    // Derive shared options from the first selected model's per-model entry.
    const firstId = modelIds.find(id => perModel[id]);
    const first = firstId ? perModel[firstId] : undefined;
    const shared: Partial<GenerateOptions> = first
      ? first.type === 'image'
        ? {
            aspectRatio: first.aspectRatio,
            imageSize: first.imageSize,
            quality: first.quality,
            promptEnhance: first.promptEnhance,
            style: first.style,
            negativePrompt: first.negativePrompt?.trim() || undefined,
          }
        : {
            aspectRatio: first.aspectRatio,
          }
      : {};
    // Restrict perModel payload to the models the user actually kept.
    // For any toggled-on model without an entry (e.g. toggled before the
    // React state propagated), synthesise a rules-based fallback so the
    // merged payload stays consistent with the card's visible rows.
    const filteredPerModel: Record<string, PerModelSuggestion> = {};
    for (const id of modelIds) {
      const entry =
        perModel[id] ??
        buildRuleFallbackForModel(id, { availableModels: LEONARDO_MODELS }) ??
        undefined;
      if (entry) filteredPerModel[id] = entry;
    }
    onApply(modelIds, shared, filteredPerModel);
  };

  const aspectOptionsImage = ['1:1', '2:3', '3:2', '9:16', '16:9', '3:4', '4:3', '4:5', '5:4'];
  const aspectOptionsVideo = ['1:1', '9:16', '16:9'];
  const sizeOptions: ('1K' | '2K')[] = ['1K', '2K'];
  const qualityOptions: ('LOW' | 'MEDIUM' | 'HIGH')[] = ['LOW', 'MEDIUM', 'HIGH'];

  return (
    <div className="bg-[#0a1a1f]/80 border border-[#00e6ff]/25 rounded-xl p-4 space-y-3 shadow-[0_0_18px_rgba(0,230,255,0.08)]">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-[#00e6ff] uppercase tracking-wider font-medium">
          <Lightbulb className="w-3.5 h-3.5" />
          <span>Per-Model Smart Suggestions</span>
          <span
            className={
              'text-[9px] normal-case tracking-normal px-1.5 py-0.5 rounded border ' +
              (suggestion.source === 'ai'
                ? 'border-[#00e6ff]/40 text-[#9fefff] bg-[#00e6ff]/10'
                : suggestion.source === 'ai+rules'
                  ? 'border-amber-400/30 text-amber-300 bg-amber-400/5'
                  : 'border-zinc-700 text-zinc-400 bg-zinc-800/40')
            }
            title={
              suggestion.source === 'ai'
                ? 'pi.dev authored every per-model suggestion'
                : suggestion.source === 'ai+rules'
                  ? 'pi.dev answered for some models; missing ones were filled from rule-based defaults'
                  : 'Rule-based suggestions — deterministic per-model parameters'
            }
          >
            {suggestion.source === 'ai' ? 'pi' : suggestion.source === 'ai+rules' ? 'pi + rules' : 'rules'}
          </span>
          {suggestion.priorMatchCount > 0 && (
            <span className="text-[10px] text-zinc-500 normal-case tracking-normal">
              — {suggestion.priorMatchCount} prior match{suggestion.priorMatchCount === 1 ? '' : 'es'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setEditMode(e => !e)}
            className="text-[11px] text-zinc-400 hover:text-white flex items-center gap-1 transition-colors"
            title={editMode ? 'Show summary' : 'Override per-model settings'}
          >
            <Edit3 className="w-3 h-3" />
            {editMode ? 'View' : 'Edit'}
          </button>
          <button
            onClick={onDismiss}
            className="text-[11px] text-zinc-500 hover:text-red-400 flex items-center gap-1 transition-colors"
            title="Dismiss"
          >
            <X className="w-3 h-3" />
            Dismiss
          </button>
        </div>
      </div>

      <div className="text-[10px] uppercase tracking-wider text-zinc-500">
        Models — pi tunes parameters per model
      </div>
      <div className="flex flex-wrap gap-1.5">
        {LEONARDO_MODELS.map(m => (
          <button
            key={m.id}
            onClick={() => toggleModel(m.id)}
            className={
              'px-2.5 py-1 rounded-lg border text-[11px] transition-colors ' +
              (modelIds.includes(m.id)
                ? 'bg-[#00e6ff]/15 border-[#00e6ff]/40 text-[#9fefff]'
                : 'bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:text-white')
            }
          >
            {m.name}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {modelIds.map(id => {
          const sug = perModel[id];
          if (!sug) {
            return (
              <div
                key={id}
                className="border border-zinc-800/80 rounded-lg p-3 bg-zinc-950/40 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <div className="text-xs font-medium text-zinc-400">
                    {formatModel(id)}{' '}
                    <span className="text-[10px] text-zinc-600">(no suggestion)</span>
                  </div>
                  <span className="text-[9px] uppercase px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-500 bg-zinc-800/40">
                    rules
                  </span>
                </div>
                <CapabilityBadges modelId={id} />
                <p className="text-[11px] text-zinc-500 italic">
                  No parameters available for this model. Generate anyway with defaults.
                </p>
              </div>
            );
          }
          return (
            <div
              key={id}
              className="border border-zinc-800/80 rounded-lg p-3 bg-zinc-950/40 space-y-2"
            >
              <div className="flex items-center justify-between">
                <div className="text-xs font-medium text-[#9fefff]">
                  {formatModel(id)}{' '}
                  <span className="text-[10px] text-zinc-500 font-normal">
                    ({sug.type})
                  </span>
                </div>
                <span
                  className={
                    'text-[9px] uppercase px-1.5 py-0.5 rounded border ' +
                    (sug.source === 'ai'
                      ? 'border-[#00e6ff]/40 text-[#9fefff] bg-[#00e6ff]/10'
                      : sug.source === 'ai+rules'
                        ? 'border-amber-400/30 text-amber-300 bg-amber-400/5'
                        : 'border-zinc-700 text-zinc-400 bg-zinc-800/40')
                  }
                >
                  {sug.source === 'ai' ? 'pi' : sug.source === 'ai+rules' ? 'pi + rules' : 'rules'}
                </span>
              </div>
              <CapabilityBadges modelId={id} />

              {!editMode ? (
                <div className="space-y-1 text-[11px] text-zinc-300">
                  {sug.type === 'image' ? (
                    <>
                      <ParamLine label="Aspect" value={`${sug.aspectRatio} (${sug.width}×${sug.height})`} />
                      <ParamLine label="Image Size" value={sug.imageSize} />
                      {sug.quality && <ParamLine label="Quality" value={sug.quality} />}
                      <ParamLine label="Prompt Enhance" value={sug.promptEnhance} />
                      {sug.style && <ParamLine label="Style" value={sug.style} />}
                      {sug.negativePrompt && (
                        <ParamLine
                          label="Negative"
                          value={
                            sug.negativePrompt.length > 60
                              ? `${sug.negativePrompt.slice(0, 60)}…`
                              : sug.negativePrompt
                          }
                        />
                      )}
                    </>
                  ) : (
                    <>
                      <ParamLine label="Aspect" value={`${sug.aspectRatio} (${sug.width}×${sug.height})`} />
                      <ParamLine label="Duration" value={`${sug.duration}s`} />
                      <ParamLine label="Mode" value={sug.mode} />
                      {sug.motionHasAudio !== undefined && (
                        <ParamLine label="Audio" value={sug.motionHasAudio ? 'on' : 'off'} />
                      )}
                    </>
                  )}
                  <div className="text-[10px] text-zinc-500 italic pt-1">{sug.reason}</div>
                </div>
              ) : sug.type === 'image' ? (
                <ImageEditor
                  sug={sug}
                  availableStyles={availableStyles}
                  aspectOptions={aspectOptionsImage}
                  sizeOptions={sizeOptions}
                  qualityOptions={qualityOptions}
                  onUpdate={(field, value) => updateImageField(id, field, value)}
                />
              ) : (
                <VideoEditor
                  sug={sug}
                  aspectOptions={aspectOptionsVideo}
                  onUpdate={(field, value) => updateVideoField(id, field, value)}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={handleApply}
          disabled={modelIds.length === 0}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#00e6ff]/15 border border-[#00e6ff]/40 text-[#9fefff] hover:bg-[#00e6ff]/25 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors"
        >
          <Check className="w-3.5 h-3.5" />
          Apply
        </button>
      </div>
    </div>
  );
}

function ParamLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[9px] uppercase tracking-wider text-zinc-500 w-20 shrink-0">
        {label}
      </span>
      <span className="text-zinc-200 break-words">{value}</span>
    </div>
  );
}

function formatModel(id: string): string {
  return LEONARDO_MODELS.find(m => m.id === id)?.name ?? id;
}

function CapabilityBadges({ modelId }: { modelId: string }) {
  const spec = getModelSpec(modelId);
  if (!spec) return null;
  const caps = spec.capabilities;
  const labels: string[] = [];
  if (caps.styles) labels.push('styles');
  if (caps.negativePrompt) labels.push('negative');
  if (caps.imageSize) labels.push('size');
  if (caps.promptEnhance) labels.push('enhance');
  if (caps.audio) labels.push('audio');
  if (caps.startFrame) labels.push('start frame');
  if (caps.endFrame) labels.push('end frame');
  if (caps.imageReference) labels.push('img ref');
  if (caps.videoReference) labels.push('vid ref');
  if (caps.seed) labels.push('seed');
  if (labels.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-[9px] uppercase tracking-wider text-zinc-600">can:</span>
      {labels.map(label => (
        <span
          key={label}
          className="text-[9px] px-1.5 py-0.5 rounded border border-zinc-800 text-zinc-400 bg-zinc-900/40"
        >
          {label}
        </span>
      ))}
    </div>
  );
}

interface ImageEditorProps {
  sug: PerModelImageSuggestion;
  availableStyles: { name: string; uuid: string }[];
  aspectOptions: string[];
  sizeOptions: ('1K' | '2K')[];
  qualityOptions: ('LOW' | 'MEDIUM' | 'HIGH')[];
  onUpdate: <K extends keyof PerModelImageSuggestion>(
    field: K,
    value: PerModelImageSuggestion[K],
  ) => void;
}

function ImageEditor({
  sug,
  availableStyles,
  aspectOptions,
  sizeOptions,
  qualityOptions,
  onUpdate,
}: ImageEditorProps) {
  // V082-PARAM-SCRIPT: capability-aware editor. Each model's structured
  // spec exposes which knobs the API accepts — we hide the rest so the
  // user can't pick a Style for gpt-image-1.5 (which has no style
  // parameter), or a 2K render for a model that ignores it.
  const caps = getModelSpec(sug.modelId)?.capabilities;
  const supportsStyles = caps?.styles !== false;
  const supportsNegativePrompt = caps?.negativePrompt !== false;
  const supportsImageSize = caps?.imageSize !== false;
  const supportsPromptEnhance = caps?.promptEnhance !== false;

  return (
    <div className="grid grid-cols-2 gap-2 text-[11px]">
      <FieldSelect
        label="Aspect Ratio"
        value={sug.aspectRatio}
        options={aspectOptions}
        onChange={v => onUpdate('aspectRatio', v)}
      />
      {supportsImageSize && (
        <FieldSelect
          label="Image Size"
          value={sug.imageSize}
          options={sizeOptions}
          onChange={v => onUpdate('imageSize', v as '1K' | '2K')}
        />
      )}
      {sug.quality !== undefined && (
        <FieldSelect
          label="Quality"
          value={sug.quality}
          options={qualityOptions}
          onChange={v => onUpdate('quality', v as 'LOW' | 'MEDIUM' | 'HIGH')}
        />
      )}
      {supportsPromptEnhance && (
        <FieldSelect
          label="Prompt Enhance"
          value={sug.promptEnhance}
          options={['ON', 'OFF']}
          onChange={v => onUpdate('promptEnhance', v as 'ON' | 'OFF')}
        />
      )}
      {supportsStyles && (
        <div className="col-span-2">
          <FieldSelect
            label="Style"
            value={sug.style ?? ''}
            options={['', ...availableStyles.map(s => s.name)]}
            renderOption={v => (v === '' ? '(none)' : v)}
            onChange={v => onUpdate('style', v === '' ? undefined : v)}
          />
        </div>
      )}
      {supportsNegativePrompt && (
        <div className="col-span-2">
          <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
            Negative Prompt
          </label>
          <input
            type="text"
            value={sug.negativePrompt ?? ''}
            onChange={e => onUpdate('negativePrompt', e.target.value || undefined)}
            placeholder="(optional)"
            className="w-full bg-zinc-900/60 border border-zinc-800 rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-[#00e6ff]/40"
          />
        </div>
      )}
    </div>
  );
}

interface VideoEditorProps {
  sug: PerModelVideoSuggestion;
  aspectOptions: string[];
  onUpdate: <K extends keyof PerModelVideoSuggestion>(
    field: K,
    value: PerModelVideoSuggestion[K],
  ) => void;
}

function VideoEditor({ sug, aspectOptions, onUpdate }: VideoEditorProps) {
  return (
    <div className="grid grid-cols-2 gap-2 text-[11px]">
      <FieldSelect
        label="Aspect Ratio"
        value={sug.aspectRatio}
        options={aspectOptions}
        onChange={v => onUpdate('aspectRatio', v)}
      />
      <div>
        <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
          Duration (s)
        </label>
        <input
          type="number"
          min={3}
          max={15}
          value={sug.duration}
          onChange={e => {
            const n = parseInt(e.target.value, 10);
            if (Number.isFinite(n)) onUpdate('duration', n);
          }}
          className="w-full bg-zinc-900/60 border border-zinc-800 rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-[#00e6ff]/40"
        />
      </div>
      <FieldSelect
        label="Mode"
        value={sug.mode}
        options={['RESOLUTION_720', 'RESOLUTION_1080']}
        onChange={v => onUpdate('mode', v as 'RESOLUTION_720' | 'RESOLUTION_1080')}
      />
      {sug.motionHasAudio !== undefined && (
        <FieldSelect
          label="Audio"
          value={sug.motionHasAudio ? 'on' : 'off'}
          options={['on', 'off']}
          onChange={v => onUpdate('motionHasAudio', v === 'on')}
        />
      )}
    </div>
  );
}

function FieldSelect({
  label,
  value,
  options,
  onChange,
  renderOption,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
  renderOption?: (v: string) => string;
}) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
        {label}
      </label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-zinc-900/60 border border-zinc-800 rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-[#00e6ff]/40"
      >
        {options.map(opt => (
          <option key={opt || '__empty'} value={opt}>
            {renderOption ? renderOption(opt) : opt}
          </option>
        ))}
      </select>
    </div>
  );
}
