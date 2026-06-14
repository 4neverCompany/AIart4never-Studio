/**
 * v1.2 — Director Route 2.0 run persistence.
 *
 * Saves the full `Step[]` log + the final prompt + the
 * run metadata to a small idb-keyval table (`agent_run:<id>`)
 * plus a per-user index (`agent_runs_index:<userId>`) so
 * the future Replay UI can list a user's runs without
 * scanning the whole store.
 *
 * Why a separate module from `lib/persistence.ts`:
 *   - `lib/persistence.ts` is `'use client'` AND falls
 *     through to `idb-keyval`, which uses the browser
 *     `indexedDB` global. In the Next.js server (route
 *     handler runtime) `indexedDB` is undefined, so the
 *     import would throw. The Director route can be hit
 *     server-side; we want persistence to be best-effort
 *     there, not fatal.
 *   - This module is `'use client'` (matches the project
 *     convention for any module touching idb-keyval) but
 *     guards every call with a `typeof window` check, so
 *     server-side imports are safe — they just no-op.
 *   - The schema is intentionally narrow (one key per
 *     run, one index per user) so a future "agent_runs"
 *     SQL table (Tauri's plugin-sql) can mirror the
 *     same shape one-to-one.
 *
 * Storage layout:
 *   `agent_run:<runId>`              → `AgentRun` JSON
 *   `agent_runs_index:<userId>`      → `string[]` (runIds, MRU-last)
 *
 * The index is updated synchronously with the run write so
 * the two can't drift. Concurrent writes from multiple
 * tabs are out of scope (the route layer is single-flight
 * per user per session) and the Replay UI will tolerate a
 * stale index on the next refresh.
 */
'use client';

import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';
import type { Step } from './log';

export type TruncatedBy = 'budget' | 'step_limit' | 'error' | 'natural';

export interface AgentRun {
  runId: string;
  userId: string;
  startedAt: number;
  finishedAt?: number;
  niches: string[];
  genres: string[];
  ideaConcept: string;
  steps: readonly Step[];
  totalCost: number;
  finalPrompt?: string;
  truncatedBy?: TruncatedBy;
  modelId?: string;
  /** Optional free-form tag, e.g. 'idea', 'enhance'. */
  mode?: string;
}

const RUN_KEY_PREFIX = 'agent_run:';
const INDEX_KEY_PREFIX = 'agent_runs_index:';

/**
 * Build the storage key for a run. Exported so tests can
 * assert against the exact string the route wrote.
 */
export function runKey(runId: string): string {
  return `${RUN_KEY_PREFIX}${runId}`;
}

/**
 * Build the storage key for a user's run-index.
 */
export function userIndexKey(userId: string): string {
  return `${INDEX_KEY_PREFIX}${userId}`;
}

/**
 * Strip the prefix from a stored key. Returns the runId or
 * userId segment, or `null` if the key doesn't match our
 * prefix. Used by `listAllRuns` to filter out unrelated
 * idb-keyval entries.
 */
function keySuffix(prefix: string, key: string): string | null {
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

/**
 * Server-side guard. `idb-keyval` calls into `indexedDB`,
 * which is a browser global. The Director route runs in
 * the Node.js runtime; persistence there would throw.
 * We no-op instead and let the route return the run
 * data in its JSON response so the client can re-persist
 * if it wants to.
 */
function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

/**
 * Persist a run. Best-effort: returns silently on
 * `!isBrowser()`, throws only on a real IDB error
 * (caller decides whether to surface it).
 *
 * The user's index is read-modify-write. Concurrent
 * calls from the same tab can race; the second writer
 * wins on the array's tail but no run is lost because
 * we always set-dedupe.
 */
export async function saveRun(run: AgentRun): Promise<void> {
  if (!isBrowser()) return;
  const runJson: AgentRun = {
    ...run,
    steps: [...run.steps], // freeze the snapshot — caller may mutate later
  };
  await idbSet(runKey(run.runId), runJson);

  const idxKey = userIndexKey(run.userId);
  const existing = ((await idbGet(idxKey)) as string[] | undefined) ?? [];
  if (!existing.includes(run.runId)) {
    const next = [...existing, run.runId];
    await idbSet(idxKey, next);
  }
}

/**
 * Update an existing run in place. We rewrite the same
 * key and re-add the id to the index (idempotent). The
 * caller's `run` should have the same `runId` and
 * `userId` as the original.
 */
export async function updateRun(run: AgentRun): Promise<void> {
  if (!isBrowser()) return;
  await idbSet(runKey(run.runId), { ...run, steps: [...run.steps] });
  const idxKey = userIndexKey(run.userId);
  const existing = ((await idbGet(idxKey)) as string[] | undefined) ?? [];
  if (!existing.includes(run.runId)) {
    await idbSet(idxKey, [...existing, run.runId]);
  }
}

/**
 * Load a single run by id. Returns `null` when the key
 * doesn't exist OR when we're not in a browser. The
 * server-side caller should treat `null` as "not
 * persisted yet" and not as an error.
 */
export async function loadRun(runId: string): Promise<AgentRun | null> {
  if (!isBrowser()) return null;
  const run = (await idbGet(runKey(runId))) as AgentRun | undefined;
  return run ?? null;
}

/**
 * List every run for a user, newest-first. Reads the
 * per-user index and resolves each id; missing ids are
 * silently skipped (handles a partial index from a
 * crashed previous write).
 */
export async function listRunsForUser(
  userId: string,
  opts: { limit?: number } = {},
): Promise<AgentRun[]> {
  if (!isBrowser()) return [];
  const ids = ((await idbGet(userIndexKey(userId))) as string[] | undefined) ?? [];
  const limit = opts.limit ?? 50;
  // Resolve in reverse so newest-first.
  const slice = [...ids].reverse().slice(0, limit);
  const runs: AgentRun[] = [];
  for (const id of slice) {
    const run = await loadRun(id);
    if (run) runs.push(run);
  }
  return runs;
}

/**
 * Delete a run + remove it from its user's index. Returns
 * `true` when a run was actually deleted.
 */
export async function deleteRun(runId: string, userId: string): Promise<boolean> {
  if (!isBrowser()) return false;
  await idbDel(runKey(runId));
  const idxKey = userIndexKey(userId);
  const existing = ((await idbGet(idxKey)) as string[] | undefined) ?? [];
  const next = existing.filter((id) => id !== runId);
  if (next.length !== existing.length) {
    await idbSet(idxKey, next);
    return true;
  }
  return false;
}

/**
 * Internal helper for the storage layer. Enumerate every
 * `agent_run:*` key in the idb-keyval store. Exposed for
 * tests + the future "all runs" debug view.
 */
export async function listAllRuns(): Promise<AgentRun[]> {
  if (!isBrowser()) return [];
  // idb-keyval exposes `keys()` for the default store.
  // Lazy import to avoid loading it in non-browser envs.
  const { keys } = await import('idb-keyval');
  const allKeys = (await keys()) as string[];
  const runIds = allKeys
    .map((k) => keySuffix(RUN_KEY_PREFIX, String(k)))
    .filter((s): s is string => s !== null);
  const runs: AgentRun[] = [];
  for (const id of runIds) {
    const run = await loadRun(id);
    if (run) runs.push(run);
  }
  return runs;
}
