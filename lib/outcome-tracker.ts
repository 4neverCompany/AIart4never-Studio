/**
 * Alpha feedback scaffold — records post outcomes to localStorage so the
 * AI pipeline can eventually learn which styles / models produce content
 * that actually gets posted.
 *
 * Storage key: 'mashup_outcome_history'
 * Cap: 100 entries (oldest rotated out)
 * Scope: client-side only (localStorage). SSR-safe — all functions guard
 *        `typeof window`.
 */

export interface PostOutcome {
  imageId: string;
  prompt: string;
  style: string;
  aspectRatio: string;
  model: string;
  status: 'posted' | 'skipped' | 'rejected';
  platform: string;
  timestamp: number;
  engagement?: {
    likes?: number;
    comments?: number;
    shares?: number;
    fetchedAt?: number;
  };
}

const STORAGE_KEY = 'mashup_outcome_history';
const MAX_OUTCOMES = 100;

function load(): PostOutcome[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PostOutcome[]) : [];
  } catch {
    return [];
  }
}

function save(outcomes: PostOutcome[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(outcomes));
  } catch {
    // Storage quota exceeded or private browsing — silently skip.
  }
}

/** Append one outcome. Rotates oldest entries when cap is reached. */
export function recordOutcome(outcome: PostOutcome): void {
  const outcomes = load();
  outcomes.push(outcome);
  if (outcomes.length > MAX_OUTCOMES) {
    outcomes.splice(0, outcomes.length - MAX_OUTCOMES);
  }
  save(outcomes);
}

/** Returns the last `count` outcomes (default: all). Most recent last. */
export function getRecentOutcomes(count?: number): PostOutcome[] {
  const outcomes = load();
  if (count === undefined || count >= outcomes.length) return outcomes;
  if (count <= 0) return [];
  return outcomes.slice(-count);
}

/**
 * Percentage of recorded outcomes for `style` that ended as 'posted'.
 * Returns 0 if no outcomes recorded for that style.
 */
export function getStyleSuccessRate(style: string): number {
  const outcomes = load().filter(
    (o) => o.style.toLowerCase() === style.toLowerCase(),
  );
  if (outcomes.length === 0) return 0;
  const posted = outcomes.filter((o) => o.status === 'posted').length;
  return Math.round((posted / outcomes.length) * 100);
}

/**
 * Builds a compact summary string for inclusion in pi.dev prompts.
 * Format: "Posted 8/12 Dynamic, 3/5 Illustration. Last 3 rejected: Ray Traced."
 * Returns empty string when fewer than 3 outcomes have been recorded.
 */
export function getOutcomeSummary(): string {
  const outcomes = load();
  if (outcomes.length < 3) return '';

  // Aggregate per style
  const styleMap: Record<string, { posted: number; total: number }> = {};
  for (const o of outcomes) {
    const key = o.style || 'unknown';
    if (!styleMap[key]) styleMap[key] = { posted: 0, total: 0 };
    styleMap[key].total++;
    if (o.status === 'posted') styleMap[key].posted++;
  }

  // Top styles by total volume (at least 2 outcomes)
  const topStyles = Object.entries(styleMap)
    .filter(([, v]) => v.total >= 2)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 3)
    .map(([style, { posted, total }]) => `${posted}/${total} ${style}`);

  // Last 3 non-posted outcomes
  const recentSkipped = outcomes
    .filter((o) => o.status !== 'posted')
    .slice(-3)
    .map((o) => o.style || 'unknown');

  const parts: string[] = [];
  if (topStyles.length > 0) {
    parts.push(`Posted ${topStyles.join(', ')}`);
  }
  if (recentSkipped.length > 0) {
    const unique = [...new Set(recentSkipped)];
    parts.push(`Last ${recentSkipped.length} skipped: ${unique.join(', ')}`);
  }

  return parts.join('. ') + (parts.length > 0 ? '.' : '');
}
