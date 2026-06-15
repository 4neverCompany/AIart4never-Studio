/**
 * Instagram Graph publish flow — encoded EXACTLY as the known-good Composio
 * tool sequence. We do NOT invent tool names: the only Composio slugs used are
 * `INSTAGRAM_POST_IG_USER_MEDIA` (create a media container) and
 * `INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH` (publish a container by creation id).
 *
 * Two shapes, decided by asset count:
 *
 *   N > 1 (CAROUSEL):
 *     1. For each image, a CHILD container:
 *          INSTAGRAM_POST_IG_USER_MEDIA
 *            { ig_user_id, is_carousel_item: true, image_url }
 *     2. A PARENT carousel container referencing the child ids IN ORDER:
 *          INSTAGRAM_POST_IG_USER_MEDIA
 *            { ig_user_id, media_type: 'CAROUSEL', children: [...childIds], caption }
 *     3. PUBLISH the parent:
 *          INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH
 *            { ig_user_id, creation_id: <parent id>, max_wait_seconds: 120 }
 *
 *   N == 1 (SINGLE):
 *     1. INSTAGRAM_POST_IG_USER_MEDIA { ig_user_id, image_url, caption }
 *     2. INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH { ig_user_id, creation_id, max_wait_seconds }
 *
 * PLACEHOLDER TOKENS — the parent's `children` and the publish step's
 * `creation_id` cannot be known until earlier steps RUN (Composio assigns the
 * container ids at call time). The plan is built deterministically with
 * placeholder tokens that the dispatcher resolves from prior step results:
 *   - `'$child[i]'` → the created id of the i-th child container step.
 *   - `'$parent'`   → the created id of the parent carousel container step.
 * See `resolvePlaceholder` / `extractId` in `lib/publish/dispatch.ts`.
 */

import type { PublishPlan, PublishRequest, PublishStep } from './types';

/** Composio tool slug: create an IG media container (child, parent, or single). */
export const IG_CREATE_MEDIA = 'INSTAGRAM_POST_IG_USER_MEDIA';
/** Composio tool slug: publish a created container by its creation id. */
export const IG_PUBLISH_MEDIA = 'INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH';

/** Placeholder token for the i-th child container's created id. */
export function childToken(i: number): string {
  return `$child[${i}]`;
}
/** Placeholder token for the parent carousel container's created id. */
export const PARENT_TOKEN = '$parent';

/** Graph default: `'me'` resolves to the connected IG account server-side. */
export const DEFAULT_IG_USER_ID = 'me';

/** How long the publish step waits for IG to finish processing the container. */
export const PUBLISH_MAX_WAIT_SECONDS = 120;

/**
 * Build the ordered, deterministic Instagram publish plan for `req`.
 *
 * `ig_user_id` defaults to {@link DEFAULT_IG_USER_ID} (`'me'`) when
 * `req.igUserId` is omitted. Child-id and parent-id substitution is encoded as
 * placeholder tokens resolved by the dispatcher (see module docs).
 *
 * Throws when there are no assets — the gate should have caught this already,
 * but the builder refuses to emit a meaningless empty plan.
 */
export function buildInstagramPlan(req: PublishRequest): PublishPlan {
  const igUserId = req.igUserId ?? DEFAULT_IG_USER_ID;
  const assets = req.assets;

  if (assets.length === 0) {
    throw new Error('buildInstagramPlan: no assets to publish');
  }

  const steps: PublishStep[] = [];

  if (assets.length === 1) {
    // ── SINGLE ──────────────────────────────────────────────────────────
    const only = assets[0]!;
    steps.push({
      tool: IG_CREATE_MEDIA,
      args: { ig_user_id: igUserId, image_url: only.url, caption: req.caption },
      description: `Create single IG media container for asset ${only.id}`,
    });
    steps.push({
      tool: IG_PUBLISH_MEDIA,
      args: {
        ig_user_id: igUserId,
        // Single create is step index 0 → its id is the parent of the publish.
        creation_id: PARENT_TOKEN,
        max_wait_seconds: PUBLISH_MAX_WAIT_SECONDS,
      },
      description: 'Publish the single IG media container',
    });
    return { target: 'instagram', steps };
  }

  // ── CAROUSEL ────────────────────────────────────────────────────────────
  // 1. One child container per image, in order.
  assets.forEach((a, i) => {
    steps.push({
      tool: IG_CREATE_MEDIA,
      args: {
        ig_user_id: igUserId,
        is_carousel_item: true,
        image_url: a.url,
      },
      description: `Create carousel child ${i + 1}/${assets.length} for asset ${a.id}`,
    });
  });

  // 2. Parent carousel container referencing the child placeholders IN ORDER.
  steps.push({
    tool: IG_CREATE_MEDIA,
    args: {
      ig_user_id: igUserId,
      media_type: 'CAROUSEL',
      children: assets.map((_, i) => childToken(i)),
      caption: req.caption,
    },
    description: `Create CAROUSEL parent container with ${assets.length} children`,
  });

  // 3. Publish the parent.
  steps.push({
    tool: IG_PUBLISH_MEDIA,
    args: {
      ig_user_id: igUserId,
      creation_id: PARENT_TOKEN,
      max_wait_seconds: PUBLISH_MAX_WAIT_SECONDS,
    },
    description: 'Publish the CAROUSEL parent container',
  });

  return { target: 'instagram', steps };
}
