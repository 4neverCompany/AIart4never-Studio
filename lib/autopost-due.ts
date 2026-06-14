import type { ScheduledPost } from '../types/mashup';

export type DueState = 'invalid' | 'future' | 'due';

/**
 * Time gate for the auto-poster.
 *
 * AUTOPOST-INVALID-DATE-FIX (2026-05-20): the original inline predicate
 * was `if (now < postDate) continue;`. For Invalid Date (any malformed
 * `post.date` or `post.time`) the comparison evaluates to `false` (NaN
 * comparisons are always false), so the guard fell through and the post
 * fired unconditionally regardless of intended time. The explicit
 * `isNaN(postDate.getTime())` branch closes that hole and surfaces the
 * malformed entry via the caller's logger so the upstream writer can
 * be tracked down.
 */
// Storage format used everywhere: `formatLocalDate` and `findBestSlots`
// emit `YYYY-MM-DD`; pickers emit `HH:MM`. Anything else is corrupted
// data. The regex pair stops V8 from silently coercing garbage strings
// into a real Date — e.g. `new Date('not-a-dateTnot-a-time:00')` returns
// Jan 1, 2000 in V8, which the time gate would then mark `due` and fire.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

export function postDueState(
  post: Pick<ScheduledPost, 'date' | 'time'>,
  now: Date,
): DueState {
  if (!DATE_RE.test(post.date) || !TIME_RE.test(post.time)) return 'invalid';
  const postDate = new Date(`${post.date}T${post.time}:00`);
  if (isNaN(postDate.getTime())) return 'invalid';
  return now < postDate ? 'future' : 'due';
}
