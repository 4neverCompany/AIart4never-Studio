// V030-003: pipeline log persistence.
//
// Previously the log lived in component state + localStorage. On a crash
// the user lost exactly the log they most need — the last few entries
// that show where things went sideways. Move to IndexedDB via idb-keyval
// so it survives crashes. Bounded at 50 entries (same as the in-memory
// state) to keep the store trivially small.

import { get, set, del } from 'idb-keyval';
import type { PipelineLogEntry } from '../types/mashup';

const KEY = 'mashup_pipeline_log';
const MAX_ENTRIES = 50;

/** On-disk shape — Date → ISO string so JSON round-trips cleanly. */
interface SerializedEntry {
  timestamp: string;
  step: string;
  ideaId: string;
  status: 'success' | 'error';
  message: string;
}

export async function savePipelineLog(entries: PipelineLogEntry[]): Promise<void> {
  const trimmed = entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries;
  const serialized: SerializedEntry[] = trimmed.map(e => ({
    timestamp: e.timestamp.toISOString(),
    step: e.step,
    ideaId: e.ideaId,
    status: e.status,
    message: e.message,
  }));
  try {
    await set(KEY, serialized);
  } catch {
    /* best-effort — log persistence is not worth throwing for */
  }
}

export async function loadPipelineLog(): Promise<PipelineLogEntry[]> {
  try {
    const raw = await get<SerializedEntry[]>(KEY);
    if (!raw || !Array.isArray(raw)) return [];
    return raw.map(e => ({
      timestamp: new Date(e.timestamp),
      step: e.step,
      ideaId: e.ideaId,
      status: e.status,
      message: e.message,
    }));
  } catch {
    return [];
  }
}

export async function clearPipelineLog(): Promise<void> {
  try {
    await del(KEY);
  } catch {
    /* ignore */
  }
}
