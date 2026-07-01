/**
 * v1.2 Tool Registry — `generate_video` tool.
 *
 * Provider-agnostic video-generation tool. Mirrors the structure
 * of `generate_image` but with a video-flavoured settings schema
 * (duration in seconds, aspect-ratio list that includes the
 * 'auto' option, etc.). As with `generate_image`, the underlying
 * provider CLI/HTTP wrappers land in v1.2.3 — today only the
 * `mock` provider is implemented so the tool is exercisable.
 */
import { tool } from 'ai';
import {
  GenerateVideoInput,
  GenerateVideoOutput,
  zGenerateVideoInput,
  zGenerateVideoOutput,
  VIDEO_SETTINGS_DEFAULTS,
} from './schemas';
import {
  ToolNotAvailableError,
  ToolExecutionError,
  safeExecute,
  type ToolResult,
} from './errors';
import {
  HIGGSFIELD_VIDEO_MODELS,
  getHiggsfieldVideoModel,
  type HiggsfieldVideoModelSlug,
} from '@/lib/higgsfield/models';
import { getProvider } from '@/lib/providers/registry';
import { assertApproved, verifyToken } from '@/lib/approval/gate';
import { loadSpendPreAuth } from '@/lib/approval/preauth';
import {
  ApprovalDeniedError,
  type ApprovalRequest,
  type ApprovalToken,
} from '@/lib/approval/types';
import { currentRunContext } from '@/lib/agent-loop/run-context';

// ---------------------------------------------------------------------------
// Provider dispatcher
// ---------------------------------------------------------------------------

type ProviderKind = 'higgsfield' | 'mock';

/** Shape of a Higgsfield `generate get` job record (subset we read). */
type HiggsfieldJobRecord = { status?: string; result_url?: string; url?: string; error?: string };

function detectProvider(model: string): ProviderKind {
  if (model.startsWith('higgsfield:')) return 'higgsfield';
  if (model === 'mock' || model.startsWith('mock:')) return 'mock';
  if (
    model === 'seedance_2_0' || model === 'seedance1_5'
    || model === 'kling3_0' || model === 'veo3_1' || model === 'veo3_1_lite'
    || model === 'wan2_6' || model === 'minimax_hailuo'
  ) {
    return 'higgsfield';
  }
  // NFR-4: Higgsfield is the sole video engine. Any slug that isn't a
  // Higgsfield catalog slug (or the test-only mock) is unsupported — fail
  // CLEAR here, BEFORE the approval gate / any submit, so a typo'd or
  // hallucinated model name can't trigger a wasted credit spend. (Story 10.2
  // removed the dead minimax/openai dispatch arms — Higgsfield is sole-engine.)
  // Note: `minimax_hailuo` is a Higgsfield catalog slug, matched above.
  throw new ToolNotAvailableError(
    'generate_video',
    `Unsupported model "${model}" — Higgsfield is the sole video engine (NFR-4); use a higgsfield:* or catalog slug (e.g. seedance_2_0), or "mock" in tests.`,
  );
}

async function generateMock(input: GenerateVideoInput): Promise<GenerateVideoOutput> {
  const settings = { ...VIDEO_SETTINGS_DEFAULTS, ...(input.settings ?? {}) };
  const hash = hashString(JSON.stringify({ p: input.prompt, s: settings, d: settings.durationSec }));
  return zGenerateVideoOutput.parse({
    assetRef: {
      provider: 'mock',
      id: `mock-vid-${hash}`,
      url: `https://example.invalid/mock-videos/${hash}.mp4`,
    },
    creditsCharged: 0,
  });
}

/**
 * V1.5: Higgsfield video — wired to the CLI adapter. Most video models
 * (seedance_2_0, veo3_1, …) generate asynchronously: `generate create`
 * returns a job id and the URL lands later. We do a bounded inline poll
 * via the adapter's getJobStatus (`higgsfield generate get <id>`) so the
 * agent gets a finished URL in the common case; if it's still queued
 * after the budget, we surface a retryable error so the agent can poll
 * with job_lookup instead of blocking forever.
 */
async function generateHiggsfield(
  input: GenerateVideoInput,
  signal?: AbortSignal,
): Promise<GenerateVideoOutput> {
  const model = input.model.startsWith('higgsfield:')
    ? input.model.slice('higgsfield:'.length)
    : input.model;
  const settings = { ...VIDEO_SETTINGS_DEFAULTS, ...(input.settings ?? {}) };

  let adapter;
  try {
    adapter = getProvider('higgsfield');
  } catch {
    throw new ToolNotAvailableError(
      'generate_video',
      'higgsfield provider is not registered — check lib/providers/registry.ts',
    );
  }
  if (!(await adapter.isAvailable())) {
    throw new ToolNotAvailableError(
      'generate_video',
      'Higgsfield CLI is not available (the higgsfield/higgs binary is missing or '
        + 'not authenticated). Run `higgsfield auth login`, or paste a CLI token in '
        + 'Settings → Higgsfield.',
    );
  }

  const ref = await adapter.generateVideo({
    prompt: input.prompt,
    model,
    durationSec: settings.durationSec,
    ...(signal ? { signal } : {}),
  });

  // Synchronous completion — return the URL directly.
  if (ref.url) {
    return zGenerateVideoOutput.parse({
      assetRef: { provider: 'higgsfield', id: ref.jobId || ref.path || ref.url, url: ref.url },
    });
  }

  // Async job — bounded poll. getJobStatus lives on the concrete CLI
  // adapter (not the ProviderAdapter interface), accessed via the same
  // cast pattern as cost_estimate / job_lookup.
  const jobId = ref.jobId;
  if (!jobId) {
    throw new ToolExecutionError('generate_video', 'Higgsfield returned neither a URL nor a job id.', {
      retryable: false,
    });
  }
  const adapterAny = adapter as unknown as { getJobStatus?: (id: string) => Promise<unknown> };
  if (typeof adapterAny.getJobStatus !== 'function') {
    throw new ToolExecutionError(
      'generate_video',
      `Higgsfield returned async job ${jobId}; poll it with job_lookup.`,
      { retryable: true },
    );
  }

  const MAX_ATTEMPTS = 12;
  const INTERVAL_MS = 5000;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) {
      throw new ToolExecutionError('generate_video', 'aborted while polling Higgsfield job', {
        retryable: false,
      });
    }
    await new Promise((res) => setTimeout(res, INTERVAL_MS));
    let record: HiggsfieldJobRecord | null = null;
    try {
      record = (await adapterAny.getJobStatus(jobId)) as HiggsfieldJobRecord | null;
    } catch {
      // Transient poll failure — keep trying until the attempt budget runs out.
      continue;
    }
    const status = record?.status;
    const resultUrl = record?.result_url || record?.url;
    if (status === 'completed' && resultUrl) {
      return zGenerateVideoOutput.parse({
        assetRef: { provider: 'higgsfield', id: jobId, url: resultUrl },
      });
    }
    if (status === 'failed') {
      throw new ToolExecutionError(
        'generate_video',
        `Higgsfield job ${jobId} failed${record?.error ? `: ${record.error}` : ''}`,
        { retryable: false },
      );
    }
  }

  // Still queued after the budget — let the agent poll explicitly.
  throw new ToolExecutionError(
    'generate_video',
    `Higgsfield job ${jobId} is still rendering after ${(MAX_ATTEMPTS * INTERVAL_MS) / 1000}s; `
      + 'poll it with job_lookup({ action: "get", jobId }).',
    { retryable: true },
  );
}

function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Settings validation
// ---------------------------------------------------------------------------

/**
 * Per-model duration caps. v1.2.3 will lift these from
 * `lib/higgsfield/models.ts` (the `HiggsfieldModelMeta` struct
 * doesn't currently carry a max duration; we'll add one). For
 * now, hardcode the documented v1.0 limits so a runaway model
 * call doesn't burn an unbounded amount of credit.
 */
const DURATION_CAPS: Record<string, number> = {
  seedance_2_0: 12,
  seedance1_5: 12,
  kling3_0: 10,
  veo3_1: 8,
  veo3_1_lite: 8,
  wan2_6: 15,
  minimax_hailuo: 6,
};

function validateSettingsForModel(input: GenerateVideoInput): void {
  const slug = input.model;
  const meta = getHiggsfieldVideoModel(slug as HiggsfieldVideoModelSlug);
  if (meta) {
    const settings = { ...VIDEO_SETTINGS_DEFAULTS, ...(input.settings ?? {}) };
    if (meta.aspectRatios.length > 0 && !meta.aspectRatios.includes(settings.aspectRatio)) {
      throw new ToolExecutionError(
        'generate_video',
        `aspect ratio "${settings.aspectRatio}" not supported by ${slug}; allowed: ${meta.aspectRatios.join(', ')}`,
        { retryable: false },
      );
    }
    const cap = DURATION_CAPS[slug];
    if (typeof cap === 'number' && settings.durationSec > cap) {
      throw new ToolExecutionError(
        'generate_video',
        `duration ${settings.durationSec}s exceeds the ${slug} cap of ${cap}s`,
        { retryable: false },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function executeGenerateVideo(
  rawInput: unknown,
  opts: { signal?: AbortSignal; providerOverride?: ProviderKind } = {},
): Promise<ToolResult<GenerateVideoOutput>> {
  return safeExecute(async () => {
    const parsed = zGenerateVideoInput.safeParse(rawInput);
    if (!parsed.success) throw parsed.error;
    const input = parsed.data;

    validateSettingsForModel(input);

    // Story 10.1: spend-gate via THE canonical approval chokepoint
    // (lib/approval/gate.ts) — the same gate publish uses, not the retired
    // hil.ts / `/api/ai/confirm` sibling. Video is the most expensive call
    // (~$0.30) — above the default $0.10 spend ceiling, so it fails closed
    // unless the run raised `autoApproveBelowUsd` or an operator approves.
    // Build a canonical `spend` request, obtain approval, then verify the
    // hash-bound token immediately before the credit-spending submit.
    const provider: ProviderKind = opts.providerOverride ?? detectProvider(input.model);
    if (provider !== 'mock') {
      const ctx = currentRunContext();
      if (ctx) {
        const approvalReq: ApprovalRequest = {
          kind: 'spend',
          summary: `Generate video via ${input.model} (~$0.30)`,
          target: `video:${input.model}`,
          estimatedCostUsd: 0.3,
          totalCostSoFarUsd: ctx.totalCostUsd,
          budgetUsd: ctx.budgetUsd,
          payloadPreview: { prompt: input.prompt, model: input.model },
        };
        let token: ApprovalToken;
        try {
          token = await assertApproved(approvalReq, {
            loadPreAuth: loadSpendPreAuth(ctx.autoApproveBelowUsd),
          });
        } catch (e) {
          if (e instanceof ApprovalDeniedError) {
            throw new ToolExecutionError(
              'generate_video',
              `approval ${e.verdict}: ${e.reason}`,
              { retryable: e.verdict === 'timeout' },
            );
          }
          throw e;
        }
        // Story 10.1 (review L-1): assertApproved already fail-closed-guaranteed
        // an `approved` token bound to THIS exact approvalReq, so this verify is
        // structural — it cannot fail against the same object. It is the
        // greppable verify-before-side-effect shape Story 10.7's CI invariant
        // asserts (mirrors lib/publish/dispatch.ts); the load-bearing fail-closed
        // protection is `assertApproved` above, not this line.
        if (!verifyToken(token, approvalReq)) {
          throw new ToolExecutionError(
            'generate_video',
            'approval token does not match the generation request',
            { retryable: false },
          );
        }
      }
    }

    let output: GenerateVideoOutput;
    switch (provider) {
      case 'mock':
        output = await generateMock(input);
        break;
      case 'higgsfield':
        output = await generateHiggsfield(input, opts.signal);
        break;
    }
    return zGenerateVideoOutput.parse(output);
  });
}

export const generateVideoTool = tool({
  description:
    "Generate a video from a prompt (+ optional model + settings). The model defaults to seedance_2_0 (Seedance 2.0) when omitted. Returns an AssetRef; provider is auto-detected from the model slug (use 'mock' for tests). Duration caps vary per model (see execute() for the cap table).",
  inputSchema: zGenerateVideoInput,
  outputSchema: zGenerateVideoOutput,
  execute: async (input, options) => {
    const result = await executeGenerateVideo(input, {
      signal: options?.abortSignal,
    });
    if (!result.ok) throw result.error;
    return result.value;
  },
});

export const __test__ = {
  detectProvider,
  validateSettingsForModel,
  DURATION_CAPS,
  higgsfieldVideoModelCount: HIGGSFIELD_VIDEO_MODELS.length,
};
