// Diagnostic trace for the in-app updater flow. Maurice has reported
// that the updater "never works" — meaning he never sees the banner.
// The auto-flow has FIVE silent-return paths and one silent-import-
// failure path; without instrumentation it's impossible to tell which
// one fires. This helper:
//
//   1. Mirrors every step to console.log (visible in devtools).
//   2. Persists a ring buffer to localStorage so the trace survives
//      across sessions and is inspectable from the Settings panel
//      without devtools (production webview has no console).
//
// Usage: `traceUpdater('step-name', optionalData)` at every meaningful
// branch in UpdateChecker.tsx and DesktopSettingsPanel.tsx.

const STORAGE_KEY = 'mashup_updater_trace';
const MAX_ENTRIES = 50;

export interface UpdaterTraceEntry {
  ts: number;
  step: string;
  data?: unknown;
}

export function traceUpdater(step: string, data?: unknown): void {
  const entry: UpdaterTraceEntry = { ts: Date.now(), step, data };

   
  console.log(`[updater-trace] ${step}`, data ?? '');

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const buf: UpdaterTraceEntry[] = raw ? JSON.parse(raw) : [];
    buf.push(entry);
    if (buf.length > MAX_ENTRIES) buf.splice(0, buf.length - MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(buf));
  } catch {
    // localStorage quota / private mode / SSR — silent. The console
    // log above still ran.
  }
}

export function getUpdaterTrace(): UpdaterTraceEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as UpdaterTraceEntry[]) : [];
  } catch {
    return [];
  }
}

export function clearUpdaterTrace(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function formatTraceEntry(e: UpdaterTraceEntry): string {
  const t = new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19);
  const dataStr = e.data === undefined ? '' : ` ${safeStringify(e.data)}`;
  return `${t}  ${e.step}${dataStr}`;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
