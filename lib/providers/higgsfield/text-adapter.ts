/**
 * Higgsfield text-generation adapter — ProviderAdapter implementation
 * wrapping the `brain_activity` model via the locally-installed
 * `@higgsfield/cli` binary.
 *
 * Cost: ~1 credit per call (documented per ADR-007).
 *
 * Why brain_activity (DECISIONS.md ADR-007):
 *   The approval queue is the single highest-leverage intervention
 *   point in the v1.3 studio flow. A visible virality score (12 vs 78)
 *   changes approve/reject behaviour. The brain_activity model is
 *   the only Higgsfield text model purpose-built for this signal;
 *   calling it synchronously on post-creation is the simplest path
 *   that satisfies the <100ms UX constraint.
 *
 * CLI surface (per @higgsfield/cli v0.1.40 MODELS.md):
 *   higgsfield generate create brain_activity --prompt <text> --json
 *       Returns: {"text": "<model output>", "request_id": "...", ...}
 *
 *   The model output is a JSON blob: {"score": 78, "confidence": 0.85,
 *   "reasoning": "..."}. The adapter validates this shape with Zod
 *   before returning.
 *
 * Auth: same credentials.json pattern as cli-adapter.ts (v1.2.6 fix).
 * The CLI reads HIGGSFIELD_CREDENTIALS_PATH; when options.cliToken is
 * set we write a temp credentials.json and point the env var at it.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  ProviderParseError,
  ProviderRejectedError,
  ProviderUnavailableError,
  type ProviderAdapter,
} from '../interface';
import {
  binaryExists,
  cliInvoke,
  isBinaryAvailable,
  type CliInvokeOptions,
} from '../cli-utils';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/** Score shape returned by brain_activity. */
export const ViralityScoreSchema = z.object({
  score: z.number().int().min(0).max(100),
  confidence: z.number().min(0).max(1).optional(),
  reasoning: z.string().optional(),
});
export type ViralityScore = z.infer<typeof ViralityScoreSchema>;

/** Raw CLI response envelope — the model output is in the `text` field. */
const HiggsfieldTextResponse = z.object({
  text: z.string(),
  request_id: z.string().optional(),
  duration: z.number().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/** Common error payload shape (shared with cli-adapter.ts). */
const HiggsfieldErrorPayload = z.object({
  error: z.object({
    code: z.union([z.string(), z.number()]).optional(),
    message: z.string(),
    hint: z.string().optional(),
  }),
});

/** Response shape for `higgsfield generate cost brain_activity --json` */
const HiggsfieldTextCostResponse = z.object({
  credits: z.number(),
  credits_exact: z.number().optional(),
});

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const DEFAULT_BINARIES = ['higgsfield', 'higgs'] as const;
const BRAIN_ACTIVITY_MODEL = 'brain_activity';

/**
 * Virality-score result shape returned by the tool layer.
 * The adapter returns this; the tool layer wraps it.
 */
export interface GenerateTextResult {
  score: number;
  confidence?: number;
  reasoning?: string;
}

export class HiggsfieldTextAdapter implements ProviderAdapter {
  readonly name = 'higgsfield-text';
  readonly label = 'Higgsfield (text, brain_activity)';

  private resolvedBinary: string | null = null;
  private resolveAttempted = false;

  /** Temp credentials path — same pattern as cli-adapter.ts v1.2.6. */
  private tempCredentialsPath: string | null = null;

  constructor(private readonly options: { cliToken?: string } = {}) {}

  async isAvailable(): Promise<boolean> {
    if (this.resolvedBinary) return true;
    if (this.resolveAttempted && !this.resolvedBinary) return false;

    if (process.env.HIGGSFIELD_BIN && binaryExists(process.env.HIGGSFIELD_BIN)) {
      this.resolvedBinary = process.env.HIGGSFIELD_BIN;
      this.resolveAttempted = true;
      return true;
    }

    for (const name of DEFAULT_BINARIES) {
      if (await isBinaryAvailable(name)) {
        this.resolvedBinary = name;
        this.resolveAttempted = true;
        return true;
      }
    }
    this.resolveAttempted = true;
    return false;
  }

  /**
   * Generate a virality score by calling `higgsfield generate create
   * brain_activity --prompt <text> --json`.
   *
   * The prompt is typically the post's caption + hashtags, as the model
   * scores engagement potential from the written content.
   */
  async generateText(prompt: string): Promise<GenerateTextResult> {
    if (!prompt || !prompt.trim()) {
      throw new ProviderParseError(this.name, 'generateText requires a non-empty prompt');
    }
    const bin = await this.requireBinary();

    const args = [
      'generate', 'create',
      BRAIN_ACTIVITY_MODEL,
      '--json',
    ];
    args.push('--prompt', prompt);

    const invokeOpts: CliInvokeOptions<unknown> = {
      provider: this.name,
      binary: bin,
      args,
      env: await this.maybeBuildAuthEnv(),
    };

    const result = await this.runWithErrorMapping(invokeOpts, HiggsfieldTextResponse);
    return parseBrainActivityOutput(result.text, this.name);
  }

  /**
   * V1.3: real-time credit cost estimate for the brain_activity
   * text model. Same `higgsfield generate cost` surface as the
   * CLI adapter; only the model slug is text-specific.
   */
  async estimateCost(
    prompt?: string,
  ): Promise<{ credits: number; credits_exact?: number; currency: 'credit'; raw: unknown }> {
    const bin = await this.requireBinary();

    const args = [
      'generate', 'cost',
      BRAIN_ACTIVITY_MODEL,
      '--json',
    ];
    args.push('--prompt', prompt ?? 'estimate');

    const invokeOpts: CliInvokeOptions<unknown> = {
      provider: this.name,
      binary: bin,
      args,
      env: await this.maybeBuildAuthEnv(),
    };

    const result = await this.runWithErrorMapping(invokeOpts, HiggsfieldTextCostResponse);
    return {
      credits: result.credits,
      credits_exact: result.credits_exact,
      currency: 'credit',
      raw: result,
    };
  }

  // -------------------------------------------------------------------------
  // Unimplemented ProviderAdapter methods (text-only adapter)
  // -------------------------------------------------------------------------

   
  async generateImage(_opts: unknown): Promise<never> {
    const { UnsupportedOperationError } = await import('../interface');
    throw new UnsupportedOperationError(this.name, 'image');
  }

   
  async generateVideo(_opts: unknown): Promise<never> {
    const { UnsupportedOperationError } = await import('../interface');
    throw new UnsupportedOperationError(this.name, 'video');
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async maybeBuildAuthEnv(): Promise<Record<string, string> | undefined> {
    if (!this.options.cliToken) return undefined;
    if (this.tempCredentialsPath) {
      return { HIGGSFIELD_CREDENTIALS_PATH: this.tempCredentialsPath };
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfield-cred-'));
    const credPath = path.join(dir, 'credentials.json');
    await fs.writeFile(
      credPath,
      JSON.stringify({ access_token: this.options.cliToken }, null, 2),
      { mode: 0o600 },
    );
    this.tempCredentialsPath = credPath;
    process.on('exit', () => {
      try {
        require('node:fs').rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });
    return { HIGGSFIELD_CREDENTIALS_PATH: credPath };
  }

  private async requireBinary(): Promise<string> {
    if (this.resolvedBinary) return this.resolvedBinary;
    const ok = await this.isAvailable();
    if (!ok || !this.resolvedBinary) {
      throw new ProviderUnavailableError(
        this.name,
        process.env.HIGGSFIELD_BIN ?? DEFAULT_BINARIES[0],
      );
    }
    return this.resolvedBinary;
  }

  private async runWithErrorMapping<S extends z.ZodTypeAny>(
    opts: CliInvokeOptions<unknown>,
    schema: S,
  ): Promise<z.infer<S>> {
    const invoked = await cliInvoke<unknown>({ ...opts, schema: undefined });
    const raw = invoked.parsed;

    const errPayload = HiggsfieldErrorPayload.safeParse(raw);
    if (errPayload.success) {
      throw new ProviderRejectedError(
        this.name,
        errPayload.data.error.code ?? 'UNKNOWN',
        errPayload.data.error.message,
        errPayload.data.error.hint,
      );
    }

    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    throw new ProviderParseError(
      this.name,
      `response did not match schema: ${parsed.error.message}`,
      invoked.stdout.slice(0, 500),
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the brain_activity JSON output from the `text` field of the CLI
 * response envelope. The model returns a JSON string (not a nested
 * object), so we do a second parse + Zod validation.
 */
function parseBrainActivityOutput(text: string, provider: string): GenerateTextResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderParseError(provider, 'brain_activity output was not valid JSON', text.slice(0, 500));
  }
  const scored = ViralityScoreSchema.safeParse(parsed);
  if (!scored.success) {
    throw new ProviderParseError(
      provider,
      `brain_activity score did not match schema: ${scored.error.message}`,
      text.slice(0, 500),
    );
  }
  return {
    score: scored.data.score,
    confidence: scored.data.confidence,
    reasoning: scored.data.reasoning,
  };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const higgsfieldTextAdapter: ProviderAdapter = new HiggsfieldTextAdapter();
