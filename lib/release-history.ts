// V083-UPDATE-UI — static release history surfaced by the Updates
// section in DesktopSettingsPanel. Hand-maintained alongside each
// `chore(release)` commit. Keep highlights short (≤ 80 chars each) and
// user-facing — this is what lands in the settings panel, not a commit
// log. Newest entries go FIRST; the UI trusts this ordering.

export interface ReleaseNote {
  version: string;
  date: string;
  highlights: readonly string[];
}

export const RELEASE_HISTORY: readonly ReleaseNote[] = [
  {
    version: '0.8.3',
    date: '2026-04-23',
    highlights: [
      'Update toast now shows a visual gold→cyan progress bar + byte readout',
      'Settings → Updates: installing row gets the same progress bar',
      'New Release history panel in Settings → Updates (this one)',
      'Audited Tauri update system — all core features verified shipped',
    ],
  },
  {
    version: '0.8.2',
    date: '2026-04-23',
    highlights: [
      'Fixed kebab menu dropdown rendering behind adjacent cards',
      'Gallery: batch-create a collection from selected images',
      'Gallery: auto-organize saved images by tag',
      'Post Ready: new sort dropdown (saved / scheduled / created)',
      'Deterministic Leonardo param suggestions (no more AI hiccups)',
    ],
  },
  {
    version: '0.8.1',
    date: '2026-04-23',
    highlights: [
      'Approval Queue rebranded to electric blue for better contrast',
      'Animated aggregate pipeline progress bar',
      'Tighter mobile layout at 390px',
      'Closed 4 QA-flagged test gaps + CountdownBadge NaN guard',
    ],
  },
  {
    version: '0.8.0',
    date: '2026-04-23',
    highlights: [
      'Gallery: rejected-only pipeline images are now hidden',
      'Carousel: per-image reject down to a single survivor',
      'Post Ready: live countdown badge on scheduled cards',
      'Onboarding: footer always visible + expanded tag pool',
      'AI focus-block now driven by agent niches + genres',
    ],
  },
  {
    version: '0.7.3',
    date: '2026-04-23',
    highlights: [
      'Updater: calm "unavailable" state replaces red ACL error banner',
      'Updater: last-checked timestamp now stamped on every attempt',
    ],
  },
  {
    version: '0.7.2',
    date: '2026-04-21',
    highlights: [
      'Platform groups with per-platform toggles in Desktop Settings',
      'Tri-state launch-time update behavior (auto / notify / off)',
    ],
  },
] as const;

/**
 * Return the N most recent releases, newest first. Clamped to the
 * available history length so callers don't have to branch.
 */
export function recentReleases(limit: number): readonly ReleaseNote[] {
  if (limit <= 0) return [];
  return RELEASE_HISTORY.slice(0, Math.min(limit, RELEASE_HISTORY.length));
}

/**
 * Look up a specific release by version string. Used by the "what's new"
 * toast when the installed version matches a known entry.
 */
export function releaseByVersion(version: string): ReleaseNote | null {
  return RELEASE_HISTORY.find((r) => r.version === version) ?? null;
}
