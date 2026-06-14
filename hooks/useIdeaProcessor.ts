'use client';

import { useCallback, useRef } from 'react';
import { streamAIToString } from '@/lib/aiClient';
import {
  type Idea,
  type UserSettings,
  type GeneratedImage,
  type GenerateOptions,
  type ScheduledPost,
  type PipelineProgress,
  LEONARDO_MODELS,
  LEONARDO_SHARED_STYLES,
  MODEL_PROMPT_GUIDES,
} from '../types/mashup';
import { suggestParametersAI, type PerModelSuggestion } from '@/lib/param-suggest';
import {
  loadEngagementData,
  type CachedEngagement,
  type EngagementHour,
  type EngagementDay,
} from '@/lib/smartScheduler';
import { pickFillWeekSlot } from '@/lib/fill-week-scheduler';
import {
  processIdea as processIdeaFn,
  type ProcessIdeaDeps,
  type ResumeContext,
} from '@/lib/pipeline-processor';
import { awaitImagesOrSkip } from '@/lib/image-readiness';
import { generateNegativePrompt } from '@/lib/negative-prompts';
import { extractTrademarkNames } from '@/lib/extract-trademark-names';
import { setOutcome } from '@/lib/trademark-outcomes';
import { computeViralityScoreServer } from '@/lib/actions/virality';
import { requestDirectorPrompt } from '@/lib/director-pipeline';
import type { WriteCheckpointBase } from './usePipelineDaemon';
import { useDesktopConfig } from './useDesktopConfig';

export interface UseIdeaProcessorDeps {
  getSettings: () => UserSettings;
  generateComparison: (
    prompt: string,
    modelIds: string[],
    options?: GenerateOptions,
  ) => Promise<GeneratedImage[]>;
  generatePostContent: (img: GeneratedImage) => Promise<GeneratedImage | undefined>;
  saveImage: (img: GeneratedImage) => void;
  updateIdeaStatus: (id: string, status: 'idea' | 'in-work' | 'done') => void;
  updateSettings: (
    patch: Partial<UserSettings> | ((prev: UserSettings) => Partial<UserSettings>),
  ) => void;
  addLog: (
    step: string,
    ideaId: string,
    status: 'success' | 'error',
    message: string,
  ) => void;
  setPipelineProgress: (p: PipelineProgress | null) => void;
}

function findNextAvailableSlot(
  existingPosts: ScheduledPost[],
  engagement: CachedEngagement | undefined,
  platforms: string[] | undefined,
  caps: UserSettings['pipelineDailyCaps'] | undefined,
  postsPerDay: number,
): { date: string; time: string; reason: string } {
  const eng = engagement || loadEngagementData();
  // V060-004: route through pickFillWeekSlot so the engagement-best
  // slot lands in the current week until it's filled, then extends
  // into week 2.
  const slot = pickFillWeekSlot({
    posts: existingPosts,
    engagement: eng,
    postsPerDay,
    platforms,
    caps,
  });
  const topHour = eng.hours.reduce((a: EngagementHour, b: EngagementHour) =>
    a.weight > b.weight ? a : b,
  );
  const topDay = eng.days.reduce((a: EngagementDay, b: EngagementDay) =>
    a.multiplier > b.multiplier ? a : b,
  );
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const slotDate = new Date(slot.date);
  const capsActive = caps && Object.values(caps).some(v => typeof v === 'number');
  const reason = `${slot.time} on ${dayNames[slotDate.getDay()]} (week ${slot.week}, ${
    eng.source === 'instagram' ? 'IG insights' : 'research'
  } — best hour ${topHour.hour}:00, best day ${dayNames[topDay.day]}${
    capsActive ? ', caps applied' : ''
  })`;
  return { date: slot.date, time: slot.time, reason };
}

// V1.6 Director-default guards (see directorRunsRef below): client-side
// wall-clock cap for one Director run — well under the daemon's 10-min
// per-idea timeout so image gen + captioning keep their budget — and the
// per-idea failure cap after which the session stops paying for retries.
const DIRECTOR_CLIENT_TIMEOUT_MS = 180_000;
const DIRECTOR_MAX_FAILURES = 2;

/**
 * Per-idea processor hook. Owns no state — builds a ProcessIdeaDeps bag
 * from daemon-supplied live readers + caller-supplied primitives and
 * delegates to the pure processIdeaFn in lib/pipeline-processor.ts.
 */
export function useIdeaProcessor(deps: UseIdeaProcessorDeps) {
  const {
    getSettings,
    generateComparison,
    generatePostContent,
    saveImage,
    updateIdeaStatus,
    updateSettings,
    addLog,
    setPipelineProgress,
  } = deps;

  // V041-HOTFIX-IG: pipeline-processor needs desktop credential flags to
  // detect IG/PN/TW/DC creds stored in config.json (env-style), not just
  // settings.apiKeys (web-mode IDB). Without this, desktop users with
  // creds saved in the Desktop tab see "No platforms configured".
  const { isDesktop, credentials: desktopCreds } = useDesktopConfig();

  // V1.6 Director-default guards: the Director costs real money per run
  // (server-side budget up to $0.50), and continuous mode resets failed
  // ideas back to 'idea' and re-picks them next cycle with zero sleep.
  // Without a memo, any post-Director failure (image-gen error, idea
  // timeout) re-fires a fresh PAID tool loop for the SAME idea on every
  // cycle, indefinitely. The memo caps per-idea spend at one successful
  // run (reused across retries) OR DIRECTOR_MAX_FAILURES failed
  // attempts (then the idea falls back to verbatim permanently for this
  // session). Session-scoped by design — an app restart retries.
  const directorRunsRef = useRef(new Map<string, { prompt?: string; failures: number }>());

  const expandIdeaToPrompt = useCallback(
    async (idea: Idea, _trendingContext?: string, signal?: AbortSignal): Promise<string> => {
      // IMG-INVEST-001 PART 2 (2026-05-23): the DEFAULT (fast) path does
      // NO our-side prompt enhancement. The idea's concept (and optional
      // context) goes to Leonardo VERBATIM; Leonardo's API-side
      // prompt_enhance=ON expands the short concept into a full image
      // prompt. Smart-suggestion (style/quality/aspect ratio) lives in
      // suggestParametersAI further down the triggerImageGeneration path.
      const trimmedConcept = idea.concept.trim();
      const trimmedContext = idea.context?.trim();
      const verbatim =
        trimmedConcept && trimmedContext
          ? `${trimmedConcept}. ${trimmedContext}`
          : trimmedConcept || idea.concept;

      // V1.6: agentic "Director" pipeline — the default path since
      // v1.6.0 (opt-in in v1.5.0; users can switch it off in Settings →
      // AI Engine). When enabled AND at least one niche is configured
      // (the Director route validates 1-6 niches), route the idea→prompt
      // step through the multi-step tool-use loop (trending_search →
      // generate_prompt → critique → refine) and use its final prompt.
      // The Director's
      // plan is prompt-ONLY (it ends with the final prompt as assistant
      // text; image generation still happens later via
      // triggerImageGeneration) and is bounded by a server-side budget +
      // step cap. ANY failure (no provider, route 4xx, empty prompt)
      // falls back to the verbatim concept so the pipeline never stalls.
      const s = getSettings();
      const niches = (s.agentNiches ?? []).filter(Boolean);
      if (s.useDirectorPipeline && niches.length >= 1 && trimmedConcept.length >= 3) {
        const memo = directorRunsRef.current.get(idea.id) ?? { failures: 0 };
        if (memo.prompt) {
          // Retry of an idea whose Director run already succeeded
          // (e.g. image gen failed and continuous mode re-picked it):
          // reuse the already-paid prompt instead of spending again.
          addLog('director', idea.id, 'success', '🎬 Director prompt reused from this session (no extra cost).');
          return memo.prompt;
        }
        if (memo.failures >= DIRECTOR_MAX_FAILURES) {
          addLog('director', idea.id, 'error', `🎬 Director skipped after ${memo.failures} failed attempts — using the concept verbatim.`);
          return verbatim;
        }

        addLog('director', idea.id, 'success', '🎬 Director mode: planning prompt via agentic tool loop…');
        // V1.6: bound the Director in wall-clock time and make Skip
        // responsive. The per-idea daemon timeout (10 min) used to be
        // spent almost entirely on image gen; an unbounded Director
        // fetch could eat it whole — and skipAbort couldn't cancel the
        // in-flight call. The combined signal aborts the fetch on
        // EITHER the user's skip or the client-side cap; the server
        // (handleDirectorMode) honours the abort and stops billing.
        const timeoutSignal = AbortSignal.timeout(DIRECTOR_CLIENT_TIMEOUT_MS);
        const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        const outcome = await requestDirectorPrompt(
          {
            ideaConcept: trimmedConcept,
            niches,
            genres: s.agentGenres ?? [],
            model: s.activeTextModel,
            activeSkills: s.activeSkills ?? [],
          },
          { signal: combinedSignal },
        );
        if (outcome.ok) {
          memo.prompt = outcome.prompt;
          directorRunsRef.current.set(idea.id, memo);
          const costStr = typeof outcome.cost === 'number' ? `, $${outcome.cost.toFixed(3)}` : '';
          addLog('director', idea.id, 'success', `🎬 Director prompt ready (${outcome.truncatedBy ?? 'natural'}${costStr}).`);
          return outcome.prompt;
        }
        memo.failures += 1;
        directorRunsRef.current.set(idea.id, memo);
        addLog('director', idea.id, 'error', `🎬 Director unavailable (${outcome.reason}) — using the concept verbatim.`);
      }

      return verbatim;
    },
    [getSettings, addLog],
  );

  const processIdea = useCallback(
    async (
      idea: Idea,
      index: number,
      total: number,
      engagement: CachedEngagement,
      accumulatedPosts: ScheduledPost[],
      skipSignal: AbortSignal,
      writeCheckpointBase: WriteCheckpointBase,
      resumeFrom?: ResumeContext,
    ): Promise<void> => {
      const perIdeaImageIds: string[] = [];
      const checkpoint = (step: string) =>
        writeCheckpointBase(idea.id, idea.concept, step, perIdeaImageIds);

      // V030-006: capture the generator's own Promise instead of polling a
      // parallel image store. triggerImageGeneration fires the call and
      // stashes the Promise; waitForImages awaits it (racing skipSignal).
      let imageReadyPromise: Promise<GeneratedImage[]> | null = null;

      const processorDeps: ProcessIdeaDeps = {
        fetchTrendingContext: async ideaArg => {
          const s = getSettings();
          // V1.2.5-HOTFIX: route through the hybrid trending
          // orchestrator instead of calling /api/trending
          // directly. The direct call returns "" when the
          // Server-Side camofox sidecar is UNHEALTHY (which
          // is the common case in Maurice's Tauri install —
          // camoufox-js bundling issue). The hybrid path:
          //  1. POSTs /api/trending with x-client-can-search
          //  2. Falls back to clientSideCamofoxSearch via the
          //     Tauri `camofox_search` command when the route
          //     returns CLIENT_SEARCH_REQUIRED
          //  3. POSTs the merged results back to
          //     /api/trending/results for dedup + cache
          // This eliminates the "No trending data" error in
          // the pipeline for the common case where the
          // sidecar is up but the route's Server-Side path is
          // not.
          const { fetchTrendingHybrid } = await import('@/lib/trending-client');
          const data = await fetchTrendingHybrid({
            tags: [],
            niches: s.agentNiches,
            genres: s.agentGenres,
            ideaConcept: ideaArg.concept,
          });
          if (data.success && data.summary) return data.summary;
          return '';
        },
        // V1.6: thread the per-idea skip signal into the Director call
        // so "Skip idea" (and the idea timeout) abort the in-flight
        // fetch instead of letting it run — and bill — to completion.
        expandIdeaToPrompt: (ideaArg, trendingCtx) =>
          expandIdeaToPrompt(ideaArg, trendingCtx, skipSignal),
        triggerImageGeneration: async (prompt, modelIds, trendingContext) => {
          // Run the deterministic param-suggest rule engine for this
          // idea's prompt so the pipeline uses the same style / aspect /
          // negative prompt picks as the interactive Compare flow. Falls
          // back silently if suggestion fails — generation still runs
          // with the base negative prompt derived from user genres.
          const s = getSettings();
          const baseNegative = generateNegativePrompt(
            s.agentGenres || [],
            s.agentNiches || [],
          );
          let suggestedOptions: Partial<GenerateOptions> = {};
          try {
            // AI-PARAM-SUGGEST (2026-05-20): route through the user's
            // text-AI backend. Capability post-filter in suggestParametersAI
            // strips any field the AI hallucinates outside a model's spec,
            // and any failure falls back silently to the rule engine.
            const suggestion = await suggestParametersAI(
              {
                prompt,
                availableModels: LEONARDO_MODELS,
                modelGuides: MODEL_PROMPT_GUIDES,
                availableStyles: LEONARDO_SHARED_STYLES,
                savedImages: [],
                includedModelIds: modelIds,
                // PARAM-TRENDING (2026-05-21): thread the pipeline's
                // already-fetched trending blurb into the AI so style /
                // aspect picks can react to current trends. Empty string
                // when fetchTrendingContext returned nothing — the prompt
                // template handles that with a "(none available)" line.
                trendingContext,
              },
              {
                aiCall: (message, signal) =>
                  streamAIToString(message, {
                    provider: s.activeAiAgent,
                    mode: 'chat',
                    // V082: thread the user's selected model through
                    // to the AI route so the picker choice actually
                    // takes effect. `aiClient.streamAI` passes `model`
                    // verbatim to the body of /api/ai/prompt.
                    model: s.activeTextModel,
                    // V1.2.5-HOTFIX: thread activeSkills so the
                    // server's buildSkillSystemBlock composes the
                    // user's skills into the system prompt. Without
                    // this, the skill toggles in Settings → AI Engine
                    // are ignored by the pipeline's AI calls.
                    activeSkills: s.activeSkills ?? [],
                    // V1.2.5-HOTFIX: thread the user's CLI token
                    // (entered in Settings → HiggsfieldConnection)
                    // to the route so the next `getProvider('higgsfield')`
                    // call from the Director loop's `generate_image`
                    // tool forwards it as `HIGGSFIELD_API_KEY` to
                    // the @higgsfield/cli binary. Without this, the
                    // CLI token entry is dead UI.
                    higgsfieldCliToken: s.higgsfieldCliToken,
                    signal,
                  }),
              },
            );
            // V090-PIPELINE-STYLE-DIVERSITY: extract per-model styles
            // from the suggestion so nano-banana siblings each get a
            // different style instead of all sharing the first model's pick.
            const perModelOpts: Record<string, { style?: string; aspectRatio?: string; negativePrompt?: string }> = {};
            for (const mid of Object.keys(suggestion.perModel)) {
              const entry = suggestion.perModel[mid] as PerModelSuggestion;
              if (entry.type === 'image' && entry.style) {
                perModelOpts[mid] = { style: entry.style };
              }
            }
            suggestedOptions = {
              style: suggestion.style,
              aspectRatio: suggestion.aspectRatio,
              imageSize: suggestion.imageSize,
              negativePrompt: suggestion.negativePrompt || baseNegative,
              quality: suggestion.quality,
              promptEnhance: suggestion.promptEnhance,
              perModelOptions: perModelOpts,
            };
          } catch {
            suggestedOptions = { negativePrompt: baseNegative };
          }

          // TRADEMARK-NO-PREFLIGHT-REWRITE (2026-05-22): Maurice's
          // addendum to /tmp/dev-trademark-bug.md — the rewrite should
          // ONLY fire after a real moderation failure, not proactively
          // before generation is attempted. Pre-flight substitution
          // (introduced 9401247, tightened aa2a068) re-wrote prompts
          // that would have succeeded as-is, losing user composition.
          // We pass the user's prompt through verbatim; if a model
          // rejects with TRADEMARK/COPYRIGHT, useImageGeneration's
          // submitWithOneRetry (and useComparison's inline retry)
          // handle the deterministic 3-stage name-swap as a fallback.
          // The outcome store has no authoring-side reader anymore —
          // expandIdeaToPrompt is a pure concept+context joiner; the
          // only consumer of getAllBlocked() outside the retry path
          // is the SettingsModal blocklist UI.
          const activePrompt = prompt;

          imageReadyPromise = generateComparison(activePrompt, modelIds, {
            skipEnhance: false,
            ...suggestedOptions,
            // Surface per-model Leonardo/MiniMax failures in the pipeline
            // log. Without this hook, the only signal of a failed model
            // is a smaller readyImages array vs. modelIds.length — and
            // the WHY (400 prompt-too-long, moderation, validation, …)
            // lives only on the Compare placeholder, which Pipeline users
            // never see. Added 2026-05-21 after the "only MiniMax shows
            // up in Pipeline" debugging session.
            //
            // TRADEMARK-LEARNING: when the error string mentions TRADEMARK
            // (Leonardo's classification surfaces through this string at
            // useComparison.ts:382 as "Blocked after rewrite: TRADEMARK…"),
            // extract names from the prompt we submitted. Only auto-flag
            // 'blocked' when EXACTLY ONE name is in the prompt — that's
            // the unambiguous case where we know which name triggered the
            // moderation.
            //
            // TRADEMARK-SURGICAL-REWRITE (2026-05-21): Maurice's bug report
            // — when a multi-name prompt blocked, the prior code marked
            // EVERY extracted name 'blocked' even though only one was the
            // trigger. Iron Man got falsely flagged from a Spider-Man +
            // Iron Man prompt where Spider-Man was the real trigger,
            // poisoning the learning store. Now: if there are multiple
            // candidate names, just log them so a human / future
            // disambiguation can act — don't auto-poison the store.
            // V1.7.0-PROVIDER-LOG: name the provider that produced each
            // image in the pipeline timeline (Leonardo vs Higgsfield vs
            // MiniMax) — previously only failures were logged, so a
            // successful run never showed WHICH backend ran.
            onModelSuccess: (_modelId, modelName, provider) => {
              const label = provider === 'higgsfield' ? 'Higgsfield'
                : provider === 'leonardo' ? 'Leonardo.ai'
                : provider === 'minimax' || provider === 'mmx' ? 'MiniMax'
                : provider;
              addLog('image-gen', idea.id, 'success', `✅ Image generated by ${label} (${modelName}).`);
            },
            onModelError: (modelId, modelName, err) => {
              addLog('image-gen', idea.id, 'error', `${modelName} failed: ${err}`);
              if (/TRADEMARK|COPYRIGHT/i.test(err)) {
                const observedNames = extractTrademarkNames(activePrompt);
                if (observedNames.length === 1) {
                  const name = observedNames[0];
                  setOutcome(name, 'blocked', modelId);
                  addLog(
                    'moderation',
                    idea.id,
                    'error',
                    `TRADEMARK blocked: ${modelName} — marked "${name}" blocked for ${modelName} for future pre-flight (sole candidate in prompt)`,
                  );
                } else if (observedNames.length > 1) {
                  addLog(
                    'moderation',
                    idea.id,
                    'error',
                    `TRADEMARK blocked: ${modelName} — ${observedNames.length} candidate names in prompt, NOT auto-flagging (ambiguous trigger): ${observedNames.join(', ')}`,
                  );
                }
              }
            },
          });
          // Swallow the images here — processor contract is Promise<void>.
          // waitForImages reads the captured Promise next.
          await imageReadyPromise;
        },
        getEnabledModelIds: () => {
          // MODEL-PRESELECT-FIX (2026-05-21): bridge between the Studio
          // Compare picker (persists to localStorage.mashup_comparison_models
          // — see components/MainContent.tsx:1468) and the pipeline's
          // model-list step. Returns [] on SSR / missing key / parse failure;
          // pipeline-processor handles the empty case by falling back to
          // "all Leonardo models minus nano-banana".
          try {
            if (typeof window === 'undefined') return [];
            const raw = window.localStorage.getItem('mashup_comparison_models');
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed.filter((x): x is string => typeof x === 'string');
          } catch {
            return [];
          }
        },
        waitForImages: async () => {
          if (!imageReadyPromise) return [];
          const readyImages = await awaitImagesOrSkip(imageReadyPromise, skipSignal);
          for (const img of readyImages) {
            if (!perIdeaImageIds.includes(img.id)) perIdeaImageIds.push(img.id);
          }
          return readyImages;
        },
        generatePostContent,
        saveImage: img => {
          saveImage(img);
          if (!perIdeaImageIds.includes(img.id)) perIdeaImageIds.push(img.id);
        },
        updateIdeaStatus,
        updateSettings,
        findNextAvailableSlot: (posts, eng, platforms, caps) =>
          findNextAvailableSlot(
            posts,
            eng,
            platforms,
            caps,
            getSettings().pipelinePostsPerDay ?? 2,
          ),
        addLog,
        setPipelineProgress,
        writeCheckpoint: checkpoint,
        isSkipRequested: () => skipSignal.aborted,
        getScheduledPosts: () => getSettings().scheduledPosts || [],
        computeViralityScore: async (caption: string) => {
          try {
            return await computeViralityScoreServer(caption);
          } catch {
            return null;
          }
        },
        desktopCreds: isDesktop ? desktopCreds : undefined,
      };

      // V050-001: seed perIdeaImageIds with the resume payload so the next
      // checkpoint write keeps tracking the same image set (otherwise a
      // crash mid-resume would lose the imageIds and force a full re-gen).
      if (resumeFrom) {
        for (const img of resumeFrom.images) {
          if (!perIdeaImageIds.includes(img.id)) perIdeaImageIds.push(img.id);
        }
      }

      await processIdeaFn(
        idea,
        index,
        total,
        engagement,
        accumulatedPosts,
        getSettings(),
        processorDeps,
        resumeFrom,
      );
    },
    [
      getSettings,
      generateComparison,
      generatePostContent,
      saveImage,
      updateIdeaStatus,
      updateSettings,
      addLog,
      setPipelineProgress,
      expandIdeaToPrompt,
      isDesktop,
      desktopCreds,
    ],
  );

  return { processIdea, expandIdeaToPrompt };
}
