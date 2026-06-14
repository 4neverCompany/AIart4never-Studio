/**
 * v1.2.6 Tool Registry — `m3_vision_describe` tool.
 *
 * MiniMax-M3 vision INPUT → text OUTPUT, exposed to the Director
 * loop. The primary text-AI path (`app/api/ai/prompt`) calls
 * MiniMax's OpenAI-compatible `/v1/chat/completions` endpoint
 * which is text-only. M3's vision capability is reached through
 * the `mmx` CLI's `vision describe` subcommand instead.
 *
 * The mmx CLI is the v1.2.0-recommended production path for
 * MiniMax in MashupForge (see `docs/bmad/briefs/mmx-cli-integration.md`).
 * It handles auth (`mmx auth login` → MiniMax Token Plan /
 * API key), file upload, and the multimodal payload.
 *
 * Use case in the Director loop:
 *   1. `generate_image` returns an AssetRef with a URL/path.
 *   2. `m3_vision_describe` asks M3 "is this image consistent
 *      with the original concept? Score 0-1 and list issues."
 *   3. The critique result is fed back into `critique_prompt`
 *      and the loop iterates.
 *
 * The function `executeM3VisionDescribe` is also exported for
 * non-SDK callers (route handlers, the standalone /api/mmx/describe
 * endpoint, and the unit tests).
 */
import { tool } from 'ai';
import {
  type M3VisionDescribeInput,
  type M3VisionDescribeOutput,
  zM3VisionDescribeInput,
  zM3VisionDescribeOutput,
} from './schemas';
import { ToolNotAvailableError, safeExecute, type ToolResult } from './errors';
import {
  describeImage as mmxDescribeImage,
  isAvailable as mmxIsAvailable,
  MmxError,
  MmxQuotaError,
  MmxSpawnError,
} from '../mmx-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the input's image source to a single mmx `source`
 * shape. Exactly one of the three input fields must be set;
 * we pick the first that's truthy. Returning `null` lets the
 * caller surface a clean validation error.
 */
function pickImageSource(
  input: M3VisionDescribeInput,
): { image: string } | { fileId: string } | null {
  if (input.imagePath) return { image: input.imagePath };
  if (input.imageUrl) return { image: input.imageUrl };
  if (input.imageId) return { fileId: input.imageId };
  return null;
}

// ---------------------------------------------------------------------------
// Public API: typed execute() for non-SDK callers
// ---------------------------------------------------------------------------

/**
 * Execute `m3_vision_describe` without the AI SDK wrapper.
 * Returns a `ToolResult` envelope so the route layer can
 * surface structured errors (e.g. mmx-spawn-failed vs
 * quota-exceeded vs validation-error) instead of having to
 * pattern-match on thrown error types.
 */
export async function executeM3VisionDescribe(
  rawInput: unknown,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ToolResult<M3VisionDescribeOutput>> {
  return safeExecute(async () => {
    const parsed = zM3VisionDescribeInput.safeParse(rawInput);
    if (!parsed.success) throw parsed.error;
    const input = parsed.data;
    // The schema's `.refine` guarantees at least one of the
    // three image sources is set, so pickImageSource is
    // guaranteed non-null here.
    const source = pickImageSource(input);
    if (!source) {
      // Defensive — should be unreachable. Throw a clear error
      // so a future schema regression doesn't silently produce
      // an "empty" mmx call.
      throw new Error('m3_vision_describe: schema accepted input with no image source (regression)');
    }

    if (!(await mmxIsAvailable())) {
      throw new ToolNotAvailableError(
        'm3_vision_describe',
        'mmx CLI is not available — install @MiniMax/sdk and run `mmx auth login` (or set MMX_BIN)',
      );
    }

    const t0 = Date.now();
    let result;
    try {
      result = await mmxDescribeImage(
        source,
        { prompt: input.prompt },
        { signal: opts.signal, timeoutMs: opts.timeoutMs },
      );
    } catch (e) {
      // Re-throw with the right tool-error class so the Director
      // loop can decide retry vs skip.
      if (e instanceof MmxQuotaError) {
        throw new ToolNotAvailableError(
          'm3_vision_describe',
          `M3 vision quota exhausted: ${e.message}`,
        );
      }
      if (e instanceof MmxSpawnError) {
        throw new ToolNotAvailableError('m3_vision_describe', e.message);
      }
      if (e instanceof MmxError) {
        throw new Error(`M3 vision failed: ${e.message}`);
      }
      throw e;
    }

    const out: M3VisionDescribeOutput = {
      description: result.description,
      durationMs: Date.now() - t0,
    };
    // Re-parse to strip any extra fields the caller may have
    // accidentally set; cheap and keeps the contract tight.
    return zM3VisionDescribeOutput.parse(out);
  });
}

// ---------------------------------------------------------------------------
// Vercel AI SDK `tool()` definition
// ---------------------------------------------------------------------------

/**
 * The `m3_vision_describe` tool. Lets the Director loop ask
 * M3 to look at a generated image and answer a question about
 * it (consistency check, issue list, alt text, etc.).
 *
 * NOT called on every step — the model decides when vision
 * feedback would help (e.g. after `generate_image` produces
 * an asset the user might want critiqued before persisting).
 */
export const m3VisionDescribeTool = tool({
  description:
    "Ask MiniMax-M3 (vision) to look at a generated image and answer a question. Use this to critique consistency between a draft image and the original concept, to detect visual issues (clipping, NSFW, off-style), or to generate alt text. The mmx CLI must be installed and authenticated (run `mmx auth login`).",
  inputSchema: zM3VisionDescribeInput,
  outputSchema: zM3VisionDescribeOutput,
  execute: async (input, options) => {
    const result = await executeM3VisionDescribe(input, {
      signal: options?.abortSignal,
    });
    if (!result.ok) throw result.error;
    return result.value;
  },
});
