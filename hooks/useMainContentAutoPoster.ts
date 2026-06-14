/**
 * useMainContentAutoPoster — M3.3-P4 Batch 1 extraction.
 *
 * The 60-second cron effect that scans `settings.scheduledPosts` and
 * publishes anything that's due. Extracted out of `MainContent.tsx` so
 * the daemon's 270 lines of branching (carousel-grouping, defensive
 * platform filter, error-toast fan-out) live in one focused file.
 *
 * No behavior changes — this is a pure code-move.
 *
 * Depends on `setPostStatus` being injected by the caller (the
 * useMainContentScheduling hook) so manual + auto paths share the same
 * per-card status surface.
 */

import { useEffect, useRef } from 'react';
import { isStillScheduled } from '@/lib/post-approval-gate';
import { ensureHostedUrl, ensureHostedUrls } from '@/lib/upload-to-host';
import { postDueState } from '@/lib/autopost-due';
import { showToast } from '@/components/Toast';
import type { ScheduledPost, GeneratedImage } from '@/components/MashupContext';
import type { UserSettings } from '@/types/mashup';

interface UseMainContentAutoPosterArgs {
  settings: UserSettings;
  savedImages: GeneratedImage[];
  updateSettings: (
    patch:
      | Partial<UserSettings>
      | ((prev: UserSettings) => Partial<UserSettings>),
  ) => void;
  setPostStatus: React.Dispatch<
    React.SetStateAction<Record<string, string | null>>
  >;
}

export function useMainContentAutoPoster({
  settings,
  savedImages,
  updateSettings,
  setPostStatus,
}: UseMainContentAutoPosterArgs): void {
  const scheduledPosts = settings.scheduledPosts;
  const apiKeys = settings.apiKeys;
  const pipelinePlatforms = settings.pipelinePlatforms;
  // BUG-CRIT-011: live ref so the auto-poster can re-check status
  // immediately before each fetch. The outer effect's snapshot is taken
  // when the tick fires; if the user rejects a post mid-loop the
  // snapshot still says 'scheduled' and the post would publish anyway.
  // Reading scheduledPostsRef.current at fetch time closes that race.
  const scheduledPostsRef = useRef(scheduledPosts);
  useEffect(() => {
    scheduledPostsRef.current = scheduledPosts;
  }, [scheduledPosts]);

  // Auto-posting effect
  useEffect(() => {
    const interval = setInterval(async () => {
      if (!scheduledPosts || scheduledPosts.length === 0) return;

      const now = new Date();
      // Snapshot the list of posts we'll consider for THIS tick. We only
      // compute statuses against this snapshot, but persist via a
      // functional updater that merges patches by id — so any new posts
      // the user (or the pipeline) added during the async loop are
      // preserved instead of being clobbered.
      const snapshot = [...scheduledPosts];

      // Shared credentials payload — same shape as postCarouselNow /
      // postImageNow so the /api/social/post route doesn't care whether
      // the publish was triggered manually or by the worker.
      const credentials = {
        instagram: apiKeys.instagram,
        twitter: apiKeys.twitter,
        pinterest: apiKeys.pinterest,
        discord: { webhookUrl: apiKeys.discordWebhook },
      };

      // Posts handled as part of a carousel group — we skip these when
      // we encounter their siblings later in the loop so each group is
      // published exactly once.
      const processedIds = new Set<string>();
      // id → next status. Applied via functional updater at the end so
      // we never overwrite the latest scheduledPosts list.
      const statusPatches = new Map<string, ScheduledPost['status']>();

      for (const post of snapshot) {
        if (processedIds.has(post.id)) continue;
        if (post.status !== 'scheduled') continue;
        // AUTOPOST-INVALID-DATE-FIX: see lib/autopost-due.ts. The previous
        // inline `if (now < postDate) continue;` let malformed date/time
        // fields fall through (Invalid Date comparisons are false) so
        // single-image posts with corrupted scheduling fields fired
        // unconditionally on the first auto-poster tick.
        const due = postDueState(post, now);
        if (due === 'invalid') {
          console.error('[auto-poster] skipping post with invalid date/time', {
            postId: post.id,
            date: post.date,
            time: post.time,
            status: post.status,
          });
          continue;
        }
        if (due === 'future') continue;

        // ── Carousel branch ────────────────────────────────────────
        if (post.carouselGroupId) {
          const groupPosts = snapshot.filter(
            (p) => p.carouselGroupId === post.carouselGroupId && p.status === 'scheduled',
          );

          // They share a date/time by construction, but double-check
          // in case the user edited one of them.
          const allDue = groupPosts.every((p) => postDueState(p, now) === 'due');
          if (!allDue) {
            groupPosts.forEach((gp) => processedIds.add(gp.id));
            continue;
          }

          const groupImages = groupPosts
            .map((gp) => savedImages.find((img) => img.id === gp.imageId))
            .filter((x): x is GeneratedImage => !!x);

          if (groupImages.length === 0) {
            groupPosts.forEach((gp) => {
              statusPatches.set(gp.id, 'failed');
              processedIds.add(gp.id);
            });
            continue;
          }

          // BUG-CRIT-011: re-check live status of every group member
          // right before the fetch. If the user rejected any sibling
          // between snapshot and now, abort the whole carousel publish.
          const liveScheduledPosts = scheduledPostsRef.current;
          const groupStillPostable = groupPosts.every((gp) =>
            isStillScheduled(gp.id, liveScheduledPosts),
          );
          if (!groupStillPostable) {
            groupPosts.forEach((gp) => processedIds.add(gp.id));
            continue;
          }

          try {
            // POST-413-FIX phase 3 (2026-05-21): see manual-carousel
            // counterpart above. Same uguu hoist so the autopost path
            // doesn't trip Vercel's 4.5MB body limit for high-res carousels.
            const rawSources = groupImages
              .map((i) => i.url || (i.base64 ? `data:image/jpeg;base64,${i.base64}` : ''))
              .filter(Boolean);
            // Fix 5 (mmx brief): old content sometimes lands here with
            // every Leonardo URL expired AND no base64 fallback. Bail
            // early with an actionable error instead of letting the
            // server try to fetch dead URLs.
            if (rawSources.length === 0) {
              throw new Error(
                'No usable image source — every carousel member is missing both url and base64 (Leonardo URL likely expired)',
              );
            }
            const mediaUrls = await ensureHostedUrls(rawSources);
            // V1.7.0-PRE-PROD-FIX: defensive filter. Even if `post.platforms`
            // still references a now-disabled platform (e.g. user
            // toggled Pinterest off in PipelineTab but the dialog
            // chose "only new posts" so old posts kept the platform),
            // the auto-poster never sends to it. The intersection of
            // (post.platforms) and (settings.pipelinePlatforms) is the
            // ground truth at the actual post site.
            const livePlatforms = (post.platforms || []).filter((pl) =>
              (pipelinePlatforms || []).includes(pl),
            );
            if (livePlatforms.length === 0) {
              // No live platforms left — skip silently. The
              // findPostingBlock guard already refuses posts with no
              // viable platforms, but this is a defense-in-depth
              // check in case the guard runs before the platform
              // setting hydrates.
              processedIds.add(post.id);
              continue;
            }
            const res = await fetch('/api/social/post', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                caption: post.caption,
                platforms: livePlatforms,
                mediaUrls,
                credentials,
              }),
            });
            let data: { error?: string };
            try {
              data = (await res.json()) as { error?: string };
            } catch {
              throw new Error(`Server error (HTTP ${res.status})`);
            }
            if (!res.ok) throw new Error(data.error || 'Failed to post carousel');

            groupPosts.forEach((gp) => {
              statusPatches.set(gp.id, 'posted');
              processedIds.add(gp.id);
            });
          } catch (e: unknown) {
            const reason = e instanceof Error ? e.message : String(e);
            // Fix 5: surface the failure reason on every member's chip
            // and log structured context so old-content failures are
            // diagnosable instead of mysteriously red.
            console.error('[auto-poster] carousel publish failed', {
              postId: post.id,
              carouselGroupId: post.carouselGroupId,
              date: post.date,
              time: post.time,
              platforms: post.platforms,
              memberCount: groupPosts.length,
              reason,
            });
            const groupKey = `carousel-${post.carouselGroupId ?? post.id}`;
            setPostStatus((prev) => ({ ...prev, [groupKey]: `Error: ${reason}` }));
            groupPosts.forEach((gp) => {
              statusPatches.set(gp.id, 'failed');
              processedIds.add(gp.id);
              setPostStatus((prev) => ({ ...prev, [gp.imageId]: `Error: ${reason}` }));
            });
            showToast(`Scheduled carousel post failed: ${reason}`, 'error');
          }
          continue;
        }

        // ── Single-image branch (existing behaviour) ─────────────
        const image = savedImages.find((img) => img.id === post.imageId);
        if (!image) {
          // Fix 5: explain the missing-image case so users understand
          // why an old post failed (image was pruned from gallery).
          const reason = `Source image ${post.imageId} no longer exists in gallery`;
          console.error('[auto-poster] image missing', { postId: post.id, imageId: post.imageId });
          setPostStatus((prev) => ({ ...prev, [post.imageId]: `Error: ${reason}` }));
          statusPatches.set(post.id, 'failed');
          continue;
        }

        // BUG-CRIT-011: re-check live status right before the fetch.
        // If the user rejected this post between snapshot and now,
        // skip without marking failed — the rejection is a normal
        // outcome, not a posting error.
        if (!isStillScheduled(post.id, scheduledPostsRef.current)) {
          continue;
        }

        try {
          // Fix 5 (mmx brief): old content fails when both image.url is
          // a stale Leonardo signed URL AND no base64 fallback survives.
          // Pre-flight the missing-source case so the failure reason is
          // user-actionable instead of a generic "Failed to post".
          if (!image.url && !image.base64) {
            throw new Error(
              'No usable image source — both url and base64 are missing (Leonardo URL likely expired and image was never re-hosted)',
            );
          }
          if (!post.platforms || post.platforms.length === 0) {
            throw new Error('No platforms selected on the scheduled post');
          }
          // V1.7.0-PRE-PROD-FIX: defensive filter for the manual-single
          // (non-carousel) auto-poster. Same contract as the carousel
          // path above. Even if `post.platforms` still references a
          // now-disabled platform, only the intersection with
          // `settings.pipelinePlatforms` is sent.
          const livePlatformsManual = (post.platforms || []).filter((pl) =>
            (pipelinePlatforms || []).includes(pl),
          );
          if (livePlatformsManual.length === 0) {
            processedIds.add(post.id);
            continue;
          }
          // POST-413-FIX phase 3 (2026-05-21): see manual-single
          // counterpart above. ensureHostedUrl uploads data: URLs to uguu
          // and passes https URLs through unchanged.
          const source =
            image.url || (image.base64 ? `data:image/jpeg;base64,${image.base64}` : '');
          const hostedUrl = await ensureHostedUrl(source);
          const res = await fetch('/api/social/post', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              caption: post.caption,
              platforms: livePlatformsManual,
              mediaUrl: hostedUrl,
              credentials,
            }),
          });

          let data: { error?: string };
          try {
            data = (await res.json()) as { error?: string };
          } catch {
            throw new Error(`Server error (HTTP ${res.status})`);
          }
          if (!res.ok) throw new Error(data.error || 'Failed to post');

          statusPatches.set(post.id, 'posted');
        } catch (e: unknown) {
          const reason = e instanceof Error ? e.message : String(e);
          console.error('[auto-poster] single publish failed', {
            postId: post.id,
            imageId: post.imageId,
            date: post.date,
            time: post.time,
            platforms: post.platforms,
            hasUrl: !!image.url,
            hasBase64: !!image.base64,
            reason,
          });
          setPostStatus((prev) => ({ ...prev, [post.imageId]: `Error: ${reason}` }));
          statusPatches.set(post.id, 'failed');
          showToast(`Scheduled post failed: ${reason}`, 'error');
        }
      }

      if (statusPatches.size > 0) {
        updateSettings((prev) => ({
          scheduledPosts: (prev.scheduledPosts || []).map((p) =>
            statusPatches.has(p.id) ? { ...p, status: statusPatches.get(p.id)! } : p,
          ),
        }));
      }
    }, 60000); // Check every minute

    return () => clearInterval(interval);
  }, [scheduledPosts, apiKeys, pipelinePlatforms, savedImages, updateSettings, setPostStatus]);
}
