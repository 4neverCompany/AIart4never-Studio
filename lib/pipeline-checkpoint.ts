// FEAT-006: persist enough pipeline state so a mid-run app death (auto-update,
// crash, OS kill) can be resumed on next launch. Stored in IndexedDB via
// idb-keyval — same store used by useSettings/useImages, so the same
// origin-pin guarantees apply (STORY-121).
//
// The checkpoint is best-effort: if IDB is unavailable, save/load/clear
// silently no-op so a storage failure never blocks the pipeline.

import { get, set, del } from 'idb-keyval';

const CHECKPOINT_KEY = 'mashup_pipeline_checkpoint';

export interface PipelineCheckpoint {
  /** Stable id of the idea being processed when the checkpoint was written. */
  ideaId: string;
  /** Display label of the in-flight step (e.g. "Captioning") for the resume prompt. */
  step: string;
  /** Idea concept text — display-only; the live idea is reloaded by id. */
  concept: string;
  /** ISO timestamp of last write. */
  ts: string;
  /** Pipeline settings snapshot at run start so resume uses the same config. */
  settings: {
    delay: number;
    continuous: boolean;
    interval: number;
    targetDays: number;
  };
  /** Image ids already saved during this run — informational. */
  imageIds: string[];
}

export async function saveCheckpoint(cp: PipelineCheckpoint): Promise<void> {
  try { await set(CHECKPOINT_KEY, cp); } catch { /* best-effort */ }
}

export async function loadCheckpoint(): Promise<PipelineCheckpoint | null> {
  try {
    const v = await get<PipelineCheckpoint>(CHECKPOINT_KEY);
    return v ?? null;
  } catch { return null; }
}

export async function clearCheckpoint(): Promise<void> {
  try { await del(CHECKPOINT_KEY); } catch { /* best-effort */ }
}
