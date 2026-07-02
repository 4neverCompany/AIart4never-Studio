/**
 * Story 8-12 — the persisted TUNED WEEKLY TEMPLATE (OAQ-5 / Open Q4: DECIDED).
 *
 * ## OAQ-5 — WHERE accepted template changes persist (decided)
 *
 * **Local Studio config, NOT upstream to the canon source.** One line why: the
 * tuned template is per-operator, revocable LEARNING state derived from one
 * account's engagement — canon-in-code (`lib/canon`'s frozen `WEEKLY_TEMPLATE`)
 * stays the reviewed, versioned truth — and the local store is the one context
 * that everything running `buildWeeklyContentPlan` can already read.
 *
 * Concretely: a standalone `@/lib/persistence` key
 * ({@link TUNED_TEMPLATE_KEY}), the SAME storage idiom as the autonomy journal
 * (`aiart4never_autonomy_journal`), the tuning decision log
 * (`aiart4never_tuning_decisions`), the autonomy config, and the insights
 * cache. That store is Tauri-plugin-store under the app
 * (`%APPDATA%\com.4nevercompany.mashupforge\mashupforge.json`) with an
 * idb-keyval fallback elsewhere — and, crucially, the headless Node CLI
 * (`bin/aiart4never.ts`, which is what runs `buildWeeklyContentPlan` on the
 * weekly cadence) already reads/writes through this exact surface, so the
 * saved template is visible to the SAME context that builds next week's plan.
 * A `UserSettings` field was rejected (couples plan state to the browser
 * settings hook + deep-merge semantics); pushing upstream into `lib/canon`
 * was rejected (self-tuning must never rewrite canon — the agent editing its
 * own source of truth is exactly the silent-drift failure mode the operator
 * gate exists to prevent).
 *
 * ## The staleness guard (safe interpretation)
 *
 * Canon invariants (six slots, the Friday new-gen guarantee, per-pillar
 * presence) are enforced at ADAPT time, not inside a stored blob — so a saved
 * template that was valid once could go stale if the canon `WEEKLY_TEMPLATE`
 * itself evolves (a pillar added, a slot moved). The safe interpretation,
 * encoded in {@link isValidTunedTemplate} and applied on EVERY load: the saved
 * template overrides canon ONLY while it still matches the current canon
 * template 1:1 structurally (same slot count, and per position the same
 * `day`/`pillarId`/`format`/`guaranteesNewGen`) and its advisory annotations
 * are well-formed (hour an integer 0..23, hook a non-empty string). Anything
 * else → `loadTunedTemplate` returns `null` and the caller falls back to the
 * canon default — a stale or corrupt store can never smuggle a broken template
 * into the planner. Because only the ADVISORY `recommendedHour`/`hookId` may
 * differ from canon, the six-slot/Friday-guarantee invariants hold by
 * construction on every template this module will load or save.
 *
 * Reads are tolerant (missing / corrupt / stale → `null`, never a crash);
 * saves are strict (an invariant-violating template THROWS and writes
 * nothing) — the store only ever contains a template the planner can trust.
 */

import { WEEKLY_TEMPLATE } from '@/lib/canon';
import type { WeeklySlot } from '@/lib/canon';
import { get, set } from '@/lib/persistence';
import type { TunedSlot } from './proposals';

/** Persistence key for the saved tuned weekly template (OAQ-5: local Studio config). */
export const TUNED_TEMPLATE_KEY = 'aiart4never_tuned_weekly_template';

/**
 * The persisted shape: the tuned slots plus WHEN they were saved (unix ms —
 * the `decidedAt` of the accepting run), so the report can name the vintage
 * of the template it plans from.
 */
export interface SavedTunedTemplate {
  slots: TunedSlot[];
  savedAt: number;
}

/**
 * Is `value` a tuned template the planner can trust — i.e. the CURRENT canon
 * `base` template with at most advisory annotations on top?
 *
 * Checks, per the module-header staleness guard:
 *   - an array of exactly `base.length` slots (stable six-slot count);
 *   - position `i` structurally equals `base[i]` on `day` / `pillarId` /
 *     `format` / `guaranteesNewGen` (the Friday guarantee and per-pillar
 *     presence are inherited from canon by this 1:1 match — a tuned template
 *     can never move, drop, or re-guarantee a slot);
 *   - `recommendedHour`, when present, is an integer 0..23;
 *   - `hookId`, when present, is a non-empty string.
 *
 * `base` is injectable for tests; production callers use the canon default so
 * a template saved under an OLDER canon simply stops validating (and the
 * loader falls back) the moment canon changes shape.
 */
export function isValidTunedTemplate(
  value: unknown,
  base: ReadonlyArray<WeeklySlot> = WEEKLY_TEMPLATE,
): value is TunedSlot[] {
  if (!Array.isArray(value) || value.length !== base.length) return false;
  return value.every((slot, i) => {
    if (typeof slot !== 'object' || slot === null) return false;
    const s = slot as Record<string, unknown>;
    const b = base[i]!;
    if (
      s.day !== b.day ||
      s.pillarId !== b.pillarId ||
      s.format !== b.format ||
      s.guaranteesNewGen !== b.guaranteesNewGen
    ) {
      return false;
    }
    if (
      s.recommendedHour !== undefined &&
      (typeof s.recommendedHour !== 'number' ||
        !Number.isInteger(s.recommendedHour) ||
        s.recommendedHour < 0 ||
        s.recommendedHour > 23)
    ) {
      return false;
    }
    if (s.hookId !== undefined && (typeof s.hookId !== 'string' || s.hookId.trim() === '')) {
      return false;
    }
    return true;
  });
}

/**
 * Normalize a slot to EXACTLY the persisted fields. Callers may hand richer
 * shapes (an `AdaptedSlot` carries `adapted`/`rationale`/basis flags), but the
 * store keeps only the canon structure + the two advisory annotations, so the
 * persisted template is always a clean drop-in `baseTemplate`.
 */
function cleanSlot(slot: TunedSlot): TunedSlot {
  return {
    day: slot.day,
    pillarId: slot.pillarId,
    format: slot.format,
    guaranteesNewGen: slot.guaranteesNewGen,
    ...(slot.recommendedHour !== undefined ? { recommendedHour: slot.recommendedHour } : {}),
    ...(slot.hookId !== undefined ? { hookId: slot.hookId } : {}),
  };
}

/**
 * Persist the operator-accepted tuned template (Story 8-12 AC2). `savedAt` is
 * injected (the accepting run's `decidedAt`) — no hidden clock. STRICT: an
 * invariant-violating template throws and writes NOTHING, so the store can
 * only ever hold a template {@link loadTunedTemplate} will accept back.
 */
export async function saveTunedTemplate(
  slots: ReadonlyArray<TunedSlot>,
  savedAt: number,
): Promise<void> {
  const clean = slots.map(cleanSlot);
  if (!isValidTunedTemplate(clean)) {
    throw new Error(
      'refusing to save a tuned weekly template that violates the canon template invariants (six slots, 1:1 structural match, valid hour/hook annotations)',
    );
  }
  await set(TUNED_TEMPLATE_KEY, { slots: clean, savedAt } satisfies SavedTunedTemplate);
}

/**
 * Load the saved tuned template, or `null` when there is nothing usable —
 * never stored (cold start, AC4), explicitly cleared, corrupt, or STALE
 * against the current canon template (the module-header guard). Tolerant like
 * the journal/decision-log reads: a broken store yields `null`, never a crash,
 * and the caller's `?? WEEKLY_TEMPLATE` fallback does the rest.
 */
export async function loadTunedTemplate(): Promise<SavedTunedTemplate | null> {
  try {
    const stored = await get<SavedTunedTemplate>(TUNED_TEMPLATE_KEY);
    if (!stored || typeof stored !== 'object') return null;
    if (typeof stored.savedAt !== 'number' || !Number.isFinite(stored.savedAt)) return null;
    if (!isValidTunedTemplate(stored.slots)) return null;
    return { slots: stored.slots.map(cleanSlot), savedAt: stored.savedAt };
  } catch {
    // A corrupt/unavailable store must not crash the weekly run — the plan
    // falls back to the canon default, which is always safe.
    return null;
  }
}

/**
 * Clear the saved tuned template — the operator's explicit "back to canon"
 * control (`run-week --reset-tuning`). Without this, a persisted accept could
 * only be undone by hand-editing the store file; with it, the OAQ-9 loop's
 * `'prior-wins'` verdict has a real revert path.
 */
export async function clearTunedTemplate(): Promise<void> {
  await set(TUNED_TEMPLATE_KEY, null);
}
