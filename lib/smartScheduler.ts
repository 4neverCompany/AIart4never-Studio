/**
 * Smart scheduler — picks optimal posting times based on:
 *   1. Instagram Graph API insights (engagement by hour/day from past posts)
 *   2. Falls back to research-backed optimal times for DACH / EU timezone
 *
 * Engagement data is cached in localStorage with a 24h TTL.
 */

import { formatLocalDate } from './local-date';

interface IgMediaPost {
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
}

export interface SlotScore {
  date: string;
  time: string;
  /** 0-100 score, higher = better */
  score: number;
  /** Why this slot was chosen */
  reason: string;
}

export interface EngagementHour {
  hour: number;
  /** Relative engagement weight (0-1) */
  weight: number;
}

export interface EngagementDay {
  day: number; // 0=Sun, 1=Mon, ..., 6=Sat
  multiplier: number;
}

/** Research-backed optimal posting times for Instagram (EU timezone, adjusted for DACH).
 *  Sources: Hootsuite 2025, Sprout Social, Later.com aggregate data. */
const DEFAULT_HOUR_WEIGHTS: EngagementHour[] = [
  { hour: 6,  weight: 0.3 },
  { hour: 7,  weight: 0.6 },
  { hour: 8,  weight: 0.8 },  // Morning commute peak
  { hour: 9,  weight: 0.65 },
  { hour: 10, weight: 0.5 },
  { hour: 11, weight: 0.55 },
  { hour: 12, weight: 0.75 }, // Lunch break
  { hour: 13, weight: 0.7 },
  { hour: 14, weight: 0.5 },
  { hour: 15, weight: 0.4 },
  { hour: 16, weight: 0.45 },
  { hour: 17, weight: 0.7 },  // After-work ramp
  { hour: 18, weight: 0.85 }, // After-work peak
  { hour: 19, weight: 0.9 },  // Prime time
  { hour: 20, weight: 0.95 }, // Highest engagement window
  { hour: 21, weight: 0.85 },
  { hour: 22, weight: 0.6 },
  { hour: 23, weight: 0.3 },
];

const DEFAULT_DAY_MULTIPLIERS: EngagementDay[] = [
  { day: 0, multiplier: 0.9 },  // Sunday — high evening engagement
  { day: 1, multiplier: 0.7 },  // Monday
  { day: 2, multiplier: 0.75 }, // Tuesday
  { day: 3, multiplier: 0.8 },  // Wednesday
  { day: 4, multiplier: 0.85 }, // Thursday
  { day: 5, multiplier: 0.95 }, // Friday — high engagement
  { day: 6, multiplier: 1.0 },  // Saturday — best day
];

const CACHE_KEY = 'mashup_engagement_cache';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

export interface CachedEngagement {
  hours: EngagementHour[];
  days: EngagementDay[];
  fetchedAt: number;
  source: 'instagram' | 'default';
  /** V040-001: number of past IG posts that fed the current weights.
   *  Drives the heatmap tooltip's confidence phrasing. Absent / 0 for
   *  the 'default' source. */
  samples?: number;
}

export function loadEngagementData(): CachedEngagement {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const cached: CachedEngagement = JSON.parse(raw);
      if (Date.now() - cached.fetchedAt < CACHE_TTL) {
        return cached;
      }
    }
  } catch { /* ignore */ }
  return {
    hours: DEFAULT_HOUR_WEIGHTS,
    days: DEFAULT_DAY_MULTIPLIERS,
    fetchedAt: Date.now(),
    source: 'default',
  };
}

export function saveEngagementData(data: CachedEngagement): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
}

/**
 * Fetch Instagram insights for past posts to learn best posting times.
 * Returns engagement-weighted hours. Non-blocking — returns defaults on failure.
 */
export async function fetchInstagramEngagement(
  accessToken?: string,
  igAccountId?: string,
): Promise<CachedEngagement> {
  if (!accessToken || !igAccountId) {
    return loadEngagementData();
  }

  try {
    // Fetch recent media with timestamp and like counts
    const hostUrl = accessToken.startsWith('IGAA') ? 'graph.instagram.com' : 'graph.facebook.com';
    const url = `https://${hostUrl}/${igAccountId}/media?fields=timestamp,like_count,comments_count&limit=50&access_token=${accessToken}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });

    if (!res.ok) {
      return loadEngagementData();
    }

    const data = await res.json() as { data?: IgMediaPost[] };
    const posts: IgMediaPost[] = data.data ?? [];

    if (posts.length < 5) {
      return loadEngagementData();
    }

    // Build hour → total engagement map
    const hourEngagement: Record<number, number> = {};
    const dayEngagement: Record<number, number> = {};

    for (const post of posts) {
      if (!post.timestamp) continue;
      const date = new Date(post.timestamp);
      const hour = date.getHours();
      const day = date.getDay();
      const engagement = (post.like_count || 0) + (post.comments_count || 0) * 3;

      hourEngagement[hour] = (hourEngagement[hour] || 0) + engagement;
      dayEngagement[day] = (dayEngagement[day] || 0) + engagement;
    }

    // Normalize to 0-1 weights
    const maxHour = Math.max(...Object.values(hourEngagement), 1);
    const hours: EngagementHour[] = DEFAULT_HOUR_WEIGHTS.map(h => ({
      hour: h.hour,
      weight: hourEngagement[h.hour]
        ? Math.max(0.1, (hourEngagement[h.hour] / maxHour))
        : h.weight * 0.5, // Blend: 50% default for hours with no data
    }));

    const maxDay = Math.max(...Object.values(dayEngagement), 1);
    const days: EngagementDay[] = DEFAULT_DAY_MULTIPLIERS.map(d => ({
      day: d.day,
      multiplier: dayEngagement[d.day]
        ? Math.max(0.5, (dayEngagement[d.day] / maxDay))
        : d.multiplier * 0.5,
    }));

    const result: CachedEngagement = {
      hours,
      days,
      fetchedAt: Date.now(),
      source: 'instagram',
      samples: posts.length,
    };

    saveEngagementData(result);
    return result;
  } catch {
    return loadEngagementData();
  }
}

/** Per-slot breakdown — drives both the raw `scoreSlot` and the
 *  heatmap tooltip's "Day weight × Hour weight + Bonus" line. */
export interface SlotScoreBreakdown {
  score: number;
  dayMult: number;
  hourWeight: number;
  weekendBonus: number;
}

/**
 * Score a time slot and return the contributing factors. The heatmap
 * tooltip needs the breakdown; `findBestSlots` only needs `.score`.
 */
export function scoreSlotDetailed(
  date: Date,
  hour: number,
  engagement: CachedEngagement,
): SlotScoreBreakdown {
  const dayMult = engagement.days.find(d => d.day === date.getDay())?.multiplier || 0.7;
  const hourWeight = engagement.hours.find(h => h.hour === hour)?.weight || 0.3;

  // Weekend evening bonus
  const day = date.getDay();
  const isWeekend = day === 0 || day === 5 || day === 6;
  const weekendBonus = (isWeekend && hour >= 19 && hour <= 21) ? 0.15 : 0;

  return {
    score: (dayMult * hourWeight) + weekendBonus,
    dayMult,
    hourWeight,
    weekendBonus,
  };
}

/**
 * Score a time slot based on engagement data.
 */
function scoreSlot(
  date: Date,
  hour: number,
  engagement: CachedEngagement,
): number {
  return scoreSlotDetailed(date, hour, engagement).score;
}

/**
 * V040-001: build a `${dateStr}:${hour}` → breakdown map for a 7-day
 * window. Hours 0–5 are skipped (matching `findBestSlots` L281), so
 * those cells never appear in the map and the heatmap renders no tint.
 *
 * `dateStr` uses the same `YYYY-MM-DD` shape produced by the calendar
 * view (`toYMD` in MainContent.tsx), built locally here from the Date
 * to avoid a UTC drift on `toISOString().split('T')[0]`.
 */
export function computeWeekScores(
  days: Date[],
  engagement: CachedEngagement,
): Map<string, SlotScoreBreakdown> {
  const out = new Map<string, SlotScoreBreakdown>();
  for (const d of days) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${day}`;
    for (let hour = 6; hour <= 23; hour++) {
      out.set(`${dateStr}:${hour}`, scoreSlotDetailed(d, hour, engagement));
    }
  }
  return out;
}

/** Richer post shape used for cap-aware scheduling. All fields optional
 *  so legacy callers passing `{ date, time }` still type-check.
 *  Status union mirrors `ScheduledPost.status` so callers can pass
 *  `ScheduledPost[]` directly without a cast. */
export interface ExistingPost {
  date: string;
  time: string;
  platforms?: string[];
  status?: 'pending_approval' | 'scheduled' | 'posted' | 'failed' | 'rejected';
}

/** Per-platform daily caps. Missing entry = no cap for that platform. */
export type DailyCaps = Partial<Record<string, number>>;

/**
 * Build a `${date}|${platform}` → count map of posts that count
 * toward today's cap. Per user spec, `posted` and `failed` are
 * excluded — only future inventory (scheduled / pending_approval /
 * undefined-status) counts, so historical successful posts can't
 * permanently lock a day out.
 */
function buildPerDayPlatformCounts(posts: ExistingPost[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of posts) {
    if (p.status === 'posted' || p.status === 'failed' || p.status === 'rejected') continue; // BUG-CRIT-009: rejected posts must not lock days either
    const platforms = p.platforms || [];
    for (const plat of platforms) {
      const key = `${p.date}|${plat}`;
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return counts;
}

/**
 * BUG-CRIT-002: per-day post count (any platform). Drives the
 * saturation penalty in `findBestSlots` so back-to-back
 * `findBestSlot` calls in a pipeline don't pile every post onto the
 * single highest-scoring day. Same status filter as the per-platform
 * counts above — historical posted/failed don't penalize future days.
 */
function buildPerDayCounts(posts: ExistingPost[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of posts) {
    if (p.status === 'posted' || p.status === 'failed' || p.status === 'rejected') continue; // BUG-CRIT-009: rejected posts must not lock days either
    counts[p.date] = (counts[p.date] || 0) + 1;
  }
  return counts;
}

/**
 * Find the N best upcoming slots.
 * Skips already-taken slots, picks optimal times based on engagement.
 *
 * If `caps` and `platforms` are supplied, also skips any day where any
 * of the requested platforms has already hit its cap.
 *
 * ALGORITHM: greedy selection (not sort-then-slice). After each pick,
 * `dayCounts[dateStr]` is incremented so subsequent picks on the same
 * day pay an increasing penalty. This solves the bunching problem where
 * all N posts land on Saturday — even with a static divisor, Saturday's
 * raw scores are so high that every top-N slot is on the same day. With
 * greedy, once Saturday 20:00 is picked, Sat 19:00 gets divisor=2,
 * Sat 18:00 gets divisor=3, and Friday 20:00 (divisor=1, no penalty)
 * beats Saturday 18:00 (raw 0.81 / 3 = 0.27) even though Friday's
 * raw score (0.95) is lower. Result: natural spread across the week,
 * at least one post per day when count >= 7.
 *
 * Per-platform hard caps via `options.caps` still take precedence.
 */
export function findBestSlots(
  existingPosts: ExistingPost[],
  count: number = 1,
  engagement?: CachedEngagement,
  options?: {
    /** Platforms the new post is going to publish to. */
    platforms?: string[];
    /** Per-platform daily caps. Missing entry = no cap. */
    caps?: DailyCaps;
    /**
     * V060-004: cap the candidate window. Defaults to 14 days for
     * back-compat; `pickFillWeekSlot` passes 7 when the current week
     * is unfilled so the engagement-best slot can't leak into next
     * week before this one is full.
     */
    horizonDays?: number;
    /**
     * AUTO-SCHEDULE-FIX (2026-05-21): hard cap on posts per day across
     * ALL platforms (distinct from per-platform `caps` above). When set,
     * any day whose existing-post count >= postsPerDay is excluded from
     * the candidate grid entirely. The original soft dispersion penalty
     * (`score / (1 + count)`) wasn't strong enough — a dominant
     * engagement day (e.g. Saturday 20:00) would still outscore weaker
     * days even after stacking 5+ posts. Maurice reported pipeline runs
     * piling every post on one day; root cause was the missing hard cap.
     * Undefined = no cap = pre-fix behaviour (preserves existing tests).
     */
    postsPerDay?: number;
    /**
     * AUTO-SCHEDULE-DEPTH-FIRST (2026-05-22): controls how the picker
     * spreads slots across days vs within a day.
     *
     * - `'breadth'` (default, back-compat): score every (date, hour)
     *   globally and pick highest after a soft per-day penalty. Tends
     *   to spread one post per day across the horizon at each day's
     *   peak heatmap hour. Maurice reported 12 posts all queued at
     *   19:00 across 12 different days — exactly this behaviour.
     * - `'depth'`: iterate days chronologically. For each day not yet
     *   at the `postsPerDay` cap, pick the highest-weight heatmap hour
     *   still available, repeat until the day's cap is hit, then move
     *   to the next day. Fills each day's heatmap-ordered hours before
     *   spilling to the next day. Pipeline + manual modal both use
     *   this — see pickFillWeekSlot + useSmartScheduler.
     */
    fillMode?: 'breadth' | 'depth';
  },
): SlotScore[] {
  const eng = engagement || loadEngagementData();
  const taken = new Set(existingPosts.map(p => `${p.date}T${p.time}`));
  const platforms = options?.platforms || [];
  const caps = options?.caps || {};
  const horizonDays = Math.max(1, options?.horizonDays ?? 14);
  const postsPerDay = options?.postsPerDay;
  const fillMode = options?.fillMode ?? 'breadth';
  const platDayCounts = buildPerDayPlatformCounts(existingPosts);
  const dayCounts = buildPerDayCounts(existingPosts);

  // Helper — would adding one more post to `dateStr` for any of the
  // target platforms blow past that platform's cap?
  const dayWouldExceedCap = (dateStr: string): boolean => {
    if (platforms.length === 0) return false;
    for (const plat of platforms) {
      const cap = caps[plat];
      if (cap == null) continue; // no cap → fine
      const current = platDayCounts[`${dateStr}|${plat}`] || 0;
      if (current >= cap) return true;
    }
    return false;
  };

  // AUTO-SCHEDULE-FIX (2026-05-21): hard-cap check used both at grid
  // build time (skip days already at the cap) AND inside the selection
  // loop (skip if a same-call earlier round pushed the day to the cap).
  const dayAtPostsPerDayCap = (dateStr: string, localCount: number): boolean => {
    if (postsPerDay == null) return false;
    return localCount >= postsPerDay;
  };

  // `dayCounts` is mutated during selection so each pick on the same day
  // pays an increasing penalty (1 + count_so_far). `taken` is mutated for
  // the same reason — to prevent picking the same (date, time) twice
  // within one call.
  const dayCountsLocal = { ...dayCounts };

  // INCLUDE-TODAY (2026-05-22): pipeline scheduler now considers TODAY
  // as a candidate day for slot picks. Previously startDate was anchored
  // on TOMORROW (the +1 below) — Maurice's bug report flagged that
  // approved content was always pushed to tomorrow even when today had
  // empty capacity. The exclusion was deliberate ("today is already
  // passed") but wrong: at 14:00 a 20:00 today slot is still in the
  // future, and the autoposter handles the wait correctly.
  //
  // Past-hour filter is applied inside the dayOffset===0 (today) loop
  // so we don't schedule for an hour that's already gone (e.g. 8:00 at
  // 18:30). `eng.hours` is iterated below; the filter is the same for
  // both depth-first and breadth-first paths.
  const now = new Date();
  const startDate = new Date(now);
  startDate.setHours(0, 0, 0, 0);
  const currentHour = now.getHours();

  // AUTO-SCHEDULE-DEPTH-FIRST (2026-05-22): when fillMode='depth',
  // iterate days chronologically and fill each day's heatmap-ordered
  // hours up to postsPerDay before moving to the next day. Bypasses the
  // global score-max picker below. Maurice's pipeline + manual modal
  // use this path. The breadth-first picker stays as the default for
  // back-compat with existing call sites that don't set fillMode.
  if (fillMode === 'depth') {
    const selectedDepth: SlotScore[] = [];
    const sortedHours = [...eng.hours]
      .filter((h) => h.hour >= 6 && h.hour <= 23)
      .sort((a, b) => b.weight - a.weight);
    for (let dayOffset = 0; dayOffset < horizonDays && selectedDepth.length < count; dayOffset++) {
      const checkDate = new Date(startDate);
      checkDate.setDate(checkDate.getDate() + dayOffset);
      const dateStr = formatLocalDate(checkDate);
      if (dayWouldExceedCap(dateStr)) continue;
      // Fill this day's hours (heatmap-ordered) until the cap or until
      // the global `count` request is satisfied.
      const dayEng = eng.days.find((d) => d.day === checkDate.getDay());
      const isToday = dayOffset === 0;
      for (const { hour, weight } of sortedHours) {
        if (selectedDepth.length >= count) break;
        if (postsPerDay != null && (dayCountsLocal[dateStr] || 0) >= postsPerDay) break;
        // INCLUDE-TODAY: skip hours already past the current wall clock
        // when picking for today. Same-hour gets skipped too (no
        // sub-hour granularity in the candidate grid; "18:00 today" at
        // 18:30 is in the past).
        if (isToday && hour <= currentHour) continue;
        const time = `${String(hour).padStart(2, '0')}:00`;
        if (taken.has(`${dateStr}T${time}`)) continue;
        if (dayWouldExceedCap(dateStr)) break; // platform cap hit mid-fill
        const reason = `${weight}h weight, ${dayEng?.multiplier ?? 0}x day${eng.source === 'instagram' ? ' (IG data, depth-first)' : ' (research, depth-first)'}`;
        selectedDepth.push({ date: dateStr, time, score: weight, reason });
        taken.add(`${dateStr}T${time}`);
        dayCountsLocal[dateStr] = (dayCountsLocal[dateStr] || 0) + 1;
      }
    }
    return selectedDepth;
  }

  // Pre-build the candidate (date, hour) grid so each round only re-scores
  // — the grid itself is fixed.
  type Cand = { date: string; hour: number; checkDate: Date; raw: number };
  const candidates: Cand[] = [];
  for (let dayOffset = 0; dayOffset < horizonDays; dayOffset++) {
    const checkDate = new Date(startDate);
    checkDate.setDate(checkDate.getDate() + dayOffset);
    const dateStr = formatLocalDate(checkDate);
    if (dayWouldExceedCap(dateStr)) continue;
    // AUTO-SCHEDULE-FIX: skip days already at the postsPerDay cap from
    // the existing posts. Same-call rounds also check via dayAtPostsPerDayCap
    // in the selection loop below.
    if (dayAtPostsPerDayCap(dateStr, dayCountsLocal[dateStr] || 0)) continue;
    const isToday = dayOffset === 0;
    for (const { hour } of eng.hours) {
      if (hour < 6 || hour > 23) continue;
      // INCLUDE-TODAY (2026-05-22): skip already-past hours when the
      // candidate is for today. See depth-first branch above.
      if (isToday && hour <= currentHour) continue;
      candidates.push({
        date: dateStr,
        hour,
        checkDate,
        raw: scoreSlot(checkDate, hour, eng),
      });
    }
  }

  const selected: SlotScore[] = [];
  for (let round = 0; round < count; round++) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const time = `${String(c.hour).padStart(2, '0')}:00`;
      if (taken.has(`${c.date}T${time}`)) continue;
      // AUTO-SCHEDULE-FIX: same-call rounds may have pushed this day to
      // the postsPerDay cap even though the pre-built grid included it.
      if (dayAtPostsPerDayCap(c.date, dayCountsLocal[c.date] || 0)) continue;
      const score = c.raw / (1 + (dayCountsLocal[c.date] || 0));
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    const c = candidates[bestIdx];
    const time = `${String(c.hour).padStart(2, '0')}:00`;
    const hourEng = eng.hours.find(h => h.hour === c.hour);
    const dayEng = eng.days.find(d => d.day === c.checkDate.getDay());
    const reason = `${hourEng?.weight || 0}h weight, ${dayEng?.multiplier || 0}x day${eng.source === 'instagram' ? ' (IG data)' : ' (research)'}`;
    selected.push({ date: c.date, time, score: bestScore, reason });
    taken.add(`${c.date}T${time}`);
    dayCountsLocal[c.date] = (dayCountsLocal[c.date] || 0) + 1;
  }

  return selected;
}

/**
 * Single best slot — drop-in replacement for old findNextAvailableSlot.
 *
 * `options.platforms` + `options.caps` enable per-platform daily caps.
 */
export function findBestSlot(
  existingPosts: ExistingPost[],
  engagement?: CachedEngagement,
  options?: {
    platforms?: string[];
    caps?: DailyCaps;
    /** V060-004: see `findBestSlots`. */
    horizonDays?: number;
    /** AUTO-SCHEDULE-FIX (2026-05-21): see `findBestSlots`. */
    postsPerDay?: number;
    /** AUTO-SCHEDULE-DEPTH-FIRST (2026-05-22): see `findBestSlots`. */
    fillMode?: 'breadth' | 'depth';
  },
): { date: string; time: string } {
  const slots = findBestSlots(existingPosts, 1, engagement, options);
  if (slots.length > 0) return { date: slots[0].date, time: slots[0].time };
  // BUG-2 (2026-05-23) — calendar-analysed retry. When the caller's
  // options narrow the pick (depth-first, postsPerDay cap, or a
  // sub-14-day horizon) the picker can return empty even though days
  // outside the caps still have engagement-scored room. Maurice's bug
  // report: "after approval, auto-schedule just goes to tomorrow" —
  // the pipeline path was hitting the absolute fallback below because
  // every day in the depth-first 7-day window was at postsPerDay.
  // The manual Auto Schedule button never trips this fallback because
  // it never sets postsPerDay/fillMode/horizonDays — so we retry once
  // with those same relaxed options before the tomorrow@19 fallback.
  const constrained =
    options != null &&
    (options.postsPerDay != null ||
      options.fillMode === 'depth' ||
      (options.horizonDays != null && options.horizonDays < 14));
  if (constrained) {
    const relaxed = findBestSlots(existingPosts, 1, engagement, {
      platforms: options?.platforms,
      caps: options?.caps,
    });
    if (relaxed.length > 0) return { date: relaxed[0].date, time: relaxed[0].time };
  }
  // Absolute fallback
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return { date: formatLocalDate(tomorrow), time: '19:00' };
}
