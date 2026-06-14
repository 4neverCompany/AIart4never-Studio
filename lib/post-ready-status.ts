/**
 * V060-001 — single source of truth for the Post Ready card status pill.
 *
 * Both PostReadyCard (single image) and PostReadyCarouselCard derive
 * their pill+border colour from this helper. Manual Post Now state
 * (img.postedAt / img.postError) wins; otherwise the latest scheduled
 * post drives the result; otherwise default 'ready'.
 *
 * Pinned by tests/integration/carousel-badge-derivation.test.ts.
 */

import type { GeneratedImage, ScheduledPost } from '@/types/mashup';
import { formatTimeShort } from '@/components/TimePicker24';

export type PostReadyStatusKind = 'ready' | 'scheduled' | 'posted' | 'failed';

export interface PostReadyStatus {
  kind: PostReadyStatusKind;
  label: string;
}

const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// V082-UI-FIX: compact date format for the status pill. The full
// YYYY-MM-DD pushed the scheduled pill wide enough that a carousel
// card's status row wrapped to 2 lines in a grid-cols-2 layout.
// `MMM D` keeps the pill under ~150px so Carousel·N + manual still fit
// on one line. Year is dropped from the pill because the CountdownBadge
// renders alongside it and surfaces multi-year deltas (e.g. "in 10mo").
export function formatScheduledDate(dateStr: string): string {
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const [y, m, d] = parts.map(Number);
  if (!y || !m || !d || m < 1 || m > 12) return dateStr;
  return `${MONTH_ABBR[m - 1]} ${d}`;
}

export function derivePostReadyStatus(
  img: GeneratedImage,
  scheduled: ScheduledPost | undefined,
): PostReadyStatus {
  if (img.postedAt) {
    const where = img.postedTo?.length ? ` to ${img.postedTo.join(', ')}` : '';
    return { kind: 'posted', label: `Posted${where}` };
  }
  if (img.postError) return { kind: 'failed', label: `Failed: ${img.postError}` };
  if (scheduled?.status === 'posted') return { kind: 'posted', label: 'Posted' };
  if (scheduled?.status === 'failed') return { kind: 'failed', label: 'Failed' };
  if (scheduled?.status === 'scheduled') {
    return {
      kind: 'scheduled',
      label: `Scheduled ${formatScheduledDate(scheduled.date)} · ${formatTimeShort(scheduled.time)}`,
    };
  }
  if (scheduled?.status === 'pending_approval') {
    return {
      kind: 'scheduled',
      label: `Pending approval · ${formatScheduledDate(scheduled.date)} ${formatTimeShort(scheduled.time)}`,
    };
  }
  return { kind: 'ready', label: 'Ready' };
}
