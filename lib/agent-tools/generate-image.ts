/**
 * v1.2 Tool Registry — `generate_image` tool.
 *
 * Provider-agnostic image-generation tool. The tool's `execute()`
 * routes to the underlying provider (Higgsfield, MiniMax image-01,
 * Leonardo, OpenAI gpt-image-2) based on the model slug. The
 * provider-specific CLI/HTTP wrappers land in v1.2.3 (per
 * ROADMAP §"CLI Provider Wrappers"). This file is the *contract*
 * the Director loop calls against; the execute() body is wired
 * to a thin dispatcher that the v1.2.3 PR will flesh out.
 *
 * Today's `execute()` implements a `mock` provider path so the
 * tool is fully exercisable end-to-end (the unit tests assert
 * on it) and the route layer can be wired against the same shape
 * it will see in production. The mock provider returns a fake
 * `AssetRef` (provider: 'mock', url: `https://example.invalid/...`)
 * that the test suite recognises; the route layer is expected
 * to never call generate_image with a mock slug in production
 * (the model catalog in `lib/higgsfield/models.ts` doesn't ship
 * a 'mock' slug — it's only a tool-registry-internal option for
 * tests / dev).
 */
import { tool } from 'ai';
import {
  GenerateImageInput,
  GenerateImageOutput,
  zGenerateImageInput,
  zGenerateImageOutput,
  zAssetRef,
  IMAGE_SETTINGS_DEFAULTS,
} from './schemas';
import {
  ToolNotAvailableError,
  ToolExecutionError,
  safeExecute,
  type ToolResult,
} from './errors';
import {
  HIGGSFIELD_IMAGE_MODELS,
  getHiggsfieldImageModel,
  type HiggsfieldImageModelSlug,
} from '@/lib/higgsfield/models';
import { assertApproved, verifyToken } from '@/lib/approval/gate';
import { loadSpendPreAuth } from '@/lib/approval/preauth';
import {
  ApprovalDeniedError,
  type ApprovalRequest,
  type ApprovalToken,
} from '@/lib/approval/types';
import { currentRunContext } from '@/lib/agent-loop/run-context';
// AGENTIC-CORE: image generation routes through Higgsfield (character-anchored
// via the canon Element `<<<id>>>`). The shared, tested core lives here so the
// tool and the `/api/higgsfield/image/*` routes share the exact behavior.
// Leonardo is being removed — generation never routes to it.
import {
  submitHiggsfieldGeneration,
  pollHiggsfieldJob,
  UnresolvedElementError,
} from '@/lib/higgsfield/generate';

// ---------------------------------------------------------------------------
// Provider dispatcher
// ---------------------------------------------------------------------------

/**
 * `execute` returns an `AssetRef` for the given model + prompt. The
 * provider is selected by the model-slug prefix:
 *
 *   - `higgsfield:*`  → forward to the Higgsfield CLI (v1.2.3) /
 *                        MCP tool (v1.0.4 fallback). Stubbed here.
 *   - `minimax:*`     → forward to MiniMax image-01 endpoint.
 *   - `openai:*`      → forward to the OpenAI Images API.
 *   - `mock:*` / `mock` → in-process mock provider (tests only).
 *
 * Each branch is isolated in a private async function so the
 * dispatch logic stays readable. The mock branch is implemented
 * here; the others are stubs that throw ToolNotAvailableError
 * until v1.2.3 lands. That's intentional — a missing provider
 * should NOT be a runtime crash, it should be a typed error the
 * Director loop can fall back from.
 */
type ProviderKind = 'higgsfield' | 'mock';

function detectProvider(model: string): ProviderKind {
  if (model.startsWith('higgsfield:')) return 'higgsfield';
  if (model === 'mock' || model.startsWith('mock:')) return 'mock';
  if (
    model === 'nano_banana_2' || model === 'nano_banana_flash'
    || model === 'flux_2' || model === 'gpt_image_2'
    || model === 'seedream_v4_5' || model === 'text2image_soul_v2'
    || model === 'image_auto'
  ) {
    // Bare Higgsfield slugs (no prefix) — the existing catalog uses
    // them as the primary surface, so treat them as Higgsfield.
    return 'higgsfield';
  }
  // NFR-4: Higgsfield is the sole image engine. Any slug that isn't a
  // Higgsfield catalog slug (or the test-only mock) is unsupported — fail
  // CLEAR here, BEFORE the approval gate / any submit, so a typo'd or
  // hallucinated model name can't trigger a wasted credit spend. (Story 10.2
  // removed the dead minimax/openai dispatch arms — Higgsfield is sole-engine.)
  throw new ToolNotAvailableError(
    'generate_image',
    `Unsupported model "${model}" — Higgsfield is the sole image engine (NFR-4); use a higgsfield:* or catalog slug (e.g. nano_banana_2), or "mock" in tests.`,
  );
}

/**
 * Mock provider — returns a deterministic fake AssetRef. Test
 * code asserts on the shape; the route layer never calls this
 * path in production because 'mock' isn't in any model catalog.
 */
async function generateMock(
  input: GenerateImageInput,
): Promise<GenerateImageOutput> {
  // Deterministic id derived from the prompt + settings, so tests
  // can assert on it without flakiness.
  const settings = { ...IMAGE_SETTINGS_DEFAULTS, ...(input.settings ?? {}) };
  const hash = hashString(JSON.stringify({ p: input.prompt, s: settings }));
  return zGenerateImageOutput.parse({
    assetRef: {
      provider: 'mock',
      id: `mock-${hash}`,
      url: `https://example.invalid/mock-images/${hash}.png`,
    },
    creditsCharged: 0,
  });
}

/**
 * AGENTIC-CORE: Higgsfield provider path — wired to the shared
 * `lib/higgsfield/generate.ts` core (the same code the
 * `/api/higgsfield/image/*` routes use). Image generation is
 * character-anchored: the canon Element `<<<id>>>` for the active
 * character (from the RunContext, default 'kael') is prepended so
 * Higgsfield edits from the LOCKED reference.
 *
 * Flow: read the operator's Higgsfield connector from the RunContext →
 * `submitHiggsfieldGeneration({ enhance:false })` (the agent loop already
 * critiqued + finalized the prompt — we anchor it but DON'T re-enhance) →
 * poll `job_display` to completion → return the produced `rawUrl` as the
 * tool's AssetRef.
 *
 * No connector in context → a clear `ToolNotAvailableError` ("No Higgsfield
 * connector configured — add one in Customize"). The chat CLIENT must include
 * the operator's enabled+trusted Higgsfield connector in the `/api/ai/prompt`
 * body (the MCP registry is client-side); the loop threads it into the
 * RunContext. The `getProvider('higgsfield')` throw path is gone — Leonardo /
 * the CLI adapter are no longer on the agent's image-generation path.
 */
async function generateHiggsfield(
  input: GenerateImageInput,
  signal?: AbortSignal,
): Promise<GenerateImageOutput> {
  // The catalog uses bare slugs ("nano_banana_2"); strip the optional
  // "higgsfield:" namespace the tool schema may carry.
  const model = input.model.startsWith('higgsfield:')
    ? input.model.slice('higgsfield:'.length)
    : input.model;
  const settings = { ...IMAGE_SETTINGS_DEFAULTS, ...(input.settings ?? {}) };

  const ctx = currentRunContext();
  const connector = ctx?.higgsfieldConnector;
  if (!connector) {
    throw new ToolNotAvailableError(
      'generate_image',
      'No Higgsfield connector configured — add one in Customize (the chat client '
        + 'must include the operator\'s enabled+trusted Higgsfield connector in the '
        + 'request).',
    );
  }

  // Submit a canon-anchored generation. `enhance:false` — the prompt the agent
  // passes here is already the critiqued/finalized Director draft; the shared
  // lib only prepends the character's `<<<element>>>` canon anchor and submits.
  let submitted;
  try {
    submitted = await submitHiggsfieldGeneration({
      connector,
      model,
      prompt: input.prompt,
      aspectRatio: settings.aspectRatio,
      enhance: false,
      // The active canon character drives the anchor (default 'kael').
      ...(ctx?.characterId ? { characterId: ctx.characterId } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (e: unknown) {
    // Story 2.8: an unresolved-Element refusal is a NON-retryable, actionable
    // error — the agent must resolve the character's Element first. No credit
    // was spent (the refusal happens before the Higgsfield submit).
    if (e instanceof UnresolvedElementError) {
      throw new ToolExecutionError('generate_image', e.message, { retryable: false, cause: e });
    }
    throw new ToolExecutionError(
      'generate_image',
      `Higgsfield submit failed: ${e instanceof Error ? e.message : String(e)}`,
      { retryable: true, cause: e },
    );
  }

  // Poll job_display to completion. Bounded so a stuck job can't hang the loop;
  // an abort (caller cancel) ends the wait early. On exhaustion we surface a
  // retryable error carrying the jobId so the agent can poll via job_lookup.
  const url = await pollToCompletion({
    connector,
    jobId: submitted.jobId,
    ...(signal ? { signal } : {}),
  });
  if (!url) {
    throw new ToolExecutionError(
      'generate_image',
      `Higgsfield job ${submitted.jobId} did not complete in time; poll it with job_lookup.`,
      { retryable: true },
    );
  }

  return zGenerateImageOutput.parse({
    assetRef: {
      provider: 'higgsfield',
      id: submitted.jobId,
      url,
    },
  });
}

/**
 * Poll `job_display` until the job is `completed` (returns the full-res
 * `rawUrl`), the deadline elapses (returns undefined → the caller surfaces a
 * retryable error), or the signal aborts. Intervals/timeout are conservative —
 * Higgsfield image jobs typically complete in well under a minute.
 */
async function pollToCompletion(args: {
  connector: NonNullable<ReturnType<typeof currentRunContext>>['higgsfieldConnector'];
  jobId: string;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const connector = args.connector;
  if (!connector) return undefined;
  const POLL_INTERVAL_MS = 2_000;
  const MAX_WAIT_MS = 120_000;
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    if (args.signal?.aborted) return undefined;
    const { status, images } = await pollHiggsfieldJob({ connector, jobId: args.jobId });
    if (status === 'completed' && images.length > 0) {
      // images[0] is the full-res rawUrl (parseJobDisplay pushes rawUrl first).
      return images[0];
    }
    // Terminal failure states from the backend — stop waiting.
    if (status === 'failed' || status === 'error' || status === 'canceled') {
      return undefined;
    }
    await sleep(POLL_INTERVAL_MS, args.signal);
  }
  return undefined;
}

/** Resolve after `ms`, or early when `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Stable, fast non-crypto hash for the mock provider's deterministic
 * id. djb2 — good enough for in-test reproducibility, not for
 * security. The `AssetRef.id` only needs to be unique within a
 * single run, not globally.
 */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  // Force unsigned 32-bit.
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Settings validation (per-provider aspect ratio whitelist)
// ---------------------------------------------------------------------------

/**
 * Validate the requested aspect ratio against the model's allowed
 * list. We don't fail the tool on a mismatch — we log a typed
 * error and let the caller decide whether to fall back. That's
 * the same policy `lib/higgsfield/models.ts` exposes.
 *
 * Applies to any Higgsfield model that lives in the catalog
 * (including `nano_banana_*`, `flux_2`, `gpt_image_2`, `image_auto`,
 * etc.). Models not in the catalog are still dispatched (and will
 * fail at the provider call with ToolNotAvailableError until
 * v1.2.3 lands).
 */
function validateSettingsForModel(
  input: GenerateImageInput,
): void {
  const slug = input.model;
  // Try to look up the model in the Higgsfield catalog. The slug
  // may be a bare catalog id ("nano_banana_2") or a namespaced form
  // ("higgsfield:nano_banana_2"); the catalog uses the bare form.
  const catalogSlug = slug.startsWith('higgsfield:') ? slug.slice('higgsfield:'.length) : slug;
  const meta = getHiggsfieldImageModel(catalogSlug as HiggsfieldImageModelSlug);
  if (meta) {
    if (meta.aspectRatios.length > 0) {
      const settings = { ...IMAGE_SETTINGS_DEFAULTS, ...(input.settings ?? {}) };
      if (!meta.aspectRatios.includes(settings.aspectRatio)) {
        throw new ToolExecutionError(
          'generate_image',
          `aspect ratio "${settings.aspectRatio}" not supported by ${slug}; allowed: ${meta.aspectRatios.join(', ')}`,
          { retryable: false },
        );
      }
    }
    return;
  }
  // Non-Higgsfield models (openai, minimax, leonardo) are not in
  // this catalog — their settings validation lives in the
  // v1.2.3 provider dispatcher. For now we accept any
  // schema-valid settings and let the provider stub raise
  // ToolNotAvailableError if the underlying model can't service it.
}

// ---------------------------------------------------------------------------
// Public API: typed execute() for non-SDK callers
// ---------------------------------------------------------------------------

export async function executeGenerateImage(
  rawInput: unknown,
  opts: { signal?: AbortSignal; providerOverride?: ProviderKind } = {},
): Promise<ToolResult<GenerateImageOutput>> {
  return safeExecute(async () => {
    const parsed = zGenerateImageInput.safeParse(rawInput);
    if (!parsed.success) throw parsed.error;
    const input = parsed.data;

    validateSettingsForModel(input);

    // Story 10.1: spend-gate via THE canonical approval chokepoint
    // (lib/approval/gate.ts) — the same gate publish uses, not the retired
    // hil.ts / `/api/ai/confirm` sibling. Build a canonical `spend` request,
    // obtain approval (the default spend pre-auth rule auto-approves small cost
    // within the budget cap; anything above fails closed), then verify the
    // hash-bound token immediately before the credit-spending submit — exactly
    // as lib/publish/dispatch.ts verifies before posting. This is the
    // credit-burn safety net, now a single fail-closed chokepoint.
    const provider: ProviderKind = opts.providerOverride ?? detectProvider(input.model);
    if (provider !== 'mock') {
      const ctx = currentRunContext();
      if (ctx) {
        const approvalReq: ApprovalRequest = {
          kind: 'spend',
          summary: `Generate image via ${input.model} (~$0.04)`,
          target: `image:${input.model}`,
          estimatedCostUsd: 0.04,
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
              'generate_image',
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
            'generate_image',
            'approval token does not match the generation request',
            { retryable: false },
          );
        }
      }
    }
    let output: GenerateImageOutput;
    switch (provider) {
      case 'mock':
        output = await generateMock(input);
        break;
      case 'higgsfield':
        output = await generateHiggsfield(input, opts.signal);
        break;
    }
    // Re-validate the final shape so a buggy provider branch
    // can't slip a malformed AssetRef past the tool boundary.
    return zGenerateImageOutput.parse(output);
  });
}

// ---------------------------------------------------------------------------
// Vercel AI SDK `tool()` definition
// ---------------------------------------------------------------------------

export const generateImageTool = tool({
  description:
    "Generate an image from a model+prompt+settings triple. Returns an AssetRef that downstream tools (persist_asset) can save to the user's library. Provider is auto-detected from the model slug (higgsfield:*, minimax:*, openai:*); use 'mock' for tests.",
  inputSchema: zGenerateImageInput,
  outputSchema: zGenerateImageOutput,
  execute: async (input, options) => {
    const result = await executeGenerateImage(input, {
      signal: options?.abortSignal,
    });
    if (!result.ok) throw result.error;
    return result.value;
  },
});

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __test__ = {
  detectProvider,
  hashString,
  validateSettingsForModel,
  // Expose the model catalog so tests can assert against the
  // current curated list without re-importing from lib/higgsfield.
  higgsfieldImageModelCount: HIGGSFIELD_IMAGE_MODELS.length,
};

// Suppress unused-import lint when Zod is only referenced via types.
void zAssetRef;
