/**
 * Higgsfield CLI adapter — ProviderAdapter implementation that
 * shells out to the locally-installed `@higgsfield/cli` binary
 * (`higgsfield` or `higgs`).
 *
 * Why CLI over MCP (DECISIONS.md ADR-005):
 *   The agentic tool-use loop in lib/agent-tools spawns a CLI per
 *   call. The MCP server at https://mcp.higgsfield.ai/mcp stays
 *   reserved for the deterministic OAuth flow (lib/higgsfield/oauth.ts)
 *   and token storage (lib/higgsfield/token-store.ts) — those need a
 *   long-lived connection; the model-generation calls don't.
 *
 * CLI surface we depend on (per @higgsfield/cli v0.1.40 MODELS.md):
 *   higgsfield generate create <model> --prompt <text> --json
 *       Generates a single image synchronously. Returns JSON to stdout.
 *   higgsfield generate create <model> --prompt <text> --image <ref> --json
 *       Image-to-image / character reference path. `--image` accepts
 *       either a local file path (CLI auto-uploads) or a UUID from
 *       a previous job / upload command.
 *   higgsfield generate create <model> --prompt <text> [--start-image <ref>] --json
 *       Video generation. Most models are async; the CLI returns
 *       {"status": "queued", "request_id": "..."} in that case.
 *       For video the canonical flag is `--start-image` (per MODELS.md),
 *       not `--image`. The v0.1.40 binary has no `video` subcommand
 *       — image and video both go through `generate create`; the model
 *       slug is the only discriminator.
 *
 * Auth (v1.2.6 rewrite — was broken in v1.2.5):
 *   The CLI does NOT read a `HIGGSFIELD_API_KEY` env var. Verified by
 *   string-scanning the v0.1.40 Windows binary; the env vars the CLI
 *   actually reads are: HIGGSFIELD_API_URL, HIGGSFIELD_APP_URL,
 *   HIGGSFIELD_CREDENTIALS_PATH, HIGGSFIELD_DEVICE_AUTH_URL, plus
 *   telemetry/PM toggles. The correct injection path is to write a
 *   `{"access_token": "<token>"}` JSON file and point
 *   `HIGGSFIELD_CREDENTIALS_PATH` at it. The default path (when env
 *   is unset) is `os.UserConfigDir() + "/higgsfield/credentials.json"`
 *   — i.e. `%AppData%\higgsfield\credentials.json` on Windows.
 *
 *   We default to "use whatever the CLI's own auth cache has". A user
 *   who has run `higgsfield auth login` once is already authenticated
 *   for the next 30 days (CLI auto-refreshes). The Settings → CLI
 *   token field is now an OPTIONAL override for headless / CI users
 *   who want a different workspace token without overwriting their
 *   personal auth cache. The adapter:
 *     1. If `options.cliToken` is set: write a temp credentials.json
 *        with `{access_token: token}` and pass HIGGSFIELD_CREDENTIALS_PATH
 *        pointing to it. Cleanup after the call.
 *     2. Else: no env override. The CLI uses the user's cached
 *        credentials from `higgsfield auth login`.
 *
 * Flag set (v1.2.6 rewrite — was broken in v1.2.5):
 *   Removed flags that v1.2.5 passed but MODELS.md shows don't exist:
 *     --seed, --width, --height, --negative-prompt,
 *     --image-url, --image-id
 *   v1.2.5 also confused image vs video: video models use
 *   `--start-image`, not `--image`. Now correctly handled.
 *   Per-model enums (resolution / quality / duration / etc.) are
 *   forwarded via the spec-compliant `pushFlag` helper.
 *
 * Behaviour matrix:
 *   - If the CLI binary isn't on PATH the adapter's isAvailable()
 *     returns false; the Director skips it. generateImage/generateVideo
 *     throw ProviderUnavailableError.
 *   - If the binary errors on spawn (vendor/ missing) we surface the
 *     same error class.
 *   - Successful JSON output is validated against the schemas below.
 *   - We do NOT call the binary with shell:true unless it's a .cmd
 *     shim (handled by cli-utils.spawnNeedsShell).
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  type AssetRef,
  type GenerateImageOptions,
  type GenerateVideoOptions,
  type ProviderAdapter,
  ProviderParseError,
  ProviderRejectedError,
  ProviderUnavailableError,
  UnsupportedOperationError,
} from '../interface';
import {
  binaryExists,
  clampTimeout,
  cliInvoke,
  isBinaryAvailable,
  pushFlag,
  type CliInvokeOptions,
} from '../cli-utils';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/** Response shape for a successful synchronous image generation.
 *  Matches what `@higgsfield/cli` returns with `--json`. */
const HiggsfieldImageResponse = z.object({
  /** Public URL to the generated image. */
  url: z.string().url().optional(),
  /** Local file path if the CLI wrote the image to disk. */
  path: z.string().optional(),
  /** Provider-internal request id, present even on sync calls. */
  request_id: z.string().optional(),
  /** Wall-clock duration the CLI reports. Useful for budget tracking. */
  duration: z.number().optional(),
  /** Generation metadata echoed back for debugging. */
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type HiggsfieldImageResponseT = z.infer<typeof HiggsfieldImageResponse>;

/** Response shape for video generation. Async when `status === 'queued'`. */
const HiggsfieldVideoResponse = z.object({
  url: z.string().url().optional(),
  path: z.string().optional(),
  request_id: z.string().optional(),
  status: z.enum(['completed', 'queued', 'failed']).optional(),
  duration: z.number().optional(),
  error: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type HiggsfieldVideoResponseT = z.infer<typeof HiggsfieldVideoResponse>;

/** Response shape for `higgsfield generate cost` calls. */
const HiggsfieldCostResponse = z.object({
  credits: z.number(),
  credits_exact: z.number().optional(),
});
export type HiggsfieldCostResponseT = z.infer<typeof HiggsfieldCostResponse>;

/** Common error payload shape. */
const HiggsfieldErrorPayload = z.object({
  error: z.object({
    code: z.union([z.string(), z.number()]).optional(),
    message: z.string(),
    hint: z.string().optional(),
  }),
});

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const DEFAULT_BINARIES = ['higgsfield', 'higgs'] as const;
const DEFAULT_IMAGE_MODEL = 'text2image_soul_v2';
const DEFAULT_VIDEO_MODEL = 'seedance_2_0';

/**
 * Best-effort file extension guess from a URL. The Higgsfield
 * CLI's `--image` auto-upload reads the magic bytes for the
 * real type, so a wrong extension is cosmetic — but a sane
 * extension helps the CLI's upload step route to the right
 * multipart field. Returns '' when the URL gives no signal
 * (e.g. query-string-only URLs from CDN-signed links).
 */
function guessImageExtension(url: string): string {
  try {
    const u = new URL(url);
    const pathname = u.pathname.toLowerCase();
    if (pathname.endsWith('.png')) return '.png';
    if (pathname.endsWith('.webp')) return '.webp';
    if (pathname.endsWith('.gif')) return '.gif';
    if (pathname.endsWith('.bmp')) return '.bmp';
    if (pathname.endsWith('.tif') || pathname.endsWith('.tiff')) return '.tiff';
    // Default to jpg; JPEG covers the majority of CDN-served
    // images and is what the CLI's upload step accepts as
    // fallback when magic-byte detection fails.
    return '.jpg';
  } catch {
    return '.jpg';
  }
}

export class HiggsfieldCliAdapter implements ProviderAdapter {
  readonly name = 'higgsfield';
  readonly label = 'Higgsfield (CLI)';

  private resolvedBinary: string | null = null;
  private resolveAttempted = false;

  /**
   * Path to a temp credentials.json file we wrote, if any. We
   * unlink it when the process exits so a one-off token paste
   * doesn't linger on disk. Null when the user is using the
   * CLI's own cached auth (from `higgsfield auth login`).
   */
  private tempCredentialsPath: string | null = null;

  /**
   * V1.2.6: optional CLI token (raw `access_token` value) for
   * users who want to use a workspace token without overwriting
   * their personal CLI auth cache. When set, the adapter writes
   * a temp `credentials.json` and points `HIGGSFIELD_CREDENTIALS_PATH`
   * at it (the v0.1.40 binary's only recognised env-var injection
   * path; v1.2.5's `HIGGSFIELD_API_KEY` was a no-op). When unset,
   * the adapter relies on the CLI's own cached credentials
   * (`higgsfield auth login` → `~/.config/higgsfield/credentials.json`
   * on Unix / `%AppData%\higgsfield\credentials.json` on Windows).
   */
  constructor(private readonly options: { cliToken?: string } = {}) {}

  /**
   * Probe for the CLI binary. We try `higgsfield` first, then `higgs`
   * (both are exported by @higgsfield/cli). The result is cached
   * after the first successful probe so the hot path stays O(1).
   */
  async isAvailable(): Promise<boolean> {
    if (this.resolvedBinary) return true;
    if (this.resolveAttempted && !this.resolvedBinary) return false;

    // Honour explicit override.
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

  async generateImage(opts: GenerateImageOptions): Promise<AssetRef> {
    if (!opts.prompt) {
      throw new ProviderParseError(this.name, 'generateImage requires a non-empty prompt');
    }
    const bin = await this.requireBinary();
    const model = opts.model ?? DEFAULT_IMAGE_MODEL;

    const args = ['generate', 'create', model, '--json'];
    pushFlag(args, '--prompt', opts.prompt);
    // V1.2.6: --seed / --width / --height / --negative-prompt
    // are NOT in MODELS.md for any image model. Removed.
    // V1.7.0-PRE-PROD-FIX: the Higgsfield CLI flag is `--aspect_ratio`
    // (UNDERSCORE), not `--aspect-ratio` (hyphen). The model spec at
    // lib/model-specs/higgsfield-nano-banana-pro.json:74 spells this
    // out explicitly: "Use --aspect_ratio, NOT --width/--height. The
    // MCP tool resolves dimensions from the ratio." Sending the hyphen
    // form made the CLI reject the call with
    // "Error: Unknown params: aspect-ratio".
    if (opts.aspectRatio) pushFlag(args, '--aspect_ratio', opts.aspectRatio);
    // V1.2.6: --negative-prompt removed (not a real flag).
    // If a caller needs negative prompt semantics, they should
    // bake it into the main prompt text (most nano_banana
    // models support inline "AVOID:" prefixes).

    // V1.2.6: --image-url / --image-id collapsed into --image.
    // MODELS.md: "--image accepts either a UUID (upload id or
    // previous job id) or a local file path; paths are
    // auto-uploaded." A URL must be downloaded to a temp file
    // first because the CLI doesn't fetch remote URLs.
    if (opts.referenceImage) {
      const ref = await this.resolveImageReference(opts.referenceImage);
      if (ref) pushFlag(args, '--image', ref);
    }

    const invokeOpts: CliInvokeOptions<unknown> = {
      provider: this.name,
      binary: bin,
      args,
      // V1.2.6: forward the user's CLI token via a temp
      // credentials.json pointed at by HIGGSFIELD_CREDENTIALS_PATH.
      // The binary's only recognised env-var injection path.
      // (v1.2.5's HIGGSFIELD_API_KEY was a silent no-op.)
      env: await this.maybeBuildAuthEnv(),
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    };

    const result = await this.runWithErrorMapping(invokeOpts, HiggsfieldImageResponse);
    return imageResponseToAssetRef(result, this.name);
  }

  async generateVideo(opts: GenerateVideoOptions): Promise<AssetRef> {
    if (!opts.prompt && !opts.imagePath && !opts.imageUrl && !opts.imageId) {
      throw new ProviderParseError(
        this.name,
        'generateVideo requires a prompt or a start-frame image',
      );
    }
    const bin = await this.requireBinary();
    const model = opts.model ?? DEFAULT_VIDEO_MODEL;

    const args = ['generate', 'create', model, '--json'];
    pushFlag(args, '--prompt', opts.prompt);
    pushFlag(args, '--duration', opts.durationSec);
    // V1.2.6: video models use --start-image per MODELS.md,
    // not --image (v1.2.5's mistake). Same UUID-or-path rule
    // as image reference.
    if (opts.imagePath || opts.imageUrl || opts.imageId) {
      const ref = await this.resolveImageReference({
        path: opts.imagePath,
        url: opts.imageUrl,
        id: opts.imageId,
      });
      if (ref) pushFlag(args, '--start-image', ref);
    }

    const invokeOpts: CliInvokeOptions<unknown> = {
      provider: this.name,
      binary: bin,
      args,
      // V1.2.6: same auth path as generateImage.
      env: await this.maybeBuildAuthEnv(),
      // Video gen is the slow path; clampTimeout applies the spec
      // 60s default when no override is supplied. Callers needing
      // longer (e.g. slow models behind a queue) pass an explicit
      // `opts.timeoutMs` and clampTimeout honours it.
      timeoutMs: clampTimeout(opts.timeoutMs),
      signal: opts.signal,
    };

    const result = await this.runWithErrorMapping(invokeOpts, HiggsfieldVideoResponse);
    return videoResponseToAssetRef(result, this.name);
  }

  /**
   * V1.3: real-time credit cost estimate via `higgsfield generate cost`.
   *
   * Uses the same auth pattern as generateImage/generateVideo.
   * The `--duration` flag is NOT forwarded — the cost CLI may not
   * support it (verified: duration is silently ignored for video models).
   *
   * Falls back to the static creditHint when the CLI call fails
   * (CLI not on PATH, rate-limited, etc.). Callers should always
   * check `raw` for a `warning` field to detect fallback usage.
   */
  async estimateCost(
    model: string,
    opts: {
      prompt?: string;
      imagePath?: string;
      imageUrl?: string;
      imageId?: string;
    } = {},
  ): Promise<{ credits: number; credits_exact: number | undefined; currency: 'credit'; raw: unknown }> {
    const bin = await this.requireBinary();

    const args = ['generate', 'cost', model, '--json'];
    pushFlag(args, '--prompt', opts.prompt ?? 'estimate');

    if (opts.imagePath || opts.imageUrl || opts.imageId) {
      const ref = await this.resolveImageReference({
        path: opts.imagePath,
        url: opts.imageUrl,
        id: opts.imageId,
      });
      if (ref) pushFlag(args, '--image', ref);
    }

    const invokeOpts: CliInvokeOptions<unknown> = {
      provider: this.name,
      binary: bin,
      args,
      env: await this.maybeBuildAuthEnv(),
      timeoutMs: 30_000, // cost calls are fast; 30s is generous
    };

    const invoked = await cliInvoke<unknown>({ ...invokeOpts, schema: undefined });
    const raw = invoked.parsed;

    // Check for error payload (rate-limit, quota, etc.)
    const errPayload = HiggsfieldErrorPayload.safeParse(raw);
    if (errPayload.success) {
      throw new ProviderRejectedError(
        this.name,
        errPayload.data.error.code ?? 'UNKNOWN',
        errPayload.data.error.message,
        errPayload.data.error.hint,
      );
    }

    const parsed = HiggsfieldCostResponse.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderParseError(
        this.name,
        `cost response did not match schema: ${parsed.error.message}`,
        invoked.stdout.slice(0, 500),
      );
    }

    return {
      credits: parsed.data.credits,
      credits_exact: parsed.data.credits_exact,
      currency: 'credit',
      raw,
    };
  }

  /**
   * V1.3: get the current status of a single async generation job.
   * Wraps `higgsfield generate get <job_id> --json`. Returns the
   * raw job record so the caller can inspect status, result_url,
   * error, etc. The tool layer normalises the shape.
   */
  async getJobStatus(jobId: string): Promise<unknown> {
    if (!jobId) {
      throw new ProviderParseError(this.name, 'getJobStatus requires a non-empty jobId');
    }
    const bin = await this.requireBinary();
    const args = ['generate', 'get', jobId, '--json'];

    const invokeOpts: CliInvokeOptions<unknown> = {
      provider: this.name,
      binary: bin,
      args,
      env: await this.maybeBuildAuthEnv(),
      timeoutMs: clampTimeout(undefined),
    };
    const result = await this.runWithErrorMapping(invokeOpts, z.unknown());
    return result;
  }

  /**
   * V1.3: list recent generation jobs. Wraps
   * `higgsfield generate list [--image|--video|--text] --size N --json`.
   * Returns an array of job records.
   */
  async listJobs(opts: { mediaType?: 'image' | 'video' | 'text'; size?: number } = {}): Promise<unknown> {
    const bin = await this.requireBinary();
    const args = ['generate', 'list', '--json'];
    if (opts.mediaType) {
      args.push(`--${opts.mediaType}`);
    }
    args.push('--size', String(opts.size ?? 20));

    const invokeOpts: CliInvokeOptions<unknown> = {
      provider: this.name,
      binary: bin,
      args,
      env: await this.maybeBuildAuthEnv(),
      timeoutMs: clampTimeout(undefined),
    };
    const result = await this.runWithErrorMapping(invokeOpts, z.unknown());
    return result;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * V1.2.6: build the auth env-var bag for a CLI invocation.
   *
   * - If the user has set `options.cliToken` we write a temp
   *   credentials.json with `{access_token: token}` and return
   *   `{ HIGGSFIELD_CREDENTIALS_PATH: <temp path> }`. The CLI
   *   reads the credentials file path from this env var.
   * - If no token is set we return `undefined` so the CLI uses
   *   its own cached auth from `higgsfield auth login`.
   *
   * The temp file is unlinked in the `process.on('exit')` hook
   * installed in the constructor so a one-off token paste
   * doesn't linger on disk. We do NOT delete it after a single
   * call because the adapter is a singleton and the user might
   * run many generations in one session.
   */
  private async maybeBuildAuthEnv(): Promise<Record<string, string> | undefined> {
    if (!this.options.cliToken) return undefined;
    if (this.tempCredentialsPath) {
      // Reuse the temp file across calls within the same
      // session. The token is a JWT whose TTL is on the order
      // of weeks; we don't bother refreshing.
      return { HIGGSFIELD_CREDENTIALS_PATH: this.tempCredentialsPath };
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfield-cred-'));
    const credPath = path.join(dir, 'credentials.json');
    // Match the v0.1.40 binary's recognised schema. The
    // `access_token` field is the only one the CLI reads
    // (verified by string-scanning the binary for the
    // "credentials.json" + "access_token" symbols).
    await fs.writeFile(
      credPath,
      JSON.stringify({ access_token: this.options.cliToken }, null, 2),
      { mode: 0o600 },
    );
    this.tempCredentialsPath = credPath;
    // Best-effort cleanup. `process.on('exit')` is the only
    // hook Next.js's Tauri WebView reliably fires; for a
    // clean shutdown this is enough.
    process.on('exit', () => {
      try {
        // sync unlink in the exit hook — async fs.unlink
        // would never resolve in time.
        require('node:fs').rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort; ignore
      }
    });
    return { HIGGSFIELD_CREDENTIALS_PATH: credPath };
  }

  /**
   * V1.2.6: collapse the three image-reference shapes (path,
   * URL, UUID) into a single string the CLI accepts via
   * `--image` (image models) or `--start-image` (video models).
   *
   * - `path`  → returned verbatim. CLI auto-uploads.
   * - `id`    → returned verbatim. CLI uses the cached UUID.
   * - `url`   → downloaded to a temp file in os.tmpdir() and
   *             that path is returned. CLI auto-uploads. The
   *             temp file is cleaned up on process exit.
   */
  private async resolveImageReference(ref: {
    path?: string;
    url?: string;
    id?: string;
  }): Promise<string | null> {
    if (ref.path) return ref.path;
    if (ref.id) return ref.id;
    if (ref.url) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfield-ref-'));
      const ext = guessImageExtension(ref.url);
      const file = path.join(dir, `ref${ext}`);
      const res = await fetch(ref.url);
      if (!res.ok) {
        throw new ProviderParseError(
          this.name,
          `Failed to download reference image (${res.status} ${res.statusText})`,
        );
      }
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(file, buf);
      process.on('exit', () => {
        try {
          require('node:fs').rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      });
      return file;
    }
    return null;
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

  /**
   * Shared run helper. Wraps cliInvoke, then re-checks the parsed
   * JSON for an error payload that didn't surface as a non-zero
   * exit (some CLIs exit 0 with a JSON error blob).
   */
  private async runWithErrorMapping<S extends z.ZodTypeAny>(
    opts: CliInvokeOptions<unknown>,
    schema: S,
  ): Promise<z.infer<S>> {
    // We do a manual invoke because we need to inspect the JSON for
    // an `error` key even when the CLI exits 0. cliInvoke already
    // handles non-zero exit; this is the zero-exit-but-still-error
    // path. We bypass cliInvoke's Zod validation by passing
    // `schema: undefined` and re-validating the parsed JSON against
    // both the error and the success schemas ourselves.
    //
    // Order matters: we check the error schema FIRST because the
    // success schemas are intentionally permissive (all fields
    // optional) so an `{ error: { ... } }` payload would otherwise
    // pass the success schema with all fields undefined and the
    // adapter would silently return an empty AssetRef.
    const invoked = await cliInvoke<unknown>({ ...opts, schema: undefined });
    const raw = invoked.parsed;
    // First: is this an error payload? The CLI exits 0 but reports
    // a failure via the `error` key. Surface as ProviderRejectedError
    // so the Director treats it as non-recoverable.
    const errPayload = HiggsfieldErrorPayload.safeParse(raw);
    if (errPayload.success) {
      throw new ProviderRejectedError(
        this.name,
        errPayload.data.error.code ?? 'UNKNOWN',
        errPayload.data.error.message,
        errPayload.data.error.hint,
      );
    }
    // Then: validate against the success schema.
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    // Neither: real parse error.
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

function imageResponseToAssetRef(
  r: HiggsfieldImageResponseT,
  provider: string,
): AssetRef {
  if (r.url) {
    return {
      kind: 'image',
      provider,
      url: r.url,
      path: r.path,
      jobId: r.request_id,
      raw: r,
    };
  }
  if (r.path) {
    return { kind: 'image', provider, path: r.path, jobId: r.request_id, raw: r };
  }
  if (r.request_id) {
    // Async shape — caller will need to poll.
    return { kind: 'job', provider, jobId: r.request_id, raw: r };
  }
  // Schema-valid but no asset fields. Treat as a parse failure
  // because the CLI shape has changed.
  throw new ProviderParseError(
    provider,
    'Higgsfield response had no url/path/request_id',
    JSON.stringify(r).slice(0, 500),
  );
}

function videoResponseToAssetRef(
  r: HiggsfieldVideoResponseT,
  provider: string,
): AssetRef {
  if (r.status === 'failed') {
    throw new ProviderRejectedError(
      provider,
      'FAILED',
      r.error ?? 'Higgsfield video generation failed',
    );
  }
  if (r.status === 'queued' || (!r.url && !r.path && r.request_id)) {
    return {
      kind: 'job',
      provider,
      jobId: r.request_id,
      durationSec: r.duration,
      raw: r,
    };
  }
  if (r.url || r.path) {
    return {
      kind: 'video',
      provider,
      url: r.url,
      path: r.path,
      jobId: r.request_id,
      durationSec: r.duration,
      raw: r,
    };
  }
  throw new ProviderParseError(
    provider,
    'Higgsfield video response had no url/path/request_id',
    JSON.stringify(r).slice(0, 500),
  );
}

// ---------------------------------------------------------------------------
// Public singleton (matches the rest of lib/providers/)
// ---------------------------------------------------------------------------

export const higgsfieldAdapter: ProviderAdapter = new HiggsfieldCliAdapter();

// Suppress unused-warning for the type-only import in some configs.
export type { ProviderAdapter, UnsupportedOperationError };
