/**
 * Standalone pipeline idea processor.
 *
 * Extracted from hooks/usePipeline.ts so it can be unit-tested without React
 * and without a browser environment. All side-effects are injected via
 * ProcessIdeaDeps so tests can mock them cheaply.
 *
 * V030-001 will split usePipeline into usePipelineDaemon + useIdeaProcessor;
 * this extraction is the first step — processIdea is now callable outside
 * a hook context.
 */

import {
  LEONARDO_MODELS,
  type Idea,
  type GeneratedImage,
  type UserSettings,
  type ScheduledPost,
  type PipelineProgress,
} from '@/types/mashup';
import type { CachedEngagement } from '@/lib/smartScheduler';
import { resolvePipelinePostStatus } from '@/lib/pipeline-daemon-utils';
import {
  configuredPlatforms,
  type DesktopCredentialFlags,
  type PipelinePlatform,
} from '@/lib/platform-credentials';

/** Typed replacement for the __SKIP_IDEA__ string sentinel. */
export class SkipIdeaSignal extends Error {
  readonly kind = 'skip' as const;
  constructor() {
    super('Pipeline idea skipped by user');
    this.name = 'SkipIdeaSignal';
  }
}

/**
 * V050-001: credit-preserving resume payload. When the daemon detects a
 * checkpoint with stored imageIds, it looks those images up in the saved
 * gallery and forwards them here so processIdea skips the (expensive)
 * Leonardo generation steps and resumes at captioning.
 */
export interface ResumeContext {
  /** Pre-generated images for this idea, already in the gallery. */
  images: GeneratedImage[];
}

export interface ProcessIdeaDeps {
  /**
   * Fetch trending context for the idea (wraps /api/trending).
   * Returns the context string on success, '' when no data is found.
   * May throw on hard network/parse failure — processIdea catches and continues.
   */
  fetchTrendingContext(idea: Idea): Promise<string>;
  /** Expand an idea + trending context into an image generation prompt. Throws on failure. */
  expandIdeaToPrompt(idea: Idea, trendingContext: string): Promise<string>;
  /**
   * Start image generation for a prompt + model list. Throws on failure.
   * `trendingContext` is the same blurb `expandIdeaToPrompt` received —
   * the implementation forwards it to the AI param-suggester so style /
   * aspect picks can react to current trends instead of only the prompt
   * text. Empty string when no trending data was fetched.
   */
  triggerImageGeneration(prompt: string, modelIds: string[], trendingContext: string): Promise<void>;
  /**
   * Return the user's currently-selected image model IDs (Studio Mode
   * Compare picker, persisted to localStorage.mashup_comparison_models).
   * The pipeline applies its own nano-banana exclusion on top — nano-
   * banana is a stale model retained in LEONARDO_MODELS for back-compat
   * but excluded from generation paths. Empty array signals "user has no
   * explicit selection" and the pipeline falls back to all Leonardo
   * models minus nano-banana, preserving the v0.9.41-and-earlier
   * behaviour for brand-new users.
   *
   * MODEL-PRESELECT-FIX (2026-05-21): added because the pipeline was
   * hardcoded to LEONARDO_MODELS.filter and silently ignored user
   * deselections in the Studio. Reported by Maurice: deselecting
   * MiniMax in Studio Mode still produced MiniMax pipeline images.
   */
  getEnabledModelIds(): string[];
  /**
   * Wait for generated images to appear in the image store.
   * Returns ready images (may be empty on timeout).
   * Implementations poll the image store and throw SkipIdeaSignal when
   * isSkipRequested() goes true mid-poll.
   */
  waitForImages(modelCount: number): Promise<GeneratedImage[]>;
  /** Generate post caption + hashtags for a single image. Returns undefined on empty result. */
  generatePostContent(img: GeneratedImage): Promise<GeneratedImage | undefined>;
  /** Persist an image to the gallery. */
  saveImage(img: GeneratedImage): void;
  updateIdeaStatus(id: string, status: 'idea' | 'in-work' | 'done'): void;
  updateSettings(patch: Partial<UserSettings> | ((prev: UserSettings) => Partial<UserSettings>)): void;
  findNextAvailableSlot(
    posts: ScheduledPost[],
    engagement: CachedEngagement,
    platforms?: string[],
    caps?: UserSettings['pipelineDailyCaps'],
  ): { date: string; time: string; reason: string };
  addLog(step: string, ideaId: string, status: 'success' | 'error', message: string): void;
  setPipelineProgress(p: PipelineProgress | null): void;
  /** Write a resumable checkpoint for the current step. Best-effort. */
  writeCheckpoint(step: string): void;
  /** Returns true when the user has requested to skip the current idea. */
  isSkipRequested(): boolean;
  /** Read the freshest scheduled posts for slot collision avoidance. */
  getScheduledPosts(): ScheduledPost[];
  /**
   * Compute virality score (0-100) for a caption. Returns null on failure.
   * Implementations should call a Server Action or API route — the caller
   * handles retries and timeouts. Returns null on failure (non-fatal).
   * Optional for test mocks and server-side callers that don't need it.
   */
  computeViralityScore?: (caption: string) => Promise<number | null>;
  /**
   * V041-HOTFIX-IG: presence flags for credentials stored in the desktop
   * config.json (separate from settings.apiKeys, which is the web-mode
   * IDB-backed bag). Pipeline platform inference must consider both, or
   * desktop users with creds only in config.json get "No platforms
   * configured — skipped". Optional so non-desktop callers can omit.
   */
  desktopCreds?: DesktopCredentialFlags;
}

function checkSkip(isSkipRequested: () => boolean): void {
  if (isSkipRequested()) throw new SkipIdeaSignal();
}

/**
 * Run an async producer over `items` with at most `limit` calls in flight.
 * Order-preserving: results[i] corresponds to items[i]. Each slot reports
 * via PromiseSettledResult so a single failure doesn't abort the rest —
 * matches the per-image fallback semantics the sequential caption loop
 * already had (catch + use prompt as fallback).
 *
 * Used by per-model captioning (PROP-017 / OPT-001) to fan 3–6 pi.dev
 * caption calls into a bounded pool instead of awaiting them in series.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** pi.dev concurrency cap for parallel per-model captioning (PROP-017). */
const CAPTION_PARALLEL_LIMIT = 3;

/**
 * Process a single idea through the full pipeline:
 * trending → expand → generate → caption → schedule → (auto-post).
 *
 * Throws SkipIdeaSignal when the user requests a skip mid-run.
 * Throws on fatal errors (expand / generate failures).
 * Handles recoverable errors (trending, caption) internally and continues.
 */
export async function processIdea(
  idea: Idea,
  index: number,
  total: number,
  engagement: CachedEngagement,
  accumulatedPosts: ScheduledPost[],
  settings: UserSettings,
  deps: ProcessIdeaDeps,
  resumeFrom?: ResumeContext,
): Promise<void> {
  const {
    fetchTrendingContext,
    expandIdeaToPrompt,
    triggerImageGeneration,
    getEnabledModelIds,
    waitForImages,
    generatePostContent,
    saveImage,
    updateIdeaStatus,
    updateSettings,
    findNextAvailableSlot,
    addLog,
    setPipelineProgress,
    writeCheckpoint,
    isSkipRequested,
    getScheduledPosts,
  } = deps;

  const resuming = !!(resumeFrom && resumeFrom.images.length > 0);

  writeCheckpoint(resuming ? 'Resuming at captioning' : 'starting');

  const autoCaption = settings.pipelineAutoCaption ?? true;
  const autoSchedule = settings.pipelineAutoSchedule ?? true;

  const explicitPlatforms =
    settings.pipelinePlatforms && settings.pipelinePlatforms.length > 0
      ? settings.pipelinePlatforms
      : null;
  // V041-HOTFIX-IG: defer to the shared helper so this matches PipelinePanel's
  // availability check (which considers desktop config.json creds, not just
  // settings.apiKeys). The previous Object.entries filter both ignored desktop
  // creds and treated empty objects as configured.
  const inferredPlatforms: PipelinePlatform[] = configuredPlatforms(settings, deps.desktopCreds);
  const pipelinePlatforms = explicitPlatforms ?? inferredPlatforms;

  // V040-HOTFIX-007 + BUG-CRIT-009: when this run will produce a post
  // that lands in `pending_approval`, the associated images must stay
  // OUT of Gallery until the user approves them (at which point the
  // watermark is applied + the flag cleared in
  // MashupContext.approveScheduledPost).
  //
  // BUG-CRIT-009 update: gate is `autoSchedule` only — the previous
  // `pipelinePlatforms.length > 0` extra constraint silently dropped
  // the flag whenever platform credential detection failed, so the
  // image leaked straight into Gallery un-reviewed and un-watermarked.
  // The downstream scheduling block now always creates a
  // `pending_approval` ScheduledPost (with `platforms: []` when none
  // are configured) so the approval queue has an entry that can clear
  // the flag for every pipeline-produced image. After BUG-CRIT-001
  // `resolvePipelinePostStatus` always returns 'pending_approval', so
  // the call here just documents intent — the result is always true.
  const pipelinePending =
    autoSchedule &&
    resolvePipelinePostStatus(pipelinePlatforms, settings.pipelineAutoApprove) ===
      'pending_approval';
  /**
   * Save a pipeline-produced image. Always stamps `sourceIdeaId` so the
   * daemon's skip-handler can find every image for this run (including
   * ones saved before scheduling) and clean them up. Throws SkipIdeaSignal
   * if the user requested a skip between generation and save, so we
   * never leave a half-committed image behind when the run aborts.
   */
  const savePipelineImage = (img: GeneratedImage) => {
    checkSkip(isSkipRequested);
    const stamped: GeneratedImage = pipelinePending
      ? { ...img, pipelinePending: true, sourceIdeaId: idea.id }
      : { ...img, sourceIdeaId: idea.id };
    saveImage(stamped);
  };

  let expandedPrompt: string;
  let readyImages: GeneratedImage[];

  // V1.6: caption-failure fallback text. Must NOT be expandedPrompt —
  // with the Director as the default path that is 40-150 words of
  // camera/lighting prompt jargon, not caption material (it would land
  // in ScheduledPost.caption and get posted on approval). Use the short
  // verbatim concept(+context) instead, matching the resume path's
  // documented choice of idea.concept for caption fallbacks.
  const conceptTrimmed = idea.concept.trim();
  const contextTrimmed = idea.context?.trim();
  const captionFallback =
    conceptTrimmed && contextTrimmed
      ? `${conceptTrimmed}. ${contextTrimmed}`
      : conceptTrimmed || idea.concept;

  if (resuming) {
    // V050-001: credit-preserving resume. Images already exist in the
    // gallery from the prior interrupted run — skip status flip, trending,
    // expand, and generation. Use idea.concept as the prompt fallback for
    // any caption-failure path below; pi.dev re-expand would be cheap but
    // we avoid even that to keep resume instant.
    setPipelineProgress({
      current: index + 1,
      total,
      currentStep: `Resuming at captioning (${resumeFrom!.images.length} images)`,
      currentIdea: idea.concept,
      currentIdeaId: idea.id,
    });
    updateIdeaStatus(idea.id, 'in-work');
    addLog(
      'resume',
      idea.id,
      'success',
      `Resumed at captioning — ${resumeFrom!.images.length} pre-generated image${
        resumeFrom!.images.length === 1 ? '' : 's'
      } reused, no Leonardo credits spent`,
    );
    expandedPrompt = idea.concept;
    readyImages = resumeFrom!.images;
  } else {
    // Step a — mark in-work
    setPipelineProgress({
      current: index + 1,
      total,
      currentStep: 'Updating status',
      currentIdea: idea.concept,
      currentIdeaId: idea.id,
    });
    updateIdeaStatus(idea.id, 'in-work');
    addLog('status-update', idea.id, 'success', `Marked "${idea.concept}" as in-work`);
    writeCheckpoint('Updating status');

    // Step b — trending context (recoverable)
    let trendingContext = '';
    setPipelineProgress({
      current: index + 1,
      total,
      currentStep: 'Researching trending topics',
      currentIdea: idea.concept,
      currentIdeaId: idea.id,
    });
    writeCheckpoint('Researching trending topics');
    try {
      trendingContext = await fetchTrendingContext(idea);
      if (trendingContext) {
        addLog('trending', idea.id, 'success', `Trending context fetched`);
      } else {
        addLog('trending', idea.id, 'success', 'No trending data found — proceeding without');
      }
    } catch {
      addLog('trending', idea.id, 'error', 'Trending research failed — proceeding without');
    }

    // Step c — expand prompt (fatal on failure)
    setPipelineProgress({
      current: index + 1,
      total,
      currentStep: 'Expanding idea to prompt',
      currentIdea: idea.concept,
      currentIdeaId: idea.id,
    });
    writeCheckpoint('Expanding prompt');
    try {
      expandedPrompt = await expandIdeaToPrompt(idea, trendingContext);
      addLog('prompt-expand', idea.id, 'success', `Expanded: "${expandedPrompt.slice(0, 80)}..."`);
    } catch (e) {
      addLog('prompt-expand', idea.id, 'error', 'Failed to expand prompt');
      throw e;
    }
    // V1.6: with the Director as default, expand can take minutes — an
    // idea the user skipped (or that timed out) during the call must
    // not proceed to spend image credits on a result nobody wants.
    checkSkip(isSkipRequested);

    // Step d — generate images (fatal on failure)
    // MODEL-PRESELECT-FIX (2026-05-21): was hardcoded
    //   `LEONARDO_MODELS.filter((m) => m.id !== 'nano-banana')`
    // which ignored the user's Studio Mode selection entirely — a user
    // who deselected MiniMax still got MiniMax in pipeline runs. Now
    // reads getEnabledModelIds() (backed by localStorage.mashup_comparison_models).
    // Falls back to "all Leonardo models minus nano-banana" when the
    // selection list is empty so brand-new users without persisted
    // settings still get a working pipeline. The nano-banana exclusion
    // is reapplied on top of the user list as defense-in-depth — the UI
    // default seeds ALL models including nano-banana, and we don't want
    // a regression sneaking in via the default-on-first-launch path.
    const selectedIds = getEnabledModelIds();
    const fallbackIds = LEONARDO_MODELS.filter((m) => m.id !== 'nano-banana').map((m) => m.id);
    const leonardoMinimaxIds = (selectedIds.length > 0 ? selectedIds : fallbackIds).filter((id) => id !== 'nano-banana');
    // V1.7.0-PIPELINE-HIGGSFIELD: when the user has enabled Higgsfield and
    // configured at least one model, add those `higgsfield:<slug>` ids to
    // the generation set so the pipeline ACTUALLY uses Higgsfield (it
    // previously couldn't — generateComparison only knew Leonardo/MiniMax,
    // so a Higgsfield-toggled run silently produced Leonardo images). The
    // comparison path now routes these ids to the real Higgsfield backend.
    const higgsfieldIds = (settings.higgsfieldEnabled && settings.higgsfieldImageModels?.length)
      ? settings.higgsfieldImageModels.map((slug) => `higgsfield:${slug}`)
      : [];
    const allModelIds = [...leonardoMinimaxIds, ...higgsfieldIds];
    if (allModelIds.length === 0) {
      // User deselected every image model in Studio Mode. Pipeline can't
      // generate anything; bail with an actionable error instead of
      // silently calling triggerImageGeneration with an empty list (which
      // produces a generic timeout downstream).
      const msg = 'No image models selected — enable at least one in Studio Mode Compare picker';
      addLog('image-gen', idea.id, 'error', msg);
      throw new Error(msg);
    }
    setPipelineProgress({
      current: index + 1,
      total,
      currentStep: `Generating with ${allModelIds.length} models`,
      currentIdea: idea.concept,
      currentIdeaId: idea.id,
    });
    writeCheckpoint('Generating images');
    try {
      await triggerImageGeneration(expandedPrompt, allModelIds, trendingContext);
      addLog('image-gen', idea.id, 'success', `Image generation started with ${allModelIds.length} models`);
    } catch (e) {
      addLog('image-gen', idea.id, 'error', 'Image generation failed');
      throw e;
    }

    // Wait for images to appear (injectable — tests mock this to return immediately)
    readyImages = await waitForImages(allModelIds.length);
  }
  const carouselMode = settings.pipelineCarouselMode ?? false;

  if (readyImages.length === 0) {
    // Timeout — log and continue so the idea still gets marked done
    addLog('image-ready', idea.id, 'error', 'Timed out waiting for any image');
  } else if (carouselMode && readyImages.length > 1) {
    // ── Carousel mode ──────────────────────────────────────────────────────
    addLog(
      'image-ready',
      idea.id,
      'success',
      `${readyImages.length} images ready — carousel mode`,
    );
    for (const img of readyImages) savePipelineImage(img);
    writeCheckpoint('Captioning carousel');

    let sharedCaption = '';
    let sharedHashtags: string[] | undefined;
    if (autoCaption) {
      setPipelineProgress({
        current: index + 1,
        total,
        currentStep: `Captioning carousel (${readyImages.length} images)`,
        currentIdea: idea.concept,
        currentIdeaId: idea.id,
      });
      try {
        checkSkip(isSkipRequested);
        const withCaption = await generatePostContent(readyImages[0]);
        if (withCaption) {
          sharedCaption = withCaption.postCaption || '';
          sharedHashtags = withCaption.postHashtags;
          savePipelineImage(withCaption);
          addLog('caption', idea.id, 'success', `[carousel] Caption generated`);
        } else {
          sharedCaption = captionFallback;
          addLog('caption', idea.id, 'error', '[carousel] Caption returned empty — using prompt as fallback');
        }
      } catch (e) {
        if (e instanceof SkipIdeaSignal) throw e;
        sharedCaption = captionFallback;
        addLog('caption', idea.id, 'error', '[carousel] Caption failed — using prompt as fallback');
      }
    }

    checkSkip(isSkipRequested);

    if (autoSchedule) {
      setPipelineProgress({
        current: index + 1,
        total,
        currentStep: 'Scheduling carousel',
        currentIdea: idea.concept,
        currentIdeaId: idea.id,
      });
      // BUG-CRIT-009: always create the ScheduledPost (with empty
      // `platforms` when none are configured) so the approval queue
      // has an entry that can later clear `pipelinePending` on the
      // images. Without this, a pipeline run with autoSchedule=true
      // but no platforms would orphan its pipelinePending images
      // (hidden from Gallery, no approval card to release them).
      {
        const nowStamp = Date.now();
        const groupId = `carousel-${nowStamp}-${Math.random().toString(36).slice(2, 9)}`;
        const allPosts = [...getScheduledPosts(), ...accumulatedPosts];
        const slot = findNextAvailableSlot(
          allPosts,
          engagement,
          pipelinePlatforms,
          settings.pipelineDailyCaps,
        );
        const carouselStatus = resolvePipelinePostStatus(
          pipelinePlatforms,
          settings.pipelineAutoApprove,
        );
        // V040-HOTFIX-004: keep CarouselGroup.status in sync with the
        // per-post status. CarouselGroup has no `pending_approval`
        // value of its own, so a queue of posts that still need
        // approval is represented as `draft` — accurate to the
        // CarouselGroup type and consistent with how user-built
        // groups in the gallery start out (also 'draft').
        const carouselGroupStatus: 'scheduled' | 'draft' =
          carouselStatus === 'scheduled' ? 'scheduled' : 'draft';
        const newPosts: ScheduledPost[] = readyImages.map((img, idx) => ({
          id: `post-${nowStamp}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
          imageId: img.id,
          date: slot.date,
          time: slot.time,
          platforms: pipelinePlatforms,
          caption: sharedCaption,
          status: carouselStatus,
          carouselGroupId: groupId,
          sourceIdeaId: idea.id,
        }));
        // V1.3: compute virality score for the carousel's shared caption.
        // Compute once and stamp on all posts in the group.
        if (carouselStatus === 'pending_approval' && sharedCaption && deps.computeViralityScore) {
          try {
            const score = await deps.computeViralityScore(sharedCaption);
            if (score !== null) {
              for (const p of newPosts) p.viralityScore = score;
            }
          } catch {
            // virality computation failed — leave viralityScore undefined
          }
        }
        accumulatedPosts.push(...newPosts);
        updateSettings((prev) => ({
          scheduledPosts: [...(prev.scheduledPosts || []), ...newPosts],
          carouselGroups: [
            ...(prev.carouselGroups || []),
            {
              id: groupId,
              imageIds: readyImages.map((i) => i.id),
              caption: sharedCaption,
              hashtags: sharedHashtags,
              scheduledDate: slot.date,
              scheduledTime: slot.time,
              platforms: pipelinePlatforms,
              status: carouselGroupStatus,
            },
          ],
        }));
        addLog('schedule', idea.id, 'success', `[carousel ${readyImages.length}×] ${slot.reason}`);
      }
    }
  } else {
    // ── Single / per-model mode ─────────────────────────────────────────────
    addLog(
      'image-ready',
      idea.id,
      'success',
      `${readyImages.length} image${readyImages.length === 1 ? '' : 's'} ready`,
    );

    // Persist all images upfront so they're visible during captioning.
    for (const img of readyImages) savePipelineImage(img);

    // PROP-017 / OPT-001 — caption phase. Single-model stays sequential
    // (preserves prior behavior + checkpoint label). Multi-model fans out
    // through a concurrency-bounded pool so 3–6 sequential pi.dev calls
    // collapse to ⌈N/3⌉ batches. Per-image errors fall back to the prompt
    // exactly like the sequential path did (allSettled semantics).
    const labelOf = (img: GeneratedImage, idx: number) =>
      img.modelInfo?.modelName ?? `model-${idx + 1}`;
    const captionedImages: GeneratedImage[] = [...readyImages];

    if (autoCaption && readyImages.length > 1) {
      writeCheckpoint(`Captioning ${readyImages.length} models in parallel`);
      setPipelineProgress({
        current: index + 1,
        total,
        currentStep: `Captioning ${readyImages.length} models in parallel`,
        currentIdea: idea.concept,
        currentIdeaId: idea.id,
      });
      checkSkip(isSkipRequested);
      const t0 = Date.now();
      const settled = await runWithConcurrency(
        readyImages,
        CAPTION_PARALLEL_LIMIT,
        (img) => generatePostContent(img),
      );
      const elapsedMs = Date.now() - t0;
      let okCount = 0;
      for (let i = 0; i < settled.length; i++) {
        const img = readyImages[i];
        const modelLabel = labelOf(img, i);
        const r = settled[i];
        if (r.status === 'fulfilled' && r.value) {
          captionedImages[i] = r.value;
          savePipelineImage(r.value);
          addLog('caption', idea.id, 'success', `[${modelLabel}] Caption generated`);
          okCount++;
        } else if (r.status === 'fulfilled') {
          captionedImages[i] = { ...img, postCaption: captionFallback };
          addLog('caption', idea.id, 'error', `[${modelLabel}] Caption returned empty — using prompt as fallback`);
        } else {
          captionedImages[i] = { ...img, postCaption: captionFallback };
          addLog('caption', idea.id, 'error', `[${modelLabel}] Caption failed — using prompt as fallback`);
        }
      }
      addLog(
        'caption',
        idea.id,
        'success',
        `[parallel] ${okCount}/${readyImages.length} captioned in ${elapsedMs}ms (limit=${CAPTION_PARALLEL_LIMIT})`,
      );
    } else if (autoCaption) {
      // Single image — keep the sequential path verbatim for parity with
      // the prior behavior (per-model checkpoint label + per-call progress).
      const img = readyImages[0];
      const modelLabel = labelOf(img, 0);
      writeCheckpoint(`Captioning ${modelLabel}`);
      setPipelineProgress({
        current: index + 1,
        total,
        currentStep: `Captioning ${modelLabel}`,
        currentIdea: idea.concept,
        currentIdeaId: idea.id,
      });
      const t0 = Date.now();
      try {
        const withCaption = await generatePostContent(img);
        if (withCaption) {
          captionedImages[0] = withCaption;
          savePipelineImage(withCaption);
          addLog('caption', idea.id, 'success', `[${modelLabel}] Caption generated in ${Date.now() - t0}ms`);
        } else {
          captionedImages[0] = { ...img, postCaption: captionFallback };
          addLog('caption', idea.id, 'error', `[${modelLabel}] Caption returned empty — using prompt as fallback`);
        }
      } catch {
        captionedImages[0] = { ...img, postCaption: captionFallback };
        addLog('caption', idea.id, 'error', `[${modelLabel}] Caption failed — using prompt as fallback`);
      }
    }

    // Scheduling phase — sequential, one ScheduledPost per (now captioned)
    // image. Order-preserving (captionedImages[i] ↔ readyImages[i]).
    for (let imgIdx = 0; imgIdx < captionedImages.length; imgIdx++) {
      checkSkip(isSkipRequested);
      const img = readyImages[imgIdx];
      const captionedImg = captionedImages[imgIdx];
      const modelLabel = labelOf(img, imgIdx);

      if (autoSchedule) {
        setPipelineProgress({
          current: index + 1,
          total,
          currentStep: `Scheduling ${modelLabel}`,
          currentIdea: idea.concept,
          currentIdeaId: idea.id,
        });
        // BUG-CRIT-009: always create the ScheduledPost (with empty
        // `platforms` when none are configured) so the approval queue
        // has an entry that can later clear `pipelinePending` on the
        // image. Without this, an autoSchedule=true run with missing
        // platform credentials would orphan its pipelinePending image
        // (hidden from Gallery, no approval card to release it).
        {
          const allPosts = [...getScheduledPosts(), ...accumulatedPosts];
          const slot = findNextAvailableSlot(
            allPosts,
            engagement,
            pipelinePlatforms,
            settings.pipelineDailyCaps,
          );
          const newPost: ScheduledPost = {
            id: `post-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            imageId: img.id,
            date: slot.date,
            time: slot.time,
            platforms: pipelinePlatforms,
            caption: captionedImg.postCaption || '',
            status: resolvePipelinePostStatus(
              pipelinePlatforms,
              settings.pipelineAutoApprove,
            ),
            sourceIdeaId: idea.id,
          };
          // V1.3: compute virality score when post enters pending_approval.
          // Fire-and-forget — we do NOT await this call so the
          // pipeline doesn't block on a synchronous text-generation
          // round-trip. The score lands on the post record a few
          // seconds later; the UI shows a "computing…" placeholder
          // until the score arrives, then updates via the settings
          // subscription. A failed score leaves the field undefined
          // and the badge hidden — non-fatal.
          if (newPost.status === 'pending_approval' && newPost.caption && deps.computeViralityScore) {
            const caption = newPost.caption;
            void deps.computeViralityScore(caption).then((score) => {
              if (score !== null) {
                newPost.viralityScore = score;
              }
            });
          }
          accumulatedPosts.push(newPost);
          updateSettings((prev) => ({
            scheduledPosts: [...(prev.scheduledPosts || []), newPost],
          }));
          addLog('schedule', idea.id, 'success', `[${modelLabel}] ${slot.reason}`);
        }
      }
    }
  }

  // Step h — mark done
  updateIdeaStatus(idea.id, 'done');
  addLog('complete', idea.id, 'success', `"${idea.concept}" pipeline complete`);
}
