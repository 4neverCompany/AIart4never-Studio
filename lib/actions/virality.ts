'use server';

/**
 * Server Action for computing virality score via Higgsfield brain_activity model.
 * Called from the client pipeline via computeViralityScore dep injection.
 */

import { executeViralityPredict } from '@/lib/agent-tools/virality-predict';

export async function computeViralityScoreServer(caption: string): Promise<number | null> {
  try {
    const result = await executeViralityPredict({ prompt: caption });
    if (result.ok && result.value.score !== undefined) {
      // Clamp to valid range
      return Math.max(0, Math.min(100, Math.round(result.value.score)));
    }
    return null;
  } catch {
    // Non-fatal — virality is a hint, not a gate
    return null;
  }
}
