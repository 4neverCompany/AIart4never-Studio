/**
 * v1.2 Tool Registry — barrel export + `AGENT_TOOLS` array.
 *
 * The single import surface for the Director loop in
 * `app/api/ai/prompt/route.ts` (v1.2.2). Drop this array into a
 * Vercel AI SDK `generateText({ tools: AGENT_TOOLS, ... })` call
 * and the SDK wires every tool's Zod schema into the model prompt
 * for tool-call shape AND validates the model's output before
 * invoking `execute()`.
 *
 * Usage example (5 lines, Vercel AI SDK 6.x):
 *
 *   import { generateText, stepCountIs } from 'ai';
 *   import { AGENT_TOOLS } from '@/lib/agent-tools';
 *
 *   const { text } = await generateText({
 *     model: minimaxM3,
 *     tools: AGENT_TOOLS,
 *     stopWhen: stepCountIs(8),
 *     prompt: 'Plan → search → draft → critique → finalize',
 *   });
 */
import type { Tool } from 'ai';

import { trendingSearchTool, executeTrendingSearch } from './trending-search';
import { generatePromptTool, executeGeneratePrompt } from './generate-prompt';
import { critiquePromptTool, executeCritiquePrompt, heuristicJudge } from './critique-prompt';
import { generateImageTool, executeGenerateImage } from './generate-image';
import { generateVideoTool, executeGenerateVideo } from './generate-video';
import { persistAssetTool, executePersistAsset, toGeneratedImage, upsertImage, makeAssetId } from './persist-asset';
// V1.2.6: M3 vision tool — exposes MiniMax-M3's text+vision INPUT
// capability to the Director loop. Wired below in the AGENT_TOOLS
// array; the model decides when to call it after a generate_image
// (e.g. for a consistency check before persist_asset).
import { m3VisionDescribeTool, executeM3VisionDescribe } from './m3-vision-describe';
// V1.3: virality tool — wraps the brain_activity text model for
// approval-queue scoring. Same fire-and-forget pattern as
// m3-vision-describe (called automatically by the pipeline, not
// by the agent loop directly).
import { viralityPredictTool, executeViralityPredict } from './virality-predict';
// V1.3: cost estimate — predicts credit cost BEFORE generation so
// the user / Director loop can decide whether to proceed. Same
// routing pattern as virality_predict.
import { costEstimateTool, executeCostEstimate } from './cost-estimate';
// V1.3.0 T1.4
import { reframeImageTool, executeReframeImage } from './reframe-image';
// V1.3.0 T1.5
import { jobLookupTool, executeJobLookup } from './job-lookup';

// ---------------------------------------------------------------------------
// Schemas (re-export so consumers can re-use them in tests / route validation)
// ---------------------------------------------------------------------------

// Zod-schema VALUES (use as `zXxx.parse(...)` or `zXxx.shape` at runtime).
// Keep the `z` prefix on these so call sites are unambiguous about
// whether they're calling a parser or referencing a type.
export {
  zTrendingSearchInput,
  zTrendingSearchOutput,
  zGeneratePromptInput,
  zGeneratePromptOutput,
  zCritiquePromptInput,
  zCritiquePromptOutput,
  zImageSettings,
  zGenerateImageInput,
  zGenerateImageOutput,
  zVideoSettings,
  zGenerateVideoInput,
  zGenerateVideoOutput,
  zAssetMetadata,
  zAssetRef,
  zPersistAssetInput,
  zPersistAssetOutput,
  zM3VisionDescribeInput,
  zM3VisionDescribeOutput,
  zNicheString,
  zGenreString,
  zAngleString,
  zSkillNameString,
  zSkillRef,
  zCritiqueRequirements,
  zTrendResult,
  IMAGE_SETTINGS_DEFAULTS,
  VIDEO_SETTINGS_DEFAULTS,
} from './schemas';
// V1.3: virality prediction schemas (defined in virality-predict.ts)
export {
  zViralityPredictInput,
  zViralityPredictOutput,
} from './virality-predict';

// Inferred TYPES (use in function signatures, return types, etc.).
// The `type` keyword on the export tells `isolatedModules` that this
// is a type-only re-export so the build doesn't try to emit a runtime
// value for it.
export type {
  AssetRef,
  AssetMetadata,
  TrendResult,
  SkillRef,
  CritiqueRequirements,
  NicheString,
  GenreString,
  AngleString,
  SkillNameString,
  ImageSettings,
  VideoSettings,
  TrendingSearchInput,
  TrendingSearchOutput,
  GeneratePromptInput,
  GeneratePromptOutput,
  CritiquePromptInput,
  CritiquePromptOutput,
  GenerateImageInput,
  GenerateImageOutput,
  GenerateVideoInput,
  GenerateVideoOutput,
  PersistAssetInput,
  PersistAssetOutput,
  M3VisionDescribeInput,
  M3VisionDescribeOutput,
} from './schemas';
// V1.3: virality prediction types (defined in virality-predict.ts)
export type { ViralityPredictInput, ViralityPredictOutput } from './virality-predict';

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export {
  AgentToolError,
  ValidationError,
  ToolNotAvailableError,
  ToolTimeoutError,
  ToolExecutionError,
  AssetPersistError,
  safeExecute,
  isAgentToolError,
  isRetryableError,
  ok,
  err,
} from './errors';
export type { ToolResult } from './errors';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export {
  trendingSearchTool,
  executeTrendingSearch,
  generatePromptTool,
  executeGeneratePrompt,
  critiquePromptTool,
  executeCritiquePrompt,
  generateImageTool,
  executeGenerateImage,
  generateVideoTool,
  executeGenerateVideo,
  persistAssetTool,
  executePersistAsset,
  // V1.2.6
  m3VisionDescribeTool,
  executeM3VisionDescribe,
  // V1.3
  viralityPredictTool,
  executeViralityPredict,
  // V1.3.0 — T1.3
  costEstimateTool,
  executeCostEstimate,
  // V1.3.0 — T1.4
  reframeImageTool,
  executeReframeImage,
  // V1.3.0 — T1.5
  jobLookupTool,
  executeJobLookup,
};

// Pure helpers re-exported for unit tests + non-SDK callers.
export { heuristicJudge, toGeneratedImage, upsertImage, makeAssetId };

// ---------------------------------------------------------------------------
// AGENT_TOOLS — the array form for the Vercel AI SDK agent loop
// ---------------------------------------------------------------------------

/**
 * The full agent-toolkit, in the order the Director loop calls
 * them. The Vercel AI SDK accepts either an object map
 * (`{ trending_search: tool, ... }`) or an array
 * (`AGENT_TOOLS`); the array form keeps the call-site a single
 * line and makes tool-additions a one-file diff.
 *
 * The `as Tool[]` cast is the SDK's accepted form for the array
 * input — every entry satisfies the `Tool<INPUT, OUTPUT>`
 * generic the SDK expects, and TypeScript can't infer the union
 * of six different input/output shapes without a nudge.
 */
export const AGENT_TOOLS = [
  trendingSearchTool,
  generatePromptTool,
  critiquePromptTool,
  generateImageTool,
  generateVideoTool,
  persistAssetTool,
  // V1.2.6: M3 vision — added at the end so the Director loop
  // still favours the existing 6-step plan→draft→critique→
  // image/video→persist flow. The model opts in to vision
  // feedback by calling m3_vision_describe explicitly.
  m3VisionDescribeTool,
  // V1.3: virality — scores a post when it enters the approval
  // queue. The Director loop calls this automatically on
  // pending_approval transition; the model can also call it
  // explicitly to re-score.
  viralityPredictTool,
  // V1.3: cost estimate — predicts credit cost BEFORE the user
  // commits to a generation. Surfaces "Cost: 60 credits" hints
  // in the model picker. Always informational, never a gate.
  costEstimateTool,
  reframeImageTool,
  jobLookupTool,
] as unknown as Tool[];

// ---------------------------------------------------------------------------
// Self-check helpers (used by the unit test for the barrel itself)
// ---------------------------------------------------------------------------

/**
 * Iterate the AGENT_TOOLS array and return a list of each tool's
 * name + description. The test asserts the list is non-empty,
 * every entry has a non-empty `description`, and that every entry
 * has either an `inputSchema` or `inputSchema`-shaped property.
 *
 * Intentionally kept off the AI SDK's public types — we read
 * straight off the object so the assertion isn't blocked by
 * TypeScript's tool-generic machinery.
 */
export function describeAgentTools(): Array<{ name: string; description: string; hasInputSchema: boolean; hasOutputSchema: boolean }> {
  return AGENT_TOOLS.map((t) => {
    const obj = t as unknown as Record<string, unknown>;
    const desc = typeof obj.description === 'string' ? obj.description : '';
    const hasInput = obj.inputSchema != null;
    const hasOutput = obj.outputSchema != null;
    // The tool name is implicit in the AGENT_TOOLS key the route
    // uses; we surface it as the variable name via a sentinel
    // attached to the tool at construction time. For now, the
    // test just checks the list length — exact-name mapping is
    // enforced by the route's own type-check.
    const name = (() => {
      if (t === trendingSearchTool) return 'trending_search';
      if (t === generatePromptTool) return 'generate_prompt';
      if (t === critiquePromptTool) return 'critique_prompt';
      if (t === generateImageTool) return 'generate_image';
      if (t === generateVideoTool) return 'generate_video';
      if (t === persistAssetTool) return 'persist_asset';
      if (t === m3VisionDescribeTool) return 'm3_vision_describe';
      if (t === viralityPredictTool) return 'virality_predict';
      if (t === costEstimateTool) return 'cost_estimate';
      if (t === reframeImageTool) return 'reframe_image';
      if (t === jobLookupTool) return 'job_lookup';
      return 'unknown';
    })();
    return { name, description: desc, hasInputSchema: hasInput, hasOutputSchema: hasOutput };
  });
}
