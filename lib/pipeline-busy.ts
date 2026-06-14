// FEAT-006: cross-tree pub/sub for the "pipeline is running" signal.
//
// usePipeline lives inside MashupProvider, but UpdateChecker is mounted
// at the root layout (outside the provider) so it can't read the
// running flag via useMashup(). This module is the seam — usePipeline
// publishes via setPipelineBusy(); UpdateChecker reads via
// isPipelineBusy() / subscribePipelineBusy() to gate auto-install.

let busy = false;
const listeners = new Set<(busy: boolean) => void>();

export function setPipelineBusy(next: boolean): void {
  if (busy === next) return;
  busy = next;
  for (const l of listeners) {
    try { l(next); } catch { /* listener error must not break others */ }
  }
}

export function isPipelineBusy(): boolean {
  return busy;
}

export function subscribePipelineBusy(listener: (busy: boolean) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
