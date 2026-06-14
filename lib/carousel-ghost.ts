/**
 * V040-HOTFIX-003: ghost-memory utilities for the carousel approval card.
 *
 * Approving or rejecting an image fires a parent callback that removes
 * the corresponding `ScheduledPost` from the queue. The card then
 * re-renders with one fewer post — the just-acted-on image disappears
 * entirely, and the user never sees their checkmark land. To bridge
 * that gap we keep a per-image "ghost" entry in local card state for
 * a few seconds after action, so the row stays visible with its
 * approved/rejected styling before fading away.
 *
 * The component owns the React state + timers; this module owns the
 * pure helpers (TTL constant, prune, next-expiry lookup) so they can
 * be unit-tested without DOM/RTL.
 */

export const GHOST_TTL_MS = 6000;

export type CarouselGhostState = 'approved' | 'rejected';

export interface CarouselGhost<T> {
  state: CarouselGhostState;
  img: T;
  expiresAt: number;
}

/**
 * Drop entries whose `expiresAt` is at or below `now`. Returns the
 * input reference unchanged when nothing expired so callers can use
 * referential equality to skip re-renders.
 */
export function pruneExpiredGhosts<T>(
  ghosts: Record<string, CarouselGhost<T>>,
  now: number,
): Record<string, CarouselGhost<T>> {
  let mutated = false;
  const next: Record<string, CarouselGhost<T>> = {};
  for (const [k, g] of Object.entries(ghosts)) {
    if (g.expiresAt > now) next[k] = g;
    else mutated = true;
  }
  return mutated ? next : ghosts;
}

/**
 * Returns the soonest `expiresAt` across all ghosts, or `null` when
 * the map is empty. Used to schedule the next sweep timer.
 */
export function nextGhostExpiry<T>(
  ghosts: Record<string, CarouselGhost<T>>,
): number | null {
  let min: number | null = null;
  for (const g of Object.values(ghosts)) {
    if (min === null || g.expiresAt < min) min = g.expiresAt;
  }
  return min;
}
