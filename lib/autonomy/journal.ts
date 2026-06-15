/**
 * M2 autonomy loop — the persisted audit JOURNAL (append-only).
 *
 * Every tick result is appended here so the operator has a durable trail of
 * what the agent did on its own: which day, generate-vs-reuse-vs-skip, which
 * asset landed in the approval queue, and any error. The journal is capped at
 * the most recent {@link JOURNAL_CAP} entries so it can never grow unbounded.
 *
 * Storage goes through `@/lib/persistence` (the same Tauri-store / idb-keyval
 * wrapper the rest of the app uses), so the journal survives restarts. Reads
 * return most-recent-first for direct rendering in a "recent activity" panel.
 */

import { get, set } from '@/lib/persistence';
import type { AutonomyTickResult } from './types';

/** Persistence key for the autonomy journal. */
export const AUTONOMY_JOURNAL_KEY = 'aiart4never_autonomy_journal';

/** Hard cap on retained journal entries (most-recent kept). */
export const JOURNAL_CAP = 200;

/**
 * Read the raw stored journal in insertion order (oldest-first), tolerating a
 * missing or corrupt value by returning an empty list. Internal — public reads
 * go through {@link readJournal}, which returns most-recent-first.
 */
async function readRaw(): Promise<AutonomyTickResult[]> {
  try {
    const stored = await get<AutonomyTickResult[]>(AUTONOMY_JOURNAL_KEY);
    return Array.isArray(stored) ? stored : [];
  } catch {
    // A corrupt/unavailable store must not crash the autonomy loop — the
    // journal is best-effort audit, not load-bearing state.
    return [];
  }
}

/**
 * Append one tick result to the journal, capping at the most recent
 * {@link JOURNAL_CAP} entries. Stored oldest-first; the cap drops the oldest
 * overflow. Returns the persisted (post-cap) list in stored order.
 */
export async function appendTick(
  result: AutonomyTickResult,
): Promise<AutonomyTickResult[]> {
  const current = await readRaw();
  const next = [...current, result];
  // Keep only the most-recent JOURNAL_CAP entries.
  const capped = next.length > JOURNAL_CAP ? next.slice(next.length - JOURNAL_CAP) : next;
  await set(AUTONOMY_JOURNAL_KEY, capped);
  return capped;
}

/**
 * Read the journal, MOST-RECENT-FIRST (the last-appended tick is index 0), so
 * a "recent autonomy activity" view can render it without re-sorting.
 */
export async function readJournal(): Promise<AutonomyTickResult[]> {
  const raw = await readRaw();
  return raw.slice().reverse();
}
