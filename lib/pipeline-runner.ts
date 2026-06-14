/**
 * Thin wrapper that guarantees setPipelineRunning(false) fires on every
 * exit path — clean return, thrown error, or SkipIdeaSignal.
 *
 * Fixes the try/finally gap identified in the v0.2.3 QA debrief:
 * without this, an unexpected JS error inside startPipeline would leave
 * pipelineRunning=true forever, locking the UI.
 */
export async function withPipelineRunning<T>(
  setRunning: (running: boolean) => void,
  fn: () => Promise<T>,
): Promise<T> {
  setRunning(true);
  try {
    return await fn();
  } finally {
    setRunning(false);
  }
}
