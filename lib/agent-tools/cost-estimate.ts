/**
 * v1.3 Tool Registry — `cost_estimate` tool.
 *
 * Calls the Higgsfield `generate cost` CLI to predict the credit
 * cost of a generation BEFORE the user actually spends credits.
 * The tool is informational — it doesn't gate generation. A 60s
 * in-memory cache (lib/credit-budget.ts) sits on top so a model
 * picker that re-queries on hover doesn't burn credits.
 *
 * Routing:
 *   - text models (brain_activity, llm_text) → HiggsfieldTextAdapter
 *   - everything else                          → HiggsfieldCliAdapter
 *
 * When the CLI is not on PATH or the call fails, the agent
 * layer falls back to the static `creditHint` from
 * `lib/higgsfield/models.ts` (the picker UI handles that).
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

/** Models the text adapter handles. The CLI adapter handles everything else. */
const TEXT_MODELS = new Set(['brain_activity', 'llm_text']);

export const zCostEstimateInput = z.object({
  /** The model slug (e.g. "nano_banana_2", "seedance_2_0", "brain_activity"). */
  model: z
    .string()
    .trim()
    .min(1, 'model cannot be empty')
    .max(80, 'model slug too long (max 80 chars)')
    .describe('Higgsfield model slug to estimate cost for.'),
  /** Prompt to base the estimate on. Optional for some models. */
  prompt: z.string().max(4000).optional(),
  /** Image reference (image models). One of path/url/id. */
  imagePath: z.string().optional(),
  imageUrl: z.string().url().optional(),
  imageId: z.string().optional(),
  /** Duration in seconds (video models). Not currently forwarded to the
   *  cost CLI but kept in the schema for future use. */
  durationSec: z.number().int().min(1).max(60).optional(),
});
export type CostEstimateInput = z.infer<typeof zCostEstimateInput>;

export const zCostEstimateOutput = z.object({
  /** Predicted credit cost. */
  credits: z.number().min(0).describe('Predicted cost in Higgsfield credits.'),
  /** Optional more-precise variant (the CLI may return this for fractional pricing). */
  credits_exact: z.number().optional(),
  currency: z.literal('credit'),
  /** The model the estimate is for. */
  model: z.string(),
  /** Set when the estimate is approximate (e.g. the live call failed and
   *  we fell back to the static creditHint). The UI can label these. */
  approximate: z.boolean().optional(),
  /** Raw CLI response for debugging. */
  raw: z.unknown().optional(),
});
export type CostEstimateOutput = z.infer<typeof zCostEstimateOutput>;

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Resolve the right adapter and call its `estimateCost` method.
 * Exposed for the pipeline + UI directly (not just through the
 * AI SDK's tool() path) so the cost appears before generation,
 * not as part of an agent loop step.
 */
export async function executeCostEstimate(
  rawInput: unknown,
  opts: { signal?: AbortSignal } = {},
): Promise<ToolResult<CostEstimateOutput>> {
  return safeExecute(async () => {
    const parsed = zCostEstimateInput.safeParse(rawInput);
    if (!parsed.success) throw parsed.error;
    const input = parsed.data;

    const isText = TEXT_MODELS.has(input.model);
    const providerName = isText ? 'higgsfield-text' : 'higgsfield';
    let adapter;
    try {
      adapter = getProvider(providerName);
    } catch {
      throw new ToolNotAvailableError(
        'cost_estimate',
        `provider "${providerName}" is not registered — check lib/providers/registry.ts`,
      );
    }

    const available = await adapter.isAvailable();
    if (!available) {
      throw new ToolNotAvailableError(
        'cost_estimate',
        `Higgsfield CLI is not available on PATH (higgsfield or higgs binary missing)`,
      );
    }

    // Dispatch by adapter type. Both adapters expose `estimateCost`;
    // the text adapter takes a single prompt, the CLI adapter takes
    // a model + opts.
    const adapterAny = adapter as unknown as {
      estimateCost(
        arg1: string,
        arg2?: {
          prompt?: string;
          imagePath?: string;
          imageUrl?: string;
          imageId?: string;
          durationSec?: number;
        },
      ): Promise<{
        credits: number;
        credits_exact?: number;
        currency: 'credit';
        raw: unknown;
      }>;
    };

    if (typeof adapterAny.estimateCost !== 'function') {
      throw new ToolExecutionError(
        'cost_estimate',
        `provider "${providerName}" does not implement estimateCost`,
        { retryable: false },
      );
    }

    let result: {
      credits: number;
      credits_exact?: number;
      currency: 'credit';
      raw: unknown;
    };
    try {
      if (isText) {
        result = await adapterAny.estimateCost(input.prompt ?? '');
      } else {
        result = await adapterAny.estimateCost(input.model, {
          prompt: input.prompt,
          imagePath: input.imagePath,
          imageUrl: input.imageUrl,
          imageId: input.imageId,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ToolExecutionError('cost_estimate', msg, { retryable: true, cause: e });
    }

    return zCostEstimateOutput.parse({
      credits: result.credits,
      credits_exact: result.credits_exact,
      currency: 'credit',
      model: input.model,
      raw: result.raw,
    });
  });
}

// ---------------------------------------------------------------------------
// Vercel AI SDK `tool()` definition
// ---------------------------------------------------------------------------

export const costEstimateTool = tool({
  description:
    'Estimate the credit cost of a generation BEFORE spending credits. Wraps `higgsfield generate cost <model> --json`. Use before a generate_image / generate_video / generate_text to inform the user (or the agent loop) about expected spend. Returns credit count. ~1 credit per call (the cost call itself, not the predicted generation cost).',
  inputSchema: zCostEstimateInput,
  outputSchema: zCostEstimateOutput,
  execute: async (input, options) => {
    const result = await executeCostEstimate(input, {
      signal: options?.abortSignal,
    });
    if (!result.ok) throw result.error;
    return result.value;
  },
});
