/**
 * v1.3 Tool Registry — `virality_predict` tool.
 *
 * Calls the Higgsfield brain_activity model to score a post's
 * predicted engagement virality (1–100). The score is computed
 * synchronously when a post enters the approval queue and stored
 * on the ScheduledPost record so the UI can show it without a
 * re-call.
 *
 * Integration: called from pipeline-processor.ts after a
 * ScheduledPost is created with status === 'pending_approval'.
 */

import { tool } from 'ai';
import { z } from 'zod';
import {
  ToolNotAvailableError,
  ToolExecutionError,
  safeExecute,
  type ToolResult,
} from './errors';
import { getProvider } from '@/lib/providers/registry';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const zViralityPredictInput = z.object({
  /** The post caption + hashtags to score. */
  prompt: z
    .string()
    .trim()
    .min(1, 'prompt cannot be empty or whitespace-only')
    .max(4000, 'prompt too long (max 4000 chars)')
    .describe('Caption or full post text to score for virality potential.'),
});
export type ViralityPredictInput = z.infer<typeof zViralityPredictInput>;

export const zViralityPredictOutput = z.object({
  /** Virality score in 1–100. Higher = more predicted engagement. */
  score: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe('Predicted virality score in 0–100.'),
  /** Model's confidence in the score, 0–1. */
  confidence: z.number().min(0).max(1).optional(),
  /** Short reasoning from the model (may be empty). */
  reasoning: z.string().optional(),
});
export type ViralityPredictOutput = z.infer<typeof zViralityPredictOutput>;

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

const PROVIDER_NAME = 'higgsfield-text';

/**
 * Call the HiggsfieldTextAdapter.generateText() method, which
 * wraps `higgsfield generate create brain_activity --prompt ... --json`.
 *
 * This is NOT called via the AI SDK's tool() execute() path — it's
 * called directly from the pipeline processor (outside the AI SDK
 * agent loop) to compute the score synchronously on post-creation.
 * The tool() definition below exists so:
 *   1. The schema is registered in schemas.ts for re-use
 *   2. The AI SDK can call it if an agent wants to re-score a post
 */
export async function executeViralityPredict(
  rawInput: unknown,
  opts: { signal?: AbortSignal } = {},
): Promise<ToolResult<ViralityPredictOutput>> {
  return safeExecute(async () => {
    const parsed = zViralityPredictInput.safeParse(rawInput);
    if (!parsed.success) throw parsed.error;
    const input = parsed.data;

    // Get the text adapter (lazy singleton from registry)
    let adapter;
    try {
      adapter = getProvider(PROVIDER_NAME);
    } catch {
      throw new ToolNotAvailableError(
        'virality_predict',
        `provider "${PROVIDER_NAME}" is not registered — check lib/providers/registry.ts`,
      );
    }

    const available = await adapter.isAvailable();
    if (!available) {
      throw new ToolNotAvailableError(
        'virality_predict',
        `Higgsfield CLI is not available on PATH (higgsfield or higgs binary missing)`,
      );
    }

    // The adapter has generateText(prompt) returning GenerateTextResult
    const adapterAny = adapter as unknown as {
      generateText(prompt: string, opts?: { signal?: AbortSignal }): Promise<{
        score: number;
        confidence?: number;
        reasoning?: string;
      }>;
    };

    if (typeof adapterAny.generateText !== 'function') {
      throw new ToolExecutionError(
        'virality_predict',
        `provider "${PROVIDER_NAME}" does not implement generateText`,
        { retryable: false },
      );
    }

    let result: { score: number; confidence?: number; reasoning?: string };
    try {
      result = await adapterAny.generateText(input.prompt, { signal: opts.signal });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ToolExecutionError('virality_predict', msg, { retryable: true, cause: e });
    }

    return zViralityPredictOutput.parse(result);
  });
}

// ---------------------------------------------------------------------------
// Vercel AI SDK `tool()` definition
// ---------------------------------------------------------------------------

export const viralityPredictTool = tool({
  description:
    'Predict the virality score (0–100) of a post caption or concept using the Higgsfield brain_activity model. Returns a score, confidence, and optional reasoning. Called automatically when a post enters the approval queue.',
  inputSchema: zViralityPredictInput,
  outputSchema: zViralityPredictOutput,
  execute: async (input, options) => {
    const result = await executeViralityPredict(input, {
      signal: options?.abortSignal,
    });
    if (!result.ok) throw result.error;
    return result.value;
  },
});
