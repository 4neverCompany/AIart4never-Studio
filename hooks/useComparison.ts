'use client';

import { useState } from 'react';
// v1.8.1: the wipe-safe persistence machinery (dirty/loadInFlight/
// hydratedOnce gating, lazy load) now lives in usePersistentStore — see
// BUG-DEV-012 / V1.4.7-COMPARISON-WIPE. comparisonResults persists through
// it (REPLACE-on-load, immediate gated write, no localStorage mirror).
import { usePersistentStore } from './usePersistentStore';
import { enhancePromptForModel } from '@/lib/modelOptimizer';
import { buildEnhancedPrompt } from '@/lib/image-prompt-builder';
import { streamAIToString } from '@/lib/aiClient';
import { buildModerationRewriteInstruction } from './useImageGeneration';
import { extractTrademarkNames } from '@/lib/extract-trademark-names';
import { planStagedSubstitution, setOutcome } from '@/lib/trademark-outcomes';
import { getErrorMessage } from '@/lib/errors';
import {
  type GeneratedImage,
  type GenerateOptions,
  type UserSettings,
  type WatermarkSettings,
  LEONARDO_MODELS,
  getLeonardoDimensions,
} from '../types/mashup';
// V1.7.0-PIPELINE-HIGGSFIELD: unified registry (provider lookup) + the
// shared Higgsfield submit so the comparison/pipeline path can route a
// `higgsfield:<slug>` model id to the real backend instead of silently
// falling back to Leonardo.
import { getImageModel } from '../lib/image-models';
import { submitHiggsfieldImageShared } from '../lib/higgsfield/submit-image';

function getModelName(id: string) {
  return LEONARDO_MODELS.find(m => m.id === id)?.name || getImageModel(id)?.name || id;
}

interface UseComparisonDeps {
  settings: UserSettings;
  saveImage: (img: GeneratedImage) => void;
  applyWatermark: (baseImageSrc: string, wm: WatermarkSettings, channelName?: string) => Promise<string>;
}

export interface CachedEnhancement {
  prompt?: string;
  style?: string;
  aspectRatio?: string;
  negativePrompt?: string;
}

export function useComparison({ settings, saveImage, applyWatermark }: UseComparisonDeps) {
  // V1.4.7-COMPARISON-WIPE → v1.8.1: comparisonResults persistence + the
  // dirty/loadInFlight/hydratedOnce wipe-safety gating now live in the
  // shared usePersistentStore. REPLACE-on-load (`loaded ?? prev` — a
  // deleted result must NOT be resurrected by a stale in-memory copy, and
  // an absent store keeps the current value, exactly as the old
  // `if (idb) setComparisonResults(idb)` did); immediate (non-debounced)
  // gated write; no localStorage mirror. The hydratedOnceRef gate is a
  // v1.8.1 hardening over the old bare-catch{} load: a thrown read now
  // latches and refuses writes for the session, instead of letting a later
  // mutation overwrite the intact store with just that mutation.
  const store = usePersistentStore<GeneratedImage[]>({
    key: 'mashup_comparison_results',
    initial: [],
    merge: (loaded, prev) => loaded ?? prev,
  });
  // Aliases so the generation logic below reads exactly as before.
  const comparisonResults = store.value;
  const setComparisonResults = store.setValue;
  const markDirty = store.markDirty;

  const [comparisonPrompt, setComparisonPrompt] = useState('');
  const [comparisonOptions, setComparisonOptions] = useState<GenerateOptions>({
    aspectRatio: '1:1',
    imageSize: '1K',
    negativePrompt: ''
  });
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState('');
  const [comparisonError, setComparisonError] = useState<string | null>(null);

  const clearComparisonError = () => setComparisonError(null);

  const generateComparison = async (
    prompt: string,
    modelIds: string[],
    options?: GenerateOptions,
    cachedEnhancements?: Record<string, CachedEnhancement>
  ): Promise<GeneratedImage[]> => {
    setIsGenerating(true);
    setComparisonError(null);
    // V1.4.7: generation mutates comparisonResults — arm the persist.
    markDirty();
    const comparisonId = `comp-group-${Date.now()}`;
    const readyImages: GeneratedImage[] = [];

    let finalPrompt = prompt;
    if (options?.lighting || options?.angle) {
      const parts = [prompt];
      if (options.lighting) parts.push(`Lighting: ${options.lighting}`);
      if (options.angle) parts.push(`Camera angle: ${options.angle}`);
      parts.push('Highly detailed, cinematic composition.');
      finalPrompt = parts.join('. ');
    }

    const placeholders: GeneratedImage[] = modelIds.map((modelId, idx) => {
      // Resolve the placeholder's modelInfo.provider from the model
      // registry rather than hardcoding 'leonardo' — minimax-image-01
      // is the first non-Leonardo entry in LEONARDO_MODELS and the
      // gallery / filters key off this field. Pre-MXIMG-001 models
      // omit `provider` and fall back to 'leonardo' for back-compat.
      const cfg = LEONARDO_MODELS.find(m => m.id === modelId);
      // V1.7.0-PIPELINE-HIGGSFIELD: higgsfield ids resolve via the unified
      // registry so the placeholder badge shows the right provider too.
      const provider: 'leonardo' | 'minimax' | 'higgsfield' =
        getImageModel(modelId)?.provider === 'higgsfield' ? 'higgsfield'
        : (cfg?.provider ?? 'leonardo');
      return {
        id: `comp-placeholder-${Date.now()}-${idx}`,
        comparisonId,
        prompt: finalPrompt,
        status: 'generating',
        url: '',
        modelInfo: {
          provider,
          modelId,
          modelName: getModelName(modelId),
        },
      };
    });
    setComparisonResults(prev => [...placeholders, ...prev]);
    setProgress('Preparing comparison...');

    try {
      for (let i = 0; i < modelIds.length; i++) {
        const modelId = modelIds[i];
        const modelName = getModelName(modelId);

        // Use cached enhancement from preview if available, otherwise call pi.
        setProgress(cachedEnhancements?.[modelId]?.prompt
          ? `Generating with ${modelName}...`
          : `Optimizing prompt for ${modelName}...`
        );
        const cached = cachedEnhancements?.[modelId];
        const enhancement = cached?.prompt
          ? {
              prompt: cached.prompt,
              style: cached.style,
              aspectRatio: cached.aspectRatio,
              negativePrompt: cached.negativePrompt,
            }
          : options?.skipEnhance
            ? { prompt: finalPrompt }
            : await enhancePromptForModel(finalPrompt, modelId, {
                style: options?.style,
                aspectRatio: options?.aspectRatio,
                negativePrompt: options?.negativePrompt,
              });
        // V090-PIPELINE-STYLE-DIVERSITY: prefer per-model style override,
        // fall back to enhancement / shared option. Per-model picks come
        // from the rule engine's style diversity (each nano-banana gets a
        // different style).
        const perModelStyle = options?.perModelOptions?.[modelId]?.style;
        // V090-GPT15-STYLE-SKIP: only inject style text for models that
        // support style_ids. gpt-image-1.5 has no style parameter.
        // modelConfig is reused in leonardoStyleUuids below.
        const modelConfig = LEONARDO_MODELS.find(m => m.id === modelId);
        const modelSupportsStyle = Boolean(modelConfig?.styles?.length);
        const modelStyle = modelSupportsStyle
          ? (perModelStyle || enhancement.style || options?.style)
          : undefined;
        // STYLE-DEDUP: feed buildEnhancedPrompt the raw enhanced prompt and
        // let it emit the single `style: <name>` keyword via styleName.
        // The previous `${enhancement.prompt}. Art style: ${modelStyle}`
        // concat duplicated the style — buildEnhancedPrompt below already
        // appends it. Mirrors useImageGeneration.ts (modelPrompt = enhancement.prompt).
        const modelPrompt = enhancement.prompt;
        const modelRatio =
          enhancement.aspectRatio || options?.aspectRatio || '1:1';
        const modelNegPrompt =
          enhancement.negativePrompt || options?.negativePrompt;

        setProgress(`Generating with ${modelName}...`);

        try {
          // STORY-MMX-PROMPT-WIRE: route per-spec details (style UUID,
          // dimensions, quality default) through buildEnhancedPrompt so
          // the prompt + Leonardo params see the same spec-validated
          // inputs as everywhere else. Mirrors the wiring in
          // useImageGeneration.ts; until this commit the live
          // generateComparison path used a thinner enhancePromptForModel
          // only, so the rich lib/model-specs JSON registry wasn't
          // consulted for actual submits.
          const enhanced = buildEnhancedPrompt(modelPrompt, {
            modelId,
            styleName: modelStyle,
            aspectRatio: modelRatio,
            count: 1,
          });

          const dimsFallback = getLeonardoDimensions(modelId, modelRatio);

          // Map art style name → Leonardo UUID. buildEnhancedPrompt
          // already provides this when the model has a registered spec;
          // we keep the fuzzy-match fallback so unspec'd / pre-MXIMG-001
          // models still get a styleId pick.
          const fuzzyStyleUuids = (() => {
            if (!modelStyle) return undefined;
            if (!modelConfig?.styles) return undefined;
            const match = modelConfig.styles.find(s =>
              s.name.toLowerCase() === modelStyle.toLowerCase() ||
              s.name.toLowerCase().includes(modelStyle.toLowerCase())
            );
            return match ? [match.uuid] : undefined;
          })();

          const submitWidth = enhanced.leonardo.width ?? dimsFallback.width;
          const submitHeight = enhanced.leonardo.height ?? dimsFallback.height;
          const submitStyleIds = enhanced.leonardo.styleIds ?? fuzzyStyleUuids;
          const submitPrompt = enhanced.prompt;

          // Provider branch — minimax-image-01 (and any future MiniMax
          // image models) route to /api/minimax-image, which calls
          // MiniMax's native image_generation endpoint with a
          // synchronous response (no polling). All other models stay on
          // the Leonardo v2 submit-then-poll path. Mirrors the branching
          // shipped to hooks/useImageGeneration.ts in MXIMG-001 — that
          // hook's `generateImages` is destructured in several places
          // but never actually invoked (Studio + Pipeline use this
          // generateComparison path instead), which is why the routing
          // gap survived until now.
          // V1.7.0-PIPELINE-HIGGSFIELD: the unified registry is the
          // authoritative provider source (LEONARDO_MODELS only knows
          // leonardo/minimax; higgsfield ids live in image-models.ts).
          const unifiedModel = getImageModel(modelId);
          const submitProvider: 'leonardo' | 'minimax' | 'higgsfield' =
            unifiedModel?.provider === 'higgsfield' ? 'higgsfield'
            : (modelConfig?.provider ?? 'leonardo');

          // Single-attempt submit. Throws on any failure; on Leonardo
          // FAILED-with-moderation it annotates the Error with
          // `moderationClassification` + `failedPrompt` so the outer
          // one-retry wrapper can decide whether to rewrite + retry.
          type SubmitSuccess = { imageUrl: string; imageId: string; seed: number };
          type SubmitError = Error & {
            moderationClassification?: string[];
            failedPrompt?: string;
          };
          const submitOnce = async (prompt: string): Promise<SubmitSuccess> => {
            if (submitProvider === 'higgsfield') {
              // V1.7.0-PIPELINE-HIGGSFIELD: route to the real Higgsfield
              // backend via the shared submit. apiName is the backend slug
              // (UnifiedImageModel.apiModelId, e.g. 'nano_banana_2'); the
              // CLI token (when set) makes the route use the CLI binary.
              const r = await submitHiggsfieldImageShared({
                prompt,
                apiName: unifiedModel?.apiModelId ?? modelId.replace(/^higgsfield:/, ''),
                aspectRatio: modelRatio,
                resolution: unifiedModel?.resolutions?.[0] as '1k' | '2k' | '4k' | undefined,
                higgsfieldCliToken: settings.higgsfieldCliToken,
              });
              return { imageUrl: r.imageUrl, imageId: r.imageId, seed: r.seed };
            }
            if (submitProvider === 'minimax') {
              const res = await fetch('/api/minimax-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  prompt,
                  aspectRatio: modelRatio,
                  width: submitWidth,
                  height: submitHeight,
                  n: 1,
                  // Short prompts get a bigger uplift from MiniMax's
                  // server-side prompt_optimizer; long ones carry their
                  // own detail. Threshold matches submitMinimaxImage in
                  // useImageGeneration.ts.
                  promptOptimizer: prompt.length < 180,
                }),
              });
              if (!res.ok) {
                let detail = `MiniMax request failed (${res.status})`;
                try {
                  const j = await res.json();
                  if (typeof j?.error === 'string') detail = j.error;
                } catch { /* non-JSON */ }
                throw new Error(detail);
              }
              const data = (await res.json()) as {
                images?: Array<{ url?: string }>;
                generationId?: string;
              };
              const first = Array.isArray(data.images) ? data.images[0] : undefined;
              if (!first?.url) throw new Error('MiniMax returned no image URL');
              return { imageUrl: first.url, imageId: data.generationId ?? '', seed: 0 };
            }

            // Leonardo branch — POST then poll until COMPLETE / FAILED.
            const res = await fetch('/api/leonardo', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                prompt,
                modelId,
                width: submitWidth,
                height: submitHeight,
                negative_prompt: modelNegPrompt,
                styleIds: submitStyleIds,
                quality: enhanced.leonardo.quality,
                apiKey: settings.apiKeys.leonardo,
              }),
            });
            if (!res.ok) {
              let detail = `Leonardo submit failed (${res.status})`;
              try {
                const j = await res.json();
                if (typeof j?.error === 'string') detail = j.error;
              } catch { /* non-JSON */ }
              throw new Error(detail);
            }
            const data = await res.json();
            if (!data.generationId) throw new Error('Leonardo returned no generationId');
            let attempts = 0;
            while (attempts < 150) {
              await new Promise(resolve => setTimeout(resolve, 2000));
              attempts++;
              const statusRes = await fetch(`/api/leonardo/${data.generationId}`);
              if (!statusRes.ok) continue; // tolerate transient 5xx / Hasura layer hiccups
              const statusData = await statusRes.json();
              if (statusData.status === 'COMPLETE') {
                return {
                  imageUrl: statusData.url,
                  imageId: statusData.imageId ?? '',
                  seed: statusData.seed ?? 0,
                };
              }
              if (statusData.status === 'FAILED') {
                const cls: string[] = Array.isArray(statusData.moderation?.moderationClassification)
                  ? statusData.moderation.moderationClassification
                  : [];
                const e = new Error(
                  statusData.error || 'Leonardo generation failed',
                ) as SubmitError;
                e.moderationClassification = cls;
                e.failedPrompt = statusData.failedPrompt || prompt;
                throw e;
              }
            }
            throw new Error('Timeout polling Leonardo generation');
          };

          // TRADEMARK-STAGED-PIPELINE (2026-05-22): 3-stage retry on
          // moderation block. Stage 1 = original prompt verbatim;
          // Stage 2 = minimal placeholder swap of ONE term; Stage 3 =
          // rich GENERIC_FOR descriptor swap of the same term. See
          // submitWithOneRetry in useImageGeneration.ts for the
          // canonical version of this flow — keep them in sync.
          let activePrompt = submitPrompt;
          let result: SubmitSuccess;
          let retried = false;
          try {
            // STAGE 1 — original prompt verbatim.
            result = await submitOnce(activePrompt);
            const allowedCandidates = extractTrademarkNames(activePrompt);
            for (const name of allowedCandidates) setOutcome(name, 'allowed', modelId);
          } catch (err) {
            const e = err as SubmitError;
            const cls = e.moderationClassification ?? [];
            if (cls.length === 0) throw err;
            setProgress(
              `Blocked by ${cls.join(', ')} — rewriting for ${modelName}…`,
            );
            setComparisonResults(prev => prev.map(img =>
              img.id === placeholders[i].id
                ? { ...img, error: `Blocked by ${cls.join(', ')} — rewriting…` }
                : img
            ));
            const upper = cls.map((c) => c.toUpperCase());
            const isTrademark = upper.some((c) => c === 'TRADEMARK' || c === 'COPYRIGHT');
            if (!isTrademark) {
              const rewritten = await streamAIToString(
                buildModerationRewriteInstruction(e.failedPrompt ?? activePrompt, cls),
                { mode: 'enhance', provider: settings.activeAiAgent, model: settings.activeTextModel },
              );
              activePrompt = (rewritten || '').trim() || activePrompt;
              retried = true;
              result = await submitOnce(activePrompt);
            } else {
              const plan = planStagedSubstitution(e.failedPrompt ?? activePrompt, modelId);
              if (!plan) throw err;
              setOutcome(plan.targetName, 'blocked', modelId);
              retried = true;
              try {
                // STAGE 2 — minimal swap.
                activePrompt = plan.stage2Prompt;
                result = await submitOnce(activePrompt);
              } catch (err2) {
                const e2 = err2 as SubmitError;
                const cls2 = (e2.moderationClassification ?? []).map((c) => c.toUpperCase());
                const stillTrademark = cls2.some((c) => c === 'TRADEMARK' || c === 'COPYRIGHT');
                if (!stillTrademark) throw err2;
                // STAGE 3 — rich descriptor swap, same target term.
                activePrompt = plan.stage3Prompt;
                result = await submitOnce(activePrompt);
              }
            }
          }
          const { imageUrl, imageId, seed } = result;

          const newImg: GeneratedImage = {
            id: `comp-${Date.now()}-${modelId}`,
            comparisonId,
            url: imageUrl,
            // Persist whichever prompt actually produced the image —
            // on a moderation rewrite that's the cleaned version, not
            // the original blocked text.
            prompt: activePrompt,
            imageId,
            seed,
            status: 'ready',
            negativePrompt: modelNegPrompt,
            aspectRatio: modelRatio,
            imageSize: options?.imageSize,
            style: modelStyle,
            modelInfo: { provider: submitProvider, modelId, modelName },
          };
          if (retried) {
            // Cheap breadcrumb on the result card so the user knows
            // why their final prompt differs from what they typed.
            (newImg as GeneratedImage & { retried?: boolean }).retried = true;
          }
          setComparisonResults(prev => prev.map(img => img.id === placeholders[i].id ? newImg : img));
          readyImages.push(newImg);
          // V1.7.0-PROVIDER-LOG: report the provider that actually produced
          // this image so the pipeline timeline can name it live. Swallow
          // consumer throws so a bad listener can't break the loop.
          try {
            options?.onModelSuccess?.(modelId, modelName, submitProvider);
          } catch { /* ignore consumer-side throw */ }
        } catch (imgErr: unknown) {
          // Surface the failure on the placeholder instead of silently
          // dropping it (the prior catch{} just filtered the placeholder
          // out of the UI list — that's the silent-fail UX Maurice
          // flagged). Differentiate moderation blocks (with
          // classifications) from network / validation errors.
          const e = imgErr as Error & { moderationClassification?: string[] };
          const cls = e?.moderationClassification ?? [];
          const errMsg = cls.length > 0
            ? `Blocked after rewrite: ${cls.join(', ')}. Edit the prompt or switch model.`
            : (getErrorMessage(imgErr) || 'Generation failed');
          setComparisonResults(prev => prev.map(img =>
            img.id === placeholders[i].id
              ? { ...img, status: 'error', error: errMsg }
              : img
          ));
          // Notify the caller (Pipeline wires this to addLog so per-model
          // failures show up in the pipeline timeline; Compare UI keeps
          // the placeholder-error breadcrumb above). Swallow callback
          // exceptions so a bad consumer can't break the comparison loop.
          try {
            options?.onModelError?.(modelId, modelName, errMsg);
          } catch { /* ignore consumer-side throw */ }
        }
      }
    } catch (e: unknown) {
      const message = getErrorMessage(e) || 'Comparison failed. Check your API keys.';
      setComparisonError(message);
      setProgress('');
    } finally {
      setIsGenerating(false);
    }
    return readyImages;
  };

  const pickComparisonWinner = async (id: string) => {
    const winnerImg = comparisonResults.find(img => img.id === id);
    if (!winnerImg || !winnerImg.url) return;

    markDirty();
    setComparisonResults(prev => prev.map(img => {
      if (img.id === id) {
        return { ...img, winner: true };
      }
      return img;
    }));

    let finalUrl = winnerImg.url;
    let finalBase64 = winnerImg.base64;

    const watermarkSettings: WatermarkSettings = {
      ...(settings.watermark || { enabled: false, image: null, position: 'bottom-right', opacity: 0.8, scale: 0.05 }),
      enabled: true,
    };
    finalUrl = await applyWatermark(finalUrl, watermarkSettings, settings.channelName || 'MashupForge');
    finalBase64 = undefined;

    const galleryImg: GeneratedImage = {
      ...winnerImg,
      id: `img-${Date.now()}-winner`,
      url: finalUrl,
      base64: finalBase64,
      status: 'ready'
    };

    saveImage(galleryImg);
  };

  // Intentionally-immediate writers: writeNow does a full-value store write
  // (never a partial/defaults snapshot) and arms dirty so the persist effect
  // won't double-fight it. Replaces the old markDirty()+setState()+set()
  // trio — same effect, one call.
  const clearComparison = () => {
    store.writeNow([]);
  };

  const deleteComparisonResult = (id: string) => {
    // Write the FULL filtered list (the design's explicit requirement for
    // delete), derived from the current value.
    store.writeNow(store.value.filter(img => img.id !== id));
  };

  return {
    comparisonResults,
    comparisonPrompt,
    setComparisonPrompt,
    comparisonOptions,
    setComparisonOptions,
    generateComparison,
    pickComparisonWinner,
    clearComparison,
    deleteComparisonResult,
    isComparisonLoaded: store.isLoaded,
    isComparisonGenerating: isGenerating,
    comparisonProgress: progress,
    comparisonError,
    clearComparisonError,
    // V1.2.1: lazy load — see useImages.ts. Fired by the Compare view
    // mount in MainContent.tsx.
    requestLoad: store.requestLoad,
  };
}
