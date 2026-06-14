/**
 * useMainContentScheduling — M3.3-P4 Batch 1 extraction.
 *
 * Owns the manual scheduling + post-publish flow that used to live inline
 * in `components/MainContent.tsx`. Returns a stable bag of handlers and
 * per-card state used by the Post Ready, Captioning, and Calendar views.
 *
 * No behavior changes — this is a pure code-move. Auto-poster (interval
 * worker) lives in `useMainContentAutoPoster` and reads `setPostStatus`
 * from this hook's return so failure toasts land in the same per-card
 * surface the manual path uses.
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useStableCallback, useStableCallbacks } from '@/hooks/useStableCallback';
import { findPostingBlock } from '@/lib/post-approval-gate';
import { ensureHostedUrl, ensureHostedUrls } from '@/lib/upload-to-host';
import { getErrorMessage } from '@/lib/errors';
import { recordOutcome } from '@/lib/outcome-tracker';
import { showToast } from '@/components/Toast';
import { reapplyWatermark } from '@/lib/watermark';
import {
  findBestSlots,
  type SlotScore,
  type ExistingPost,
} from '@/lib/smartScheduler';
import type { GeneratedImage, ScheduledPost } from '@/components/MashupContext';
import type { PostPlatform, UserSettings } from '@/types/mashup';
import { useDesktopConfig } from '@/hooks/useDesktopConfig';

export interface SchedulingBag {
  // Per-card platform selection
  postPlatformSel: Record<string, PostPlatform[]>;
  togglePlatformFor: (id: string, p: PostPlatform) => void;
  getSelectedPlatforms: (id: string) => PostPlatform[];
  /** Memoized list of platforms with valid credentials. Stable identity for memoized children. */
  availablePlatformsList: PostPlatform[];
  /** Non-memoized variant for places that always need a fresh array (e.g. smartScheduler). */
  availablePlatforms: () => PostPlatform[];

  // Per-card date/time pickers
  postSchedule: Record<string, { date: string; time: string }>;
  getSchedule: (id: string) => { date: string; time: string };
  setScheduleFor: (id: string, patch: Partial<{ date: string; time: string }>) => void;

  // Per-card posting state
  postBusy: Record<string, 'posting' | 'scheduling' | null>;
  postStatus: Record<string, string | null>;
  setPostStatus: React.Dispatch<React.SetStateAction<Record<string, string | null>>>;

  // Image patch + caption helpers (shared with captioning view)
  patchImage: (img: GeneratedImage, patch: Partial<GeneratedImage>) => void;
  formatPost: (img: GeneratedImage) => string;
  removeHashtag: (img: GeneratedImage, index: number) => void;
  fanCaptionToGroup: (
    anchor: GeneratedImage,
    rest: GeneratedImage[],
    opts?: { force?: boolean },
  ) => Promise<GeneratedImage | undefined>;
  propagateCaptionToGroup: (
    group: GeneratedImage[],
    caption: string,
    hashtags: string[] | undefined,
    opts?: { skipExisting?: boolean; excludeId?: string },
  ) => void;
  handleReapplyWatermark: (img: GeneratedImage) => Promise<void>;
  copyWithFeedback: (text: string, feedbackKey: string) => Promise<void>;
  copiedId: string | null;

  // Schedule + post operations
  postImageNow: (img: GeneratedImage, platforms: PostPlatform[]) => Promise<void>;
  postCarouselNow: (
    item: Extract<PostItem, { kind: 'carousel' }>,
    platforms: PostPlatform[],
  ) => Promise<void>;
  scheduleImage: (
    img: GeneratedImage,
    platforms: PostPlatform[],
    date: string,
    time: string,
  ) => void;
  scheduleCarousel: (
    item: Extract<PostItem, { kind: 'carousel' }>,
    platforms: PostPlatform[],
    date: string,
    time: string,
  ) => void;
  unschedulePost: (img: GeneratedImage) => void;
  unscheduleCarousel: (images: GeneratedImage[], statusKey: string) => void;
  findScheduleCollision: (
    date: string,
    time: string,
    platforms: readonly string[],
    ignoreImageIds: Set<string>,
    ignoreCarouselGroupId?: string | null,
  ) => ScheduledPost | null;
  findExtraSlots: (
    needed: number,
    existingPosts: ScheduledPost[],
    consumedKeys: Set<string>,
  ) => SlotScore[];
  buildCredentialsPayload: () => {
    instagram: ScheduledPost extends never ? never : unknown;
    twitter: unknown;
    pinterest: unknown;
    discord: { webhookUrl: string | undefined };
  };

  // Calendar/heat-map per-session UI state
  heatmapEnabled: boolean;
  toggleHeatmap: () => void;
  heatmapHover: {
    cellKey: string;
    rect: DOMRect;
    date: Date;
    hour: number;
    isAvailable: boolean;
  } | null;
  setHeatmapHover: React.Dispatch<
    React.SetStateAction<{
      cellKey: string;
      rect: DOMRect;
      date: Date;
      hour: number;
      isAvailable: boolean;
    } | null>
  >;
  heatmapHoverTimer: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;

  // Stable handler bag for memoized PostReadyCard
  postReadyHandlers: {
    onPreviewClick: (img: GeneratedImage) => void;
    onCaptionChange: (img: GeneratedImage, next: string) => void;
    onRemoveHashtag: (img: GeneratedImage, i: number) => void;
    onTogglePlatform: (imgId: string, p: PostPlatform) => void;
    onPostNow: (img: GeneratedImage, platforms: PostPlatform[]) => Promise<void>;
    onSchedule: (
      img: GeneratedImage,
      platforms: PostPlatform[],
      date: string,
      time: string,
    ) => void;
    onCopy: (img: GeneratedImage) => Promise<void>;
    onRegen: (img: GeneratedImage) => Promise<void>;
    onUnready: (img: GeneratedImage) => void;
    onCancelSchedule: (img: GeneratedImage) => void;
    onReapplyWatermark: (img: GeneratedImage) => Promise<void>;
    onGroupingToggle: (imgId: string, checked: boolean) => void;
  };

  // Helper for the post-ready header (active scheduled post per image)
  latestScheduleFor: (imageId: string) => ScheduledPost | undefined;

  // Counterpart of postReadyHandlers for the post-ready tab's own group-selection set
  postReadySelected: Set<string>;
  setPostReadySelected: React.Dispatch<React.SetStateAction<Set<string>>>;

  // Memoized full scheduledPosts list (M3.1b: identity-stable for memoized PostReadyCard).
  allScheduledPosts: ScheduledPost[];
}

// Local re-export of PostItem so this file's consumers don't have to
// import the type directly from lib/carouselView.
type PostItem = import('@/lib/carouselView').PostItem;

interface UseMainContentSchedulingArgs {
  settings: UserSettings;
  updateSettings: (
    patch:
      | Partial<UserSettings>
      | ((prev: UserSettings) => Partial<UserSettings>),
  ) => void;
  savedImages: GeneratedImage[];
  saveImage: (img: GeneratedImage) => void;
  generatePostContent: (img: GeneratedImage) => Promise<GeneratedImage | undefined>;
  setSelectedImage: (img: GeneratedImage) => void;
  setPreparingPostId: (id: string | null) => void;
}

/**
 * Owns all per-card scheduling + post-publish state and handlers.
 * @see components/MainContent.tsx for the call site.
 */
export function useMainContentScheduling({
  settings,
  updateSettings,
  savedImages,
  saveImage,
  generatePostContent,
  setSelectedImage,
  setPreparingPostId,
}: UseMainContentSchedulingArgs): SchedulingBag {
  const { isDesktop, credentials: desktopCreds } = useDesktopConfig();

  // ── Per-card platform selection ────────────────────────────────────
  const [postPlatformSel, setPostPlatformSel] = useState<Record<string, PostPlatform[]>>({});

  // ── Per-card date/time pickers ──────────────────────────────────────
  const [postSchedule, setPostSchedule] = useState<Record<string, { date: string; time: string }>>({});

  // ── Per-card posting state ──────────────────────────────────────────
  const [postBusy, setPostBusy] = useState<Record<string, 'posting' | 'scheduling' | null>>({});
  const [postStatus, setPostStatus] = useState<Record<string, string | null>>({});

  // ── Heat-map overlay (persisted via settings) ──────────────────────
  const [heatmapEnabled, setHeatmapEnabled] = useState<boolean>(
    () => settings.heatmapEnabled ?? false,
  );
  const [heatmapHover, setHeatmapHover] = useState<{
    cellKey: string;
    rect: DOMRect;
    date: Date;
    hour: number;
    isAvailable: boolean;
  } | null>(null);
  const heatmapHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // V040-001: keep React state and persisted setting in sync. Persists
  // through `updateSettings` so it survives page reloads and matches
  // the rest of the toggle-button pattern.
  const toggleHeatmap = useCallback(() => {
    setHeatmapEnabled((prev) => {
      const next = !prev;
      updateSettings({ heatmapEnabled: next });
      return next;
    });
    // Closing the overlay also closes any in-flight tooltip.
    setHeatmapHover(null);
    if (heatmapHoverTimer.current) {
      clearTimeout(heatmapHoverTimer.current);
      heatmapHoverTimer.current = null;
    }
  }, [updateSettings]);

  // V040-001: hide tooltip on scroll / Escape. Scroll closes immediately
  // because the anchor rect would otherwise drift away from the cell.
  useEffect(() => {
    if (!heatmapHover) return;
    const close = () => setHeatmapHover(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [heatmapHover]);

  // ── Platform credential helpers ─────────────────────────────────────
  const hasPlatformCreds = (p: PostPlatform): boolean => {
    switch (p) {
      case 'instagram':
        if (settings.apiKeys.instagram?.accessToken && settings.apiKeys.instagram?.igAccountId) return true;
        if (isDesktop && desktopCreds.hasInstagramToken && desktopCreds.hasInstagramAccountId) return true;
        return false;
      case 'pinterest':
        if (settings.apiKeys.pinterest?.accessToken) return true;
        if (isDesktop && desktopCreds.hasPinterestCreds) return true;
        return false;
      case 'twitter':
        if (
          settings.apiKeys.twitter?.appKey &&
          settings.apiKeys.twitter?.appSecret &&
          settings.apiKeys.twitter?.accessToken &&
          settings.apiKeys.twitter?.accessSecret
        )
          return true;
        if (isDesktop && desktopCreds.hasTwitterCreds) return true;
        return false;
      case 'discord':
        if (settings.apiKeys.discordWebhook) return true;
        if (isDesktop && desktopCreds.hasDiscordCreds) return true;
        return false;
    }
  };

  const availablePlatforms = (): PostPlatform[] => {
    return (['instagram', 'pinterest', 'twitter', 'discord'] as PostPlatform[]).filter(hasPlatformCreds);
  };

  // M3.1b: identity-stable variant of availablePlatforms() for props
  // of memoized cards (PostReadyCard). The function builds a fresh
  // array per call, which as a prop would defeat React.memo on every
  // render. Recomputes only when the credential inputs change.
  const availablePlatformsList = useMemo(
    () =>
      (['instagram', 'pinterest', 'twitter', 'discord'] as PostPlatform[]).filter(hasPlatformCreds),
    // hasPlatformCreds is a render-fresh closure; its actual inputs are
    // listed here instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.apiKeys, isDesktop, desktopCreds],
  );

  /** Return the per-card selection, initialising to "all available" on
   *  first access. M3.1b: the fallback is the memoized list so the
   *  returned identity is stable for cards without an explicit pick. */
  const getSelectedPlatforms = (id: string): PostPlatform[] => {
    if (postPlatformSel[id]) return postPlatformSel[id];
    return availablePlatformsList;
  };

  const togglePlatformFor = (id: string, p: PostPlatform) => {
    setPostPlatformSel((prev) => {
      const current = prev[id] || availablePlatforms();
      const next = current.includes(p) ? current.filter((x) => x !== p) : [...current, p];
      return { ...prev, [id]: next };
    });
  };

  /** Default schedule — today's date, an hour from now. Memoised per image id. */
  const getSchedule = (id: string): { date: string; time: string } => {
    if (postSchedule[id]) return postSchedule[id];
    const d = new Date(Date.now() + 60 * 60 * 1000);
    const date = d.toISOString().slice(0, 10);
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return { date, time };
  };

  const setScheduleFor = (id: string, patch: Partial<{ date: string; time: string }>) => {
    setPostSchedule((prev) => ({
      ...prev,
      [id]: { ...getSchedule(id), ...patch },
    }));
  };

  // ── Credentials payload (shared between manual + auto + carousel) ──
  const buildCredentialsPayload = () => ({
    instagram: settings.apiKeys.instagram,
    twitter: settings.apiKeys.twitter,
    pinterest: settings.apiKeys.pinterest,
    discord: { webhookUrl: settings.apiKeys.discordWebhook },
  });

  // ── Image + caption helpers (shared with captioning view) ───────────
  const patchImage = (img: GeneratedImage, patch: Partial<GeneratedImage>) => {
    saveImage({ ...img, ...patch });
  };

  /** Format a single image's caption + hashtags as a ready-to-paste post. */
  const formatPost = (img: GeneratedImage): string => {
    const caption = img.postCaption || '';
    const tags = (img.postHashtags || []).join(' ');
    return tags ? `${caption}\n\n${tags}` : caption;
  };

  /** Remove one hashtag by index and persist. */
  const removeHashtag = (img: GeneratedImage, index: number) => {
    const next = (img.postHashtags || []).filter((_, i) => i !== index);
    patchImage(img, { postHashtags: next });
  };

  /**
   * V040-003: verbatim caption propagation across a carousel group.
   * Single helper for every "set this caption on every image in the
   * group" action — captioning-view and post-ready-view textarea
   * onChange (where the user just typed something), plus
   * fanCaptionToGroup's sibling fan-out after AI generation.
   */
  const propagateCaptionToGroup = (
    group: GeneratedImage[],
    caption: string,
    hashtags: string[] | undefined,
    opts: { skipExisting?: boolean; excludeId?: string } = {},
  ) => {
    const { skipExisting = false, excludeId } = opts;
    for (const ci of group) {
      if (excludeId && ci.id === excludeId) continue;
      if (skipExisting && ci.postCaption) continue;
      const patch: Partial<GeneratedImage> = { postCaption: caption };
      if (hashtags !== undefined) patch.postHashtags = hashtags;
      patchImage(ci, patch);
    }
  };

  /**
   * REFACTOR-001 / SHOULDFIX-002 — single shared fan-out for carousel
   * captions, covering both the "call AI on anchor, propagate" path AND
   * the "anchor already has a caption, propagate verbatim" path.
   */
  const fanCaptionToGroup = async (
    anchor: GeneratedImage,
    rest: GeneratedImage[],
    opts: { force?: boolean } = {},
  ): Promise<GeneratedImage | undefined> => {
    const force = opts.force === true;
    // SHOULDFIX-002: if anchor already has a caption and caller didn't
    // force regen, propagate it verbatim — no AI call. Unifies what
    // used to be an inline branch in batchCaptionImages.
    const useExisting = !force && !!anchor.postCaption;
    const withCaption = useExisting ? anchor : await generatePostContent(anchor);
    if (!withCaption?.postCaption) return withCaption;
    // V040-003: route the sibling fan-out through the shared verbatim
    // propagator so the WARN-1 "don't overwrite a manually-edited
    // sibling caption" guard lives in exactly one place.
    propagateCaptionToGroup(rest, withCaption.postCaption, withCaption.postHashtags, {
      skipExisting: !force,
      excludeId: anchor.id,
    });
    return withCaption;
  };

  /**
   * V1.5: re-apply the current watermark to an already-saved image.
   * Shared by the Captioning, Post-Ready, and Gallery surfaces.
   * M3.1: identity-stable so it can be passed to the memoized
   * GalleryCard directly.
   */
  const handleReapplyWatermark = useStableCallback(async (img: GeneratedImage) => {
    const result = await reapplyWatermark(
      img,
      settings.watermark ?? {
        enabled: false,
        image: null,
        position: 'bottom-right',
        opacity: 0.8,
        scale: 0.05,
      },
      settings.channelName,
    );
    if (result.ok) {
      saveImage(result.image);
      showToast('Watermark re-applied.', 'success');
    } else {
      showToast(result.reason, 'error');
    }
  });

  // ── Copy-with-feedback (used by both Post Ready + Captioning) ──────
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyWithFeedback = async (text: string, feedbackKey: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(feedbackKey);
      setTimeout(() => {
        setCopiedId((current) => (current === feedbackKey ? null : current));
      }, 1500);
    } catch {
      showToast('Failed to copy to clipboard', 'error');
    }
  };

  // ── Post Now (single image) ─────────────────────────────────────────
  const postImageNow = async (img: GeneratedImage, platforms: PostPlatform[]) => {
    if (platforms.length === 0) return;
    // BUG-CRIT-011: enforce the approval gate at the manual click site.
    // Without this check, Post Now bypassed ScheduledPost.status entirely
    // and rejected/pending pipeline content went live anyway.
    const block = findPostingBlock([img.id], settings.scheduledPosts);
    if (block) {
      setPostStatus((prev) => ({ ...prev, [img.id]: block.message }));
      return;
    }
    setPostBusy((prev) => ({ ...prev, [img.id]: 'posting' }));
    setPostStatus((prev) => ({ ...prev, [img.id]: null }));
    try {
      // POST-413-FIX phase 3 (2026-05-21): hoist the image to a public
      // host BEFORE sending the post request so the body to /api/social/
      // post stays a few hundred bytes. JPEG@0.92 (phase 2, 578f8c2)
      // brought single-image posts under Vercel's 4.5MB serverless body
      // limit but a 3840x3840 GPT Image-2 output can still trip it, and
      // carousels of 2+ images cross it reliably. ensureHostedUrl is a
      // no-op for already-https sources and uploads data: URLs to uguu.
      const source = img.url || (img.base64 ? `data:image/jpeg;base64,${img.base64}` : '');
      if (!source) throw new Error('No image source — both url and base64 are missing');
      const hostedUrl = await ensureHostedUrl(source);
      const res = await fetch('/api/social/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caption: formatPost(img),
          platforms,
          mediaUrl: hostedUrl,
          credentials: buildCredentialsPayload(),
        }),
      });
      let data: { error?: string };
      try {
        data = (await res.json()) as { error?: string };
      } catch {
        throw new Error(`Server error (HTTP ${res.status}) — check logs`);
      }
      if (!res.ok) throw new Error(data.error || 'Post failed');
      patchImage(img, {
        postedAt: Date.now(),
        postedTo: platforms,
        postError: undefined,
      });
      recordOutcome({
        imageId: img.id,
        prompt: img.prompt,
        style: img.style ?? '',
        aspectRatio: img.aspectRatio ?? '',
        model: img.modelInfo?.modelName ?? img.modelInfo?.modelId ?? '',
        status: 'posted',
        platform: platforms.join(','),
        timestamp: Date.now(),
      });
      setPostStatus((prev) => ({
        ...prev,
        [img.id]: `Posted to ${platforms.join(', ')} ✓`,
      }));
    } catch (e: unknown) {
      const reason = getErrorMessage(e);
      patchImage(img, { postError: reason });
      setPostStatus((prev) => ({
        ...prev,
        [img.id]: `Error: ${reason}`,
      }));
    } finally {
      setPostBusy((prev) => ({ ...prev, [img.id]: null }));
    }
  };

  // ── Schedule-collision check ────────────────────────────────────────
  /**
   * Collision check for manual scheduling.
   * Treats a slot as taken when a non-terminal ScheduledPost shares the
   * same date+time AND any platform overlap, *excluding* the image(s)
   * being rescheduled and (for carousels) siblings in the same group.
   * Returns the colliding post or null.
   */
  const findScheduleCollision = (
    date: string,
    time: string,
    platforms: readonly string[],
    ignoreImageIds: Set<string>,
    ignoreCarouselGroupId?: string | null,
  ): ScheduledPost | null => {
    const existing = settings.scheduledPosts || [];
    const wanted = new Set<string>(platforms);
    for (const p of existing) {
      if (p.status === 'posted' || p.status === 'rejected' || p.status === 'failed') continue;
      if (ignoreImageIds.has(p.imageId)) continue;
      if (ignoreCarouselGroupId && p.carouselGroupId === ignoreCarouselGroupId) continue;
      if (p.date !== date || p.time !== time) continue;
      const pPlatforms = p.platforms || [];
      if (pPlatforms.some((pl) => wanted.has(pl))) return p;
    }
    return null;
  };

  /**
   * BUG-FIX: when smart schedule has fewer slots than posts, find the
   * next-best unconsumed slots so remaining posts spread rather than
   * piling onto the same form.{date,time}. `consumedKeys` tracks slots
   * already allocated in the same confirm pass.
   */
  const findExtraSlots = (
    needed: number,
    existingPosts: ScheduledPost[],
    consumedKeys: Set<string>,
  ): SlotScore[] => {
    const allScheduled: ExistingPost[] = [
      ...existingPosts.map((p) => ({ date: p.date, time: p.time, status: p.status })),
      ...[...consumedKeys].map((key) => {
        const [date, time] = key.split('T');
        return { date, time, status: 'scheduled' as const };
      }),
    ];
    return findBestSlots(allScheduled, needed);
  };

  // ── Schedule image (single) ─────────────────────────────────────────
  /**
   * Persist or update a ScheduledPost in settings.scheduledPosts.
   *
   * If an existing non-carousel scheduled post already references this
   * image, we patch it in place instead of appending — otherwise clicking
   * Schedule after editing the date/time/caption would create a duplicate
   * card for the same image. Carousel-bound posts are owned by
   * scheduleCarousel and intentionally skipped here.
   */
  const scheduleImage = (
    img: GeneratedImage,
    platforms: PostPlatform[],
    date: string,
    time: string,
  ) => {
    if (!date || !time || platforms.length === 0) return;
    const collision = findScheduleCollision(date, time, platforms, new Set([img.id]));
    if (collision) {
      const wanted = new Set<string>(platforms);
      const platformLabel =
        (collision.platforms || []).find((pl) => wanted.has(pl)) || 'that platform';
      showToast(`Already scheduled at ${date} ${time} on ${platformLabel}.`, 'error');
      return;
    }
    const caption = formatPost(img);
    updateSettings((prev) => {
      const existingPosts = prev.scheduledPosts || [];
      // RESCHED-FIX: only reuse the entry if it's still active. A 'posted'
      // or 'rejected' entry is terminal — patching it would silently
      // rewrite history and the Post Ready card would keep showing the
      // terminal status for the new schedule. Treat 'failed' as active so
      // the user can retry by re-scheduling.
      const editableIdx = existingPosts.findIndex(
        (p) =>
          p.imageId === img.id &&
          !p.carouselGroupId &&
          p.status !== 'posted' &&
          p.status !== 'rejected',
      );
      if (editableIdx !== -1) {
        // RESCHED-FIX: mirror the in-place reschedule to the server
        return {
          scheduledPosts: existingPosts.map((p, i) =>
            i === editableIdx
              ? { ...p, date, time, platforms, caption, status: 'scheduled' }
              : p,
          ),
        };
      }
      const scheduled: ScheduledPost = {
        id: `sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        imageId: img.id,
        date,
        time,
        platforms,
        caption,
        status: 'scheduled',
      };
      return { scheduledPosts: [...existingPosts, scheduled] };
    });
    // BUG-CRIT-013: surface the image in the Post Ready tab. Before
    // this, scheduling from anywhere outside Post Ready (e.g. directly
    // from a calendar slot or a captioning card) created the
    // ScheduledPost but left the image with isPostReady=false, so it
    // was invisible in Post Ready even though it had a real schedule.
    if (!img.isPostReady) patchImage(img, { isPostReady: true });
    setPostStatus((prev) => ({
      ...prev,
      [img.id]: `Scheduled for ${date} ${time}`,
    }));
  };

  /**
   * Cancel a scheduled post for this image WITHOUT rejecting it.
   *
   * Distinct from `rejectScheduledPost` (which flips status to 'rejected'
   * so the daemon stops acting on it) and from `deleteImage` (which blows
   * the image away entirely). "Cancel schedule" just drops any
   * non-posted ScheduledPost entries for the image so the card reverts
   * to the plain "Ready" state — the user can then re-schedule or post
   * now. Already-posted entries are preserved so posting history is
   * never retroactively hidden.
   */
  const unschedulePost = (img: GeneratedImage) => {
    // SCHED-POST-ROBUST: cancel any matching server queue entries
    // before the local filter wipes them. Best-effort.
    updateSettings((prev) => ({
      scheduledPosts: (prev.scheduledPosts || []).filter(
        (p) => p.imageId !== img.id || p.status === 'posted',
      ),
    }));
    setPostStatus((prev) => ({ ...prev, [img.id]: 'Schedule canceled' }));
  };

  /** Cancel schedule for every image in a carousel item. */
  const unscheduleCarousel = (images: GeneratedImage[], statusKey: string) => {
    const ids = new Set(images.map((i) => i.id));
    updateSettings((prev) => ({
      scheduledPosts: (prev.scheduledPosts || []).filter(
        (p) => !ids.has(p.imageId) || p.status === 'posted',
      ),
    }));
    setPostStatus((prev) => ({ ...prev, [statusKey]: 'Schedule canceled' }));
  };

  // ── Schedule carousel ───────────────────────────────────────────────
  /**
   * Schedule a whole carousel: creates one ScheduledPost per image in the
   * group at the shared date/time/platforms. The auto-post worker picks
   * these up when the time hits; Instagram carousel-mode is still handled
   * by postCarouselNow when the user clicks Post Now.
   *
   * If an existing carouselGroupId already covers exactly this set of
   * images, we patch those posts in place so re-editing date/time/caption
   * doesn't duplicate the carousel.
   */
  const scheduleCarousel = (
    item: Extract<PostItem, { kind: 'carousel' }>,
    platforms: PostPlatform[],
    date: string,
    time: string,
  ) => {
    if (platforms.length === 0 || !date || !time || item.images.length === 0) return;
    const imageIds = new Set(item.images.map((i) => i.id));
    // Match the existing group-match logic below: if a group already
    // covers exactly these images, we're rescheduling it (no collision).
    const existingForGroup = (settings.scheduledPosts || []).filter(
      (p) => p.carouselGroupId && imageIds.has(p.imageId),
    );
    const existingGroupId = existingForGroup[0]?.carouselGroupId ?? null;
    const collision = findScheduleCollision(date, time, platforms, imageIds, existingGroupId);
    if (collision) {
      const wanted = new Set<string>(platforms);
      const platformLabel =
        (collision.platforms || []).find((pl) => wanted.has(pl)) || 'that platform';
      showToast(`Already scheduled at ${date} ${time} on ${platformLabel}.`, 'error');
      return;
    }
    const caption = item.group?.caption || formatPost(item.images[0]);

    updateSettings((prev) => {
      const existingPosts = prev.scheduledPosts || [];

      // Find an existing carouselGroupId whose posts cover exactly this
      // item's image set. Iterating to the end means the LAST match wins
      // if the user somehow has stale duplicates — newest grouping is kept.
      const byGroup = new Map<string, ScheduledPost[]>();
      for (const p of existingPosts) {
        if (!p.carouselGroupId || !imageIds.has(p.imageId)) continue;
        const list = byGroup.get(p.carouselGroupId) || [];
        list.push(p);
        byGroup.set(p.carouselGroupId, list);
      }
      let matchGroupId: string | null = null;
      for (const [gid, posts] of byGroup) {
        const postImgIds = new Set(posts.map((p) => p.imageId));
        if (
          postImgIds.size === imageIds.size &&
          [...imageIds].every((id) => postImgIds.has(id))
        ) {
          matchGroupId = gid;
        }
      }

      if (matchGroupId) {
        return {
          scheduledPosts: existingPosts.map((p) =>
            p.carouselGroupId === matchGroupId
              ? { ...p, date, time, platforms, caption }
              : p,
          ),
        };
      }

      const nowStamp = Date.now();
      const groupId = `carousel-grp-${nowStamp}-${Math.random().toString(36).slice(2, 8)}`;
      const newPosts: ScheduledPost[] = item.images.map((img, idx) => ({
        id: `post-${nowStamp}-${idx}-${Math.random().toString(36).slice(2, 8)}`,
        imageId: img.id,
        date,
        time,
        platforms,
        caption,
        status: 'scheduled' as const,
        carouselGroupId: groupId,
      }));
      // SCHED-POST-ROBUST: mirror to the server queue. Each carousel
      // member is pushed with its own mediaUrl; the cron groups by
      // carouselGroupId and assembles mediaUrls = [member1.url, ...]
      // (see app/api/social/cron-fire/route.ts:fireOne). All members
      return { scheduledPosts: [...existingPosts, ...newPosts] };
    });
    // BUG-CRIT-013: surface every image in the carousel in Post Ready,
    // matching scheduleImage's per-image behaviour. Without this,
    // scheduling a carousel from outside Post Ready left all siblings
    // invisible in the Post Ready tab.
    for (const img of item.images) {
      if (!img.isPostReady) patchImage(img, { isPostReady: true });
    }
    setPostStatus((prev) => ({
      ...prev,
      [`carousel-${item.id}`]: `Scheduled carousel for ${date} ${time}`,
    }));
  };

  // ── Post Now (carousel) ────────────────────────────────────────────
  /** Post a whole carousel now — fans out to platforms with the full mediaUrls array. */
  const postCarouselNow = async (
    item: Extract<PostItem, { kind: 'carousel' }>,
    platforms: PostPlatform[],
  ) => {
    if (platforms.length === 0 || item.images.length === 0) return;
    const key = `carousel-${item.id}`;
    // BUG-CRIT-011: a single rejected (or pending-approval) sibling
    // blocks the whole carousel. Bulk-rejecting in the approval queue
    // marks each ScheduledPost in the group; without this gate the
    // user could still publish the entire carousel via Post Now.
    const block = findPostingBlock(
      item.images.map((i) => i.id),
      settings.scheduledPosts,
    );
    if (block) {
      setPostStatus((prev) => ({ ...prev, [key]: block.message }));
      return;
    }
    setPostBusy((prev) => ({ ...prev, [key]: 'posting' }));
    setPostStatus((prev) => ({ ...prev, [key]: null }));
    try {
      const caption = item.group?.caption || formatPost(item.images[0]);
      // POST-413-FIX phase 3 (2026-05-21): carousels were the failure
      // case after phase 2 (578f8c2). N watermarked JPEG@0.92 data URLs
      // each in mediaUrls reliably blow Vercel's 4.5MB body limit once
      // N >= 2. ensureHostedUrls passes through https URLs unchanged and
      // parallel-uploads data: URLs to uguu so the body stays tiny.
      const rawSources = item.images
        .map((i) => i.url || (i.base64 ? `data:image/jpeg;base64,${i.base64}` : ''))
        .filter(Boolean);
      if (rawSources.length === 0) throw new Error('Carousel has no usable image sources');
      const mediaUrls = await ensureHostedUrls(rawSources);
      const res = await fetch('/api/social/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caption,
          platforms,
          mediaUrls,
          credentials: buildCredentialsPayload(),
        }),
      });
      // POST-NONJSON-DIAG (2026-05-21): defensively wrap res.json() to
      // match the other three /api/social/post call sites.
      let data: { error?: string };
      try {
        data = (await res.json()) as { error?: string };
      } catch {
        throw new Error(`Server error (HTTP ${res.status}) — check logs`);
      }
      if (!res.ok) throw new Error(data.error || 'Carousel post failed');
      const stamp = Date.now();
      for (const ci of item.images) {
        patchImage(ci, {
          postedAt: stamp,
          postedTo: platforms,
          postError: undefined,
        });
      }
      setPostStatus((prev) => ({
        ...prev,
        [key]: `Posted carousel to ${platforms.join(', ')} ✓`,
      }));
    } catch (e: unknown) {
      const reason = getErrorMessage(e);
      for (const ci of item.images) {
        patchImage(ci, { postError: reason });
      }
      setPostStatus((prev) => ({ ...prev, [key]: `Error: ${reason}` }));
    } finally {
      setPostBusy((prev) => ({ ...prev, [key]: null }));
    }
  };

  // ── latestScheduleFor (active-schedule lookup) ──────────────────────
  /** Look up the most relevant scheduled post for an image id.
   *  RESCHED-FIX: prefer an active (non-terminal) post over older
   *  posted/rejected entries so the Post Ready card reflects the
   *  user's most recent reschedule, not a stale terminal entry. */
  const latestScheduleFor = (imageId: string): ScheduledPost | undefined => {
    const all = settings.scheduledPosts || [];
    let active: ScheduledPost | undefined;
    let fallback: ScheduledPost | undefined;
    for (let i = all.length - 1; i >= 0; i--) {
      const p = all[i];
      if (p.imageId !== imageId) continue;
      const isTerminal = p.status === 'posted' || p.status === 'rejected';
      if (!isTerminal && !active) active = p;
      else if (!fallback) fallback = p;
    }
    return active ?? fallback;
  };

  // ── Memoized list of all scheduled posts (M3.1b) ───────────────────
  const allScheduledPosts = useMemo(
    () => settings.scheduledPosts ?? [],
    [settings.scheduledPosts],
  );

  // ── Stable handler bag for memoized PostReadyCard ──────────────────
  const [postReadySelected, setPostReadySelected] = useState<Set<string>>(new Set());
  const postReadyHandlers = useStableCallbacks({
    onPreviewClick: (img: GeneratedImage) => setSelectedImage(img),
    onCaptionChange: (img: GeneratedImage, next: string) =>
      patchImage(img, { postCaption: next }),
    onRemoveHashtag: (img: GeneratedImage, i: number) => removeHashtag(img, i),
    onTogglePlatform: (imgId: string, p: PostPlatform) => togglePlatformFor(imgId, p),
    onPostNow: (img: GeneratedImage, platforms: PostPlatform[]) =>
      postImageNow(img, platforms),
    onSchedule: (img: GeneratedImage, platforms: PostPlatform[], date: string, time: string) =>
      scheduleImage(img, platforms, date, time),
    onCopy: (img: GeneratedImage) => copyWithFeedback(formatPost(img), `all-${img.id}`),
    onRegen: async (img: GeneratedImage) => {
      setPreparingPostId(img.id);
      try {
        await generatePostContent(img);
      } finally {
        setPreparingPostId(null);
      }
    },
    onUnready: (img: GeneratedImage) => patchImage(img, { isPostReady: false }),
    onCancelSchedule: (img: GeneratedImage) => unschedulePost(img),
    onReapplyWatermark: (img: GeneratedImage) => handleReapplyWatermark(img),
    // Functional updater (the old inline lambda read the closure
    // snapshot of postReadySelected — equivalent here, but the
    // functional form is also safe under rapid toggles).
    onGroupingToggle: (imgId: string, checked: boolean) => {
      setPostReadySelected((prev) => {
        const next = new Set(prev);
        if (checked) next.add(imgId);
        else next.delete(imgId);
        return next;
      });
    },
  });

  return {
    postPlatformSel,
    togglePlatformFor,
    getSelectedPlatforms,
    availablePlatformsList,
    availablePlatforms,
    postSchedule,
    getSchedule,
    setScheduleFor,
    postBusy,
    postStatus,
    setPostStatus,
    patchImage,
    formatPost,
    removeHashtag,
    fanCaptionToGroup,
    propagateCaptionToGroup,
    handleReapplyWatermark,
    copyWithFeedback,
    copiedId,
    postImageNow,
    postCarouselNow,
    scheduleImage,
    scheduleCarousel,
    unschedulePost,
    unscheduleCarousel,
    findScheduleCollision,
    findExtraSlots,
    buildCredentialsPayload,
    heatmapEnabled,
    toggleHeatmap,
    heatmapHover,
    setHeatmapHover,
    heatmapHoverTimer,
    postReadyHandlers,
    latestScheduleFor,
    postReadySelected,
    setPostReadySelected,
    allScheduledPosts,
  };
}
