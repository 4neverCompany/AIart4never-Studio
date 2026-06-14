'use client';

import React, { createContext, useContext, useState, useEffect, useMemo, useRef, ReactNode } from 'react';
import { useStableCallbacks } from '../hooks/useStableCallback';

// Re-export everything from types/mashup so existing imports keep working
export {
  type GeneratedImage,
  type Collection,
  type GenerateOptions,
  type WatermarkSettings,
  type AgentPersonality,
  type Idea,
  type ScheduledPost,
  type CarouselGroup,
  type UserSettings,
  type ViewType,
  type MashupContextType,
  type PipelineLogEntry,
  type PipelineProgress,
  RECOMMENDED_NICHES,
  RECOMMENDED_GENRES,
  LEONARDO_MODELS,
  MODEL_PROMPT_GUIDES,
  ART_STYLES,
  LIGHTING_OPTIONS,
  CAMERA_ANGLES,
  ASPECT_RATIOS,
  IMAGE_SIZES,
  defaultSettings,
} from '../types/mashup';

import type { MashupContextType, ViewType, GeneratedImage } from '../types/mashup';

// Import hooks
import { useSettings } from '../hooks/useSettings';
import { useImages } from '../hooks/useImages';
import { useCollections } from '../hooks/useCollections';
import { useImageGeneration, applyWatermark } from '../hooks/useImageGeneration';
import { useComparison } from '../hooks/useComparison';
import { useIdeas } from '../hooks/useIdeas';
import { useSocial } from '../hooks/useSocial';
import { usePipeline } from '../hooks/usePipeline';
import { collectFinalizeTargets, finalizePipelineImage } from '../lib/pipeline-finalize';
import { persistApprovedImageToDisk } from '../lib/images/storage';
import { applyCaptionEdit } from '../lib/caption-edit';
import { planApproveScheduledPost, planRejectScheduledPost } from '../lib/approval-actions';
import { recordOutcome } from '../lib/outcome-tracker';
import {
  applyTransition,
  postIdFromScheduledPostId,
} from '../lib/post-lifecycle/migration';

const MashupContext = createContext<MashupContextType | null>(null);

export function useMashup() {
  const ctx = useContext(MashupContext);
  if (!ctx) throw new Error('useMashup must be used within MashupProvider');
  return ctx;
}

export function MashupProvider({ children }: { children: ReactNode }) {
  // UI state
  const [view, setView] = useState<ViewType>('studio');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Core hooks — order matters for dependencies
  const { settings, updateSettings, clearSettings, isSettingsLoaded, saveState: settingsSaveState, requestLoad: requestSettingsLoad } = useSettings();

  const imagesHook = useImages();
  const {
    savedImages,
    saveImage,
    deleteImage,
    removeImages,
    updateImageTags,
    bulkUpdateImageTags,
    toggleApproveImage: toggleApproveSaved,
    setImageStatus,
    updateSavedImageCollectionId,
    clearCollectionFromImages,
    isImagesLoaded,
    requestLoad: requestImagesLoad,
  } = imagesHook;

  // V1.4.3-IMAGE-RECOVERY: on cold start, if the gallery is empty
  // but the v1.3.2 backup field has entries, restore them. The NSIS
  // uninstaller wipes %APPDATA% on reinstall, so the user lost their
  // gallery despite the backup module writing to `mashup_saved_images_backup`
  // in the same JSON blob. This migration is idempotent (a flag
  // prevents re-runs) and tries to download each backup URL to disk
  // so future reinstalls survive via the v1.3.4 file-per-image
  // storage.
  useEffect(() => {
    if (!isImagesLoaded) return
    if (savedImages.length > 0) return
    let cancelled = false
    ;(async () => {
      try {
        const { restoreFromJsonBackupField } = await import('@/lib/backup/recovery')
        const report = await restoreFromJsonBackupField()
        if (cancelled) return
        if (report.restored > 0) {
          // Re-trigger the images load so the gallery shows the
          // restored images.
          if (typeof requestImagesLoad === 'function') {
            requestImagesLoad()
          }
        }
      } catch {
        // Non-fatal — the user can still manually restore from
        // Settings → Image Backup → Restore.
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isImagesLoaded])

  const collectionsHook = useCollections(settings);
  const {
    collections,
    createCollection,
    deleteCollection,
    autoGenerateCollectionInfo,
    isCollectionsLoaded,
    requestLoad: requestCollectionsLoad,
  } = collectionsHook;

  const generationHook = useImageGeneration({ settings, updateImageTags });
  const {
    images,
    setImages,
    isGenerating,
    progress,
    generationError,
    clearGenerationError,
    generateImages,
    rerollImage,
    generateNegativePrompt,
    autoTagImage,
    setImageStatus: setGenImageStatus,
  } = generationHook;

  const comparisonHook = useComparison({ settings, saveImage, applyWatermark });
  const {
    comparisonResults,
    comparisonPrompt,
    setComparisonPrompt,
    comparisonOptions,
    setComparisonOptions,
    generateComparison,
    pickComparisonWinner,
    clearComparison,
    deleteComparisonResult,
    comparisonError,
    clearComparisonError,
    requestLoad: requestComparisonLoad,
  } = comparisonHook;

  const ideasHook = useIdeas();
  const {
    ideas,
    addIdea,
    updateIdeaStatus,
    deleteIdea,
    clearIdeas,
    isIdeasLoaded,
    requestLoad: requestIdeasLoad,
  } = ideasHook;

  const socialHook = useSocial({ settings, saveImage, setImages });
  const { generatePostContent } = socialHook;

  // Auto-tag any saved image that lacks tags. Tracks attempted ids in a
  // ref so a failed attempt (e.g. pi is down) doesn't spam retries on
  // every render. Runs a low-priority queue, one image at a time.
  const autoTagAttemptedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const needsTagging = savedImages.find(
      (img) =>
        img.status === 'ready' &&
        (!img.tags || img.tags.length === 0) &&
        !autoTagAttemptedRef.current.has(img.id)
    );
    if (!needsTagging) return;
    autoTagAttemptedRef.current.add(needsTagging.id);
    // Fire and forget — autoTagImage updates the store on success.
    // Pass the saved image directly so autoTagImage doesn't need to
    // look it up in the ephemeral `images` array (which may have been
    // cleared by now).
    autoTagImage(needsTagging.id, needsTagging).catch(() => {});
  }, [savedImages, autoTagImage]);

  const pipelineHook = usePipeline({
    ideas,
    settings,
    // V082-FIX-SETTINGS-HYDRATE: thread isSettingsLoaded through to
    // both the auto-start guard in usePipeline AND the runOuterLoop
    // pre-cycle check in usePipelineDaemon. Without this, a cold
    // mount with persisted settings could auto-start a generation
    // cycle on a week that's already been published — because
    // settings.scheduledPosts starts as the default ([]) until the
    // IDB load lands.
    isSettingsLoaded,
    updateSettings,
    updateIdeaStatus,
    addIdea,
    generateComparison,
    generatePostContent,
    saveImage,
    deleteImage,
    savedImages,
    images,
  });

  // Approval flow for pending_approval scheduled posts. Pipeline-
  // produced posts land in that status and need explicit action before
  // the auto-poster will pick them up.
  // Functional updater so rapid bulk-approve/reject (e.g. clicking
  // through a dozen pending_approval cards in quick succession) chains
  // off the latest state instead of all reading the same closure snapshot.
  //
  // V040-HOTFIX-007: approval also "finalizes" the pipeline-pending
  // images the post references — flips `pipelinePending:false` so
  // Gallery renders them, and applies the watermark that the pipeline
  // run never applied (the generateComparison path skips watermark,
  // unlike pickComparisonWinner's finalize step). Flag flip is
  // synchronous so Gallery lights up immediately; watermark is applied
  // best-effort in the background and swaps the URL when ready.
  // BUG-CRIT-013: `markPostReady` flips `isPostReady: true` on each
  // finalized image so it surfaces in the Post Ready tab. Approve path
  // passes true (scheduled content belongs in Post Ready); reject path
  // passes false (rejected images land in Gallery only).
  const finalizePipelineImagesForPosts = (
    posts: import('../types/mashup').ScheduledPost[],
    markPostReady: boolean,
  ) => {
    for (const post of posts) {
      const targets = collectFinalizeTargets(post, savedImages);
      if (targets.length === 0) continue;
      // Step 1 — instant flag flip: Gallery renders these now.
      for (const img of targets) {
        saveImage({
          ...img,
          pipelinePending: false,
          ...(markPostReady ? { isPostReady: true } : {}),
        });
      }
      // Step 2 — background watermark pass. Best-effort: failures keep
      // the original URL (handled inside finalizePipelineImage).
      // BUG-DEV-004: per-image catch surfaces unexpected failures
      // (saveImage IDB quota, etc.) that escape finalizePipelineImage's
      // internal try/catch. Without this, a Promise.all rejection from
      // any image silently aborts the rest of the batch.
      //
      // V1.5-LOCAL-SAVE: after the (optional) watermark, persist the
      // APPROVED image to disk — the canonical app-data store AND a
      // discoverable Documents\MashupForge\Images copy — so the
      // approved post exists as a real local file (the watermarked
      // pixels previously lived only in the IDB `url`). Off-Tauri this
      // is a no-op (persistApprovedImageToDisk returns null).
      if (markPostReady) {
        void Promise.all(
          targets.map(async (img) => {
            try {
              // Apply the watermark first when enabled so the saved
              // file carries the mark the user approved.
              let finalImg = img;
              if (settings.watermark?.enabled) {
                finalImg = await finalizePipelineImage(
                  img,
                  settings.watermark,
                  settings.channelName,
                  applyWatermark,
                  markPostReady,
                );
                saveImage(finalImg);
              }
              if (finalImg.url) {
                const localPath = await persistApprovedImageToDisk(
                  finalImg.url,
                  finalImg.id,
                  finalImg.savedAt ?? Date.now(),
                );
                if (localPath) saveImage({ ...finalImg, localPath });
              }
            } catch (err) {
              console.warn('[MashupContext] finalize/persist failed for', img.id, err);
            }
          }),
        );
      } else if (settings.watermark?.enabled) {
        // Reject path: still apply the watermark for Gallery display,
        // but don't write a discoverable Documents copy (only approved
        // posts are exported as local files).
        void Promise.all(
          targets.map(async (img) => {
            try {
              const finalized = await finalizePipelineImage(
                img,
                settings.watermark,
                settings.channelName,
                applyWatermark,
                markPostReady,
              );
              saveImage(finalized);
            } catch (err) {
              console.warn('[MashupContext] finalize/save failed for', img.id, err);
            }
          }),
        );
      }
    }
  };

  // BUG-CRIT-012: read the target post from the rendered settings
  // snapshot BEFORE updateSettings rather than from inside the
  // functional updater. The old shape relied on React's "eager state
  // update" optimization (the functional updater runs synchronously
  // only when the queue is empty) — which silently broke for the 2nd+
  // call in a row. CarouselApprovalCard fans out N approve calls back-
  // to-back, so images 2..N got status='scheduled' but kept
  // pipelinePending=true (hidden from Gallery, no watermark).
  //
  // Post-lifecycle: layer the new applyTransition() call on top of
  // the legacy settings update. The legacy `updateSettings` keeps
  // the PipelinePanel / approval UI in sync (status flips to
  // 'scheduled'); the applyTransition call updates the new
  // PostRecord state machine so the next stage of the pipeline can
  // move the post forward (captioning → scheduled → posting →
  // posted). The migration bridge in applyTransition also mirrors
  // the new state back to settings.scheduledPosts — that's a
  // safety net for any caller that hasn't run the legacy update.
  // For callers that DID run the legacy update (this one), the
  // mirror's write is wasted but harmless.
  const approveScheduledPost = (postId: string) => {
    const { toFinalize, nextPosts } = planApproveScheduledPost(
      settings.scheduledPosts || [],
      postId,
    );
    if (toFinalize.length === 0) return;
    updateSettings((prev) => ({
      scheduledPosts: nextPosts(prev.scheduledPosts || []),
    }));
    finalizePipelineImagesForPosts(toFinalize, true);
    // Fire-and-forget: best-effort transition to the new system. The
    // applyTransition call is idempotent on same-state, and any
    // failure (post not in storage yet, etc.) is logged and ignored
    // — the legacy update is the source of truth for the UI.
    // skipMirror: true because the synchronous updateSettings above
    // already set the legacy status to 'scheduled'; the mirror-back
    // in applyTransition would otherwise overwrite it to
    // 'pending_approval' (the new 'image_ready' state maps there in
    // syncLegacyScheduledPost).
    void (async () => {
      try {
        await applyTransition(
          postIdFromScheduledPostId(postId),
          'image_ready',
          { note: 'Approved by user' },
          { skipMirror: true },
        );
      } catch (err) {
        // Expected for posts that exist only in the legacy field
        // (no migrated PostRecord yet) — the legacy path still
        // works. Logged at warn to avoid spamming the console.
        console.warn('[MashupContext] applyTransition(approve) failed', err);
      }
    })();
  };

  // V050-009 BUG-DEV-001: status guard mirrors the approve path. Without
  // it, rejecting any post id (e.g. a stale UI reference) would silently
  // flip an already-scheduled / posted / failed post to 'rejected',
  // pulling it out of the auto-poster's view with no recovery path.
  //
  // BUG-DEV-003: also finalize the underlying pipelinePending image(s)
  // so they land in Gallery instead of being orphaned (pipelinePending=true
  // forever, invisible everywhere). Reject means "don't post this", not
  // "delete this asset" — the user already paid the generation cost, so
  // we surface the image in Gallery (watermarked, like approve does) and
  // let them delete it explicitly if they really don't want it. Carousel
  // siblings are released as a group via collectFinalizeTargets.
  // BUG-CRIT-012: same closure-timing fix as approveScheduledPost.
  // Carousel "Reject carousel" fans out N reject calls; without the
  // pre-update lookup, only the first image landed in Gallery.
  //
  // Post-lifecycle: layer applyTransition() on top of the legacy
  // update. The new PostRecord transitions back to 'draft' so the
  // user can edit and re-approve; the legacy field flips to
  // 'rejected' so the UI hides the post from the auto-poster. The
  // mirror-back from applyTransition would write 'pending_approval'
  // (because 'draft' maps to 'pending_approval' in syncLegacyScheduledPost)
  // — that's a no-op concern because the synchronous updateSettings
  // call has already set the legacy status to 'rejected', and the
  // migration bridge's mirror happens AFTER our synchronous write.
  // The brief inconsistency is acceptable: the next reconciliation
  // pass or the next user-initiated state change will settle it.
  const rejectScheduledPost = (postId: string) => {
    const { toFinalize, nextPosts } = planRejectScheduledPost(
      settings.scheduledPosts || [],
      postId,
    );
    if (toFinalize.length === 0) return;
    updateSettings((prev) => ({
      scheduledPosts: nextPosts(prev.scheduledPosts || []),
    }));
    finalizePipelineImagesForPosts(toFinalize, false);
    // Record rejection outcome for each post's image (feedback loop scaffold).
    for (const post of toFinalize) {
      const img = [...images, ...savedImages].find((i) => i.id === post.imageId);
      if (img) {
        recordOutcome({
          imageId: img.id,
          prompt: img.prompt,
          style: img.style ?? '',
          aspectRatio: img.aspectRatio ?? '',
          model: img.modelInfo?.modelName ?? img.modelInfo?.modelId ?? '',
          status: 'rejected',
          platform: post.platforms.join(','),
          timestamp: Date.now(),
        });
      }
    }
    // Fire-and-forget post-lifecycle transition. Rejected posts go
    // back to 'draft' in the new system so the user can re-edit
    // and re-approve. Idempotent on same-state; failures (post
    // not yet migrated) are logged and ignored.
    // skipMirror: true because the synchronous updateSettings above
    // already set the legacy status to 'rejected'; the mirror-back
    // in applyTransition would otherwise overwrite it to
    // 'pending_approval' (the new 'draft' state maps there in
    // syncLegacyScheduledPost).
    void (async () => {
      try {
        await applyTransition(
          postIdFromScheduledPostId(postId),
          'draft',
          { note: 'Rejected by user' },
          { skipMirror: true },
        );
      } catch (err) {
        console.warn('[MashupContext] applyTransition(reject) failed', err);
      }
    })();
  };

  // Bulk variants — single functional-updater pass so N approvals applied
  // in a single click don't race against each other or the auto-poster.
  //
  // Post-lifecycle: layer applyTransition() on top of the legacy
  // updateSettings, one call per post. Fire-and-forget per post; the
  // loop is non-blocking and failures are logged. Mirrors the singular
  // approveScheduledPost path.
  const bulkApproveScheduledPosts = (postIds: string[]) => {
    if (postIds.length === 0) return;
    const idSet = new Set(postIds);
    let approvedPosts: import('../types/mashup').ScheduledPost[] = [];
    updateSettings((prev) => {
      approvedPosts = (prev.scheduledPosts || []).filter(
        (p) => idSet.has(p.id) && p.status === 'pending_approval',
      );
      return {
        scheduledPosts: (prev.scheduledPosts || []).map((p) =>
          idSet.has(p.id) && p.status === 'pending_approval'
            ? { ...p, status: 'scheduled' as const }
            : p
        ),
      };
    });
    if (approvedPosts.length > 0) finalizePipelineImagesForPosts(approvedPosts, true);
    // Post-lifecycle transitions. We dispatch them in parallel and
    // do not await the result — the UI is already updated by the
    // synchronous updateSettings call, and the post-lifecycle call
    // is a best-effort annotation of the new system.
    // skipMirror: true for the same reason as the singular path —
    // the synchronous updateSettings already wrote the legacy
    // status, the mirror-back would overwrite it incorrectly.
    for (const post of approvedPosts) {
      void (async () => {
        try {
          await applyTransition(
            postIdFromScheduledPostId(post.id),
            'image_ready',
            { note: 'Bulk approved by user' },
            { skipMirror: true },
          );
        } catch (err) {
          console.warn('[MashupContext] applyTransition(bulk approve) failed for', post.id, err);
        }
      })();
    }
  };

  // V050-009 BUG-DEV-001: same status guard as the singular reject —
  // bulk reject must only touch pending_approval posts. Mirrors the
  // bulkApprove guard at lines 226-229.
  //
  // BUG-DEV-003: same finalize-on-reject as the singular path — releases
  // pipelinePending images to Gallery in a single batch.
  //
  // Post-lifecycle: layer applyTransition('draft') on top, one call
  // per rejected post. See bulkApproveScheduledPosts for the
  // fire-and-forget rationale.
  const bulkRejectScheduledPosts = (postIds: string[]) => {
    if (postIds.length === 0) return;
    const idSet = new Set(postIds);
    let rejectedPosts: import('../types/mashup').ScheduledPost[] = [];
    updateSettings((prev) => {
      rejectedPosts = (prev.scheduledPosts || []).filter(
        (p) => idSet.has(p.id) && p.status === 'pending_approval',
      );
      return {
        scheduledPosts: (prev.scheduledPosts || []).map((p) =>
          idSet.has(p.id) && p.status === 'pending_approval'
            ? { ...p, status: 'rejected' as const }
            : p
        ),
      };
    });
    if (rejectedPosts.length > 0) finalizePipelineImagesForPosts(rejectedPosts, false);
    for (const post of rejectedPosts) {
      void (async () => {
        try {
          await applyTransition(
            postIdFromScheduledPostId(post.id),
            'draft',
            { note: 'Bulk rejected by user' },
            { skipMirror: true },
          );
        } catch (err) {
          console.warn('[MashupContext] applyTransition(bulk reject) failed for', post.id, err);
        }
      })();
    }
  };

  // V050-005: inline caption editing from the approval queue. Updates
  // every targeted post's caption and the matching CarouselGroup's
  // caption (if all the post ids belong to one) in a single
  // updateSettings pass so the UI never sees a half-applied state.
  const updateScheduledPostsCaption = (postIds: string[], caption: string) => {
    if (postIds.length === 0) return;
    updateSettings((prev) => applyCaptionEdit(
      prev.scheduledPosts || [],
      prev.carouselGroups || [],
      postIds,
      caption,
    ));
  };

  // Compose loading state
  const isLoaded = isSettingsLoaded && isImagesLoaded && isCollectionsLoaded && ideasHook.isIdeasLoaded;

  // Cross-hook wrappers
  const handleCreateCollection = async (name?: string, description?: string, imageIds?: string[]) => {
    return createCollection(name, description, imageIds, savedImages);
  };

  const addImageToCollection = (imageId: string, collectionId: string) => {
    updateSavedImageCollectionId(imageId, collectionId);
  };

  const removeImageFromCollection = (imageId: string) => {
    updateSavedImageCollectionId(imageId, undefined);
  };

  // toggleApproveImage must update both images[] and savedImages[]
  const handleToggleApprove = (id: string) => {
    toggleApproveSaved(id);
    setImages(prev => prev.map(img => img.id === id ? { ...img, approved: !img.approved } : img));
  };

  // setImageStatus wrapper that updates both arrays
  const handleSetImageStatus = (id: string, status: 'generating' | 'animating' | 'ready') => {
    setGenImageStatus(id, status);
  };

  // ── M3.1 render-perf (V1.8) ────────────────────────────────────────
  // Every function field goes through ONE identity-stable bag. The
  // source hooks (useImages, useImageGeneration, useSocial, …) don't
  // useCallback their functions, so before this every provider render
  // handed every consumer ~50 fresh function identities — React.memo
  // on expensive children (GalleryCard) could never bail out, and a
  // pipeline-log tick re-rendered the entire tree. The stable wrappers
  // always dispatch to the latest implementation (useEvent semantics),
  // so behavior is unchanged; only identity is pinned. NOT for
  // render-phase calls — every field here is an event/effect handler.
  const stableFns = useStableCallbacks({
    setView,
    setImages,
    updateSettings,
    clearSettings,
    generateImages,
    generatePostContent,
    rerollImage,
    saveImage,
    deleteImage,
    removeImages,
    updateImageTags,
    createCollection: handleCreateCollection,
    bulkUpdateImageTags,
    deleteCollection,
    addImageToCollection,
    removeImageFromCollection,
    toggleApproveImage: handleToggleApprove,
    generateComparison,
    autoTagImage,
    setImageStatus: handleSetImageStatus,
    autoGenerateCollectionInfo,
    pickComparisonWinner,
    clearComparison,
    deleteComparisonResult,
    clearGenerationError,
    clearComparisonError,
    generateNegativePrompt,
    setComparisonPrompt,
    setComparisonOptions,
    addIdea,
    updateIdeaStatus,
    deleteIdea,
    clearIdeas,
    // V1.2.1: lazy load triggers. The Gallery/Collections/Ideas views
    // call these on mount so the persistence layer doesn't eagerly
    // JSON.parse a 100+ MB mashupforge.json at studio mount time.
    // Settings load is fired by MainContent on mount (right after
    // studio renders) so the user sees their real settings within a
    // few seconds; the studio itself mounts instantly with default
    // settings, then their actual settings hydrate.
    requestImagesLoad,
    requestCollectionsLoad,
    requestIdeasLoad,
    requestSettingsLoad,
    requestComparisonLoad,
    setIsSidebarOpen,
    setPipelineDelay: pipelineHook.setPipelineDelay,
    togglePipeline: pipelineHook.togglePipeline,
    startPipeline: pipelineHook.startPipeline,
    stopPipeline: pipelineHook.stopPipeline,
    skipCurrentIdea: pipelineHook.skipCurrentIdea,
    toggleContinuous: pipelineHook.toggleContinuous,
    setPipelineInterval: pipelineHook.setPipelineInterval,
    setPipelineTargetDays: pipelineHook.setPipelineTargetDays,
    setPipelineIdeasPerCycle: pipelineHook.setPipelineIdeasPerCycle,
    clearPipelineLog: pipelineHook.clearPipelineLog,
    approveScheduledPost,
    rejectScheduledPost,
    bulkApproveScheduledPosts,
    bulkRejectScheduledPosts,
    updateScheduledPostsCaption,
    acceptResume: pipelineHook.acceptResume,
    dismissResume: pipelineHook.dismissResume,
  });

  // The value object is memoized on DATA fields only (stableFns never
  // changes identity). Consumers still re-render when data they read
  // changes — but a provider re-render whose data is untouched (or a
  // memo'd child whose props are untouched) can now bail out.
  const value: MashupContextType = useMemo(() => ({
    isLoaded,
    view,
    images,
    savedImages,
    collections,
    isGenerating,
    progress,
    settings,
    settingsSaveState,
    comparisonResults,
    generationError,
    comparisonError,
    comparisonPrompt,
    comparisonOptions,
    ideas,
    isSidebarOpen,
    pipelineEnabled: pipelineHook.pipelineEnabled,
    pipelineRunning: pipelineHook.pipelineRunning,
    pipelineQueue: pipelineHook.pipelineQueue,
    pipelineProgress: pipelineHook.pipelineProgress,
    pipelineLog: pipelineHook.pipelineLog,
    pipelineDelay: pipelineHook.pipelineDelay,
    pipelineContinuous: pipelineHook.pipelineContinuous,
    pipelineInterval: pipelineHook.pipelineInterval,
    pipelineTargetDays: pipelineHook.pipelineTargetDays,
    pipelineIdeasPerCycle: pipelineHook.pipelineIdeasPerCycle,
    pendingResume: pipelineHook.pendingResume,
    weekFillStatus: pipelineHook.weekFillStatus,
    ...stableFns,
  }), [
    isLoaded,
    view,
    images,
    savedImages,
    collections,
    isGenerating,
    progress,
    settings,
    settingsSaveState,
    comparisonResults,
    generationError,
    comparisonError,
    comparisonPrompt,
    comparisonOptions,
    ideas,
    isSidebarOpen,
    pipelineHook.pipelineEnabled,
    pipelineHook.pipelineRunning,
    pipelineHook.pipelineQueue,
    pipelineHook.pipelineProgress,
    pipelineHook.pipelineLog,
    pipelineHook.pipelineDelay,
    pipelineHook.pipelineContinuous,
    pipelineHook.pipelineInterval,
    pipelineHook.pipelineTargetDays,
    pipelineHook.pipelineIdeasPerCycle,
    pipelineHook.pendingResume,
    pipelineHook.weekFillStatus,
    stableFns,
  ]);

  return (
    <MashupContext.Provider value={value}>
      {children}
    </MashupContext.Provider>
  );
}
