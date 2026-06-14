/**
 * V040-HOTFIX-002 / V080-DEV-003: degrade-guard for the carousel
 * approval card.
 *
 * Originally a hard 2-image floor: per-image reject was disabled the
 * moment the carousel reached 2 images, because the auto-poster used
 * to refuse a 1-image "carousel". V080-DEV-003 dropped that constraint
 * — `groupApprovalPosts` now collapses any 1-sibling carousel group
 * into a single-card item, and the `/api/social/post` route treats
 * `mediaUrls.length === 1` as a single-image post (Instagram only
 * fans out to a CAROUSEL container when `igMediaUrls.length > 1`).
 * So a 2→1 reject is no longer a broken state; it's a deliberate
 * "post the survivor as a single image" action.
 *
 * The floor is still 1 (you cannot reject the very last image — that
 * has to go through "Reject carousel" so the user is explicit about
 * killing the whole post). The whole-carousel reject path remains
 * intentionally NOT gated by this helper.
 */

export const CAROUSEL_MIN_IMAGES = 1;

/**
 * Returns true when one more per-image reject is allowed without
 * dropping the carousel to zero images.
 *
 * `nonRejectedCount` is the number of images currently in `pending`
 * or `approved` state (i.e. images still part of the carousel).
 *
 * V080-DEV-003: a 2-image carousel now allows one per-image reject —
 * the survivor is auto-collapsed to a single-image post. Only the
 * very last image is locked behind the explicit "Reject carousel"
 * button.
 */
export function canRejectMoreInCarousel(nonRejectedCount: number): boolean {
  return nonRejectedCount > CAROUSEL_MIN_IMAGES;
}
