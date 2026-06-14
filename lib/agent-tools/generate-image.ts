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
import { getProvider } from '@/lib/providers/registry';
import { requireApproval } from '@/lib/agent-loop/hil';
import { currentRunContext, bumpStepCounter } from '@/lib/agent-loop/run-context';

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
 *   - `leonardo:*`    → forward to the Leonardo API.
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
type ProviderKind = 'higgsfield' | 'minimax' | 'leonardo' | 'openai' | 'mock';

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
  if (model.startsWith('minimax:') || model.includes('minimax-image')) return 'minimax';
  if (model.startsWith('leonardo:') || model.includes('leonardo')) return 'leonardo';
  if (model.startsWith('openai:') || model.startsWith('gpt-image')) return 'openai';
  // Unknown slug — let the caller decide whether to fall through.
  // Default to 'openai' so a typo'd model name doesn't silently
  // pick the wrong provider; the real provider will reject it.
  return 'openai';
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
 * V1.5: Higgsfield provider path — wired to the CLI adapter
 * (lib/providers/higgsfield/cli-adapter.ts) via the registry. Images
 * generate synchronously on Higgsfield, so a successful call returns
 * an AssetRef with a URL. The agent loop can now actually generate
 * images through Higgsfield's CLI (this was a `throw` stub before).
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

  let adapter;
  try {
    adapter = getProvider('higgsfield');
  } catch {
    throw new ToolNotAvailableError(
      'generate_image',
      'higgsfield provider is not registered — check lib/providers/registry.ts',
    );
  }
  if (!(await adapter.isAvailable())) {
    throw new ToolNotAvailableError(
      'generate_image',
      'Higgsfield CLI is not available (the higgsfield/higgs binary is missing or '
        + 'not authenticated). Run `higgsfield auth login`, or paste a CLI token in '
        + 'Settings → Higgsfield.',
    );
  }

  const ref = await adapter.generateImage({
    prompt: input.prompt,
    model,
    aspectRatio: settings.aspectRatio,
    ...(signal ? { signal } : {}),
  });

  // Images are synchronous — a successful call carries a URL. If we got
  // an async job instead (no url), surface a retryable error so the
  // agent polls via job_lookup rather than fabricating a URL to satisfy
  // the schema.
  const url = ref.url;
  if (!url) {
    throw new ToolExecutionError(
      'generate_image',
      ref.jobId
        ? `Higgsfield returned an async job (${ref.jobId}) instead of an image URL; poll it with job_lookup.`
        : 'Higgsfield returned no image URL.',
      { retryable: Boolean(ref.jobId) },
    );
  }

  return zGenerateImageOutput.parse({
    assetRef: {
      provider: 'higgsfield',
      id: ref.jobId || ref.path || url,
      url,
    },
  });
}

async function generateMinimax(_input: GenerateImageInput): Promise<GenerateImageOutput> {
  throw new ToolNotAvailableError('generate_image', 'MiniMax image provider lands in v1.2.3.');
}

async function generateLeonardo(_input: GenerateImageInput): Promise<GenerateImageOutput> {
  throw new ToolNotAvailableError('generate_image', 'Leonardo provider lands in v1.2.3.');
}

async function generateOpenai(_input: GenerateImageInput): Promise<GenerateImageOutput> {
  throw new ToolNotAvailableError('generate_image', 'OpenAI image provider lands in v1.2.3.');
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

    // v1.2.3 HIL guard: pause before any non-mock image generation
    // and ask /api/ai/confirm for approval. The endpoint
    // auto-approves small costs and the mock provider; the test
    // environment bypasses the HTTP call entirely. This is the
    // credit-burn safety net.
    const provider: ProviderKind = opts.providerOverride ?? detectProvider(input.model);
    if (provider !== 'mock') {
      const ctx = currentRunContext();
      if (ctx) {
        const stepId = `${ctx.runId}::image::${bumpStepCounter()}`;
        await requireApproval({
          runId: ctx.runId,
          stepId,
          toolName: 'generate_image',
          estimatedCostUsd: 0.04,
          totalCostSoFarUsd: ctx.totalCostUsd,
          budgetUsd: ctx.budgetUsd,
          prompt: input.prompt,
          model: input.model,
          settings: input.settings as Record<string, unknown> | undefined,
          ...(ctx.autoApproveBelowUsd !== undefined
            ? { autoApproveBelowUsd: ctx.autoApproveBelowUsd }
            : {}),
        });
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
      case 'minimax':
        output = await generateMinimax(input);
        break;
      case 'leonardo':
        output = await generateLeonardo(input);
        break;
      case 'openai':
        output = await generateOpenai(input);
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
    "Generate an image from a model+prompt+settings triple. Returns an AssetRef that downstream tools (persist_asset) can save to the user's library. Provider is auto-detected from the model slug (higgsfield:*, minimax:*, leonardo:*, openai:*); use 'mock' for tests.",
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
