/**
 * ProviderAdapter — unified interface for all v1.2 agentic-AI providers.
 *
 * Why this exists (ROADMAP.md §v1.2.3, DECISIONS.md ADR-005):
 *   v1.2 adds an agentic tool-use loop. The "generate_image" and
 *   "generate_video" tools each need to dispatch to a backing
 *   provider — Higgsfield, mmx, Leonardo, or MiniMax — without the
 *   tool itself caring which one is wired. ProviderAdapter is the
 *   thin contract every concrete adapter implements.
 *
 * ADR-005 chose CLI wrappers over MCP for most providers because
 * Anthropic's 2026-04 research showed 98.7% token reduction when
 * models write shell scripts instead of MCP tool calls, and
 * Scalekit's benchmark put MCP at 32× the cost with 28% timeouts.
 * The adapters in this directory realise that decision.
 *
 * Conventions:
 *   - Every adapter exposes `name`, `generateImage`, and
 *     `generateVideo` per the unified surface.
 *   - Adapters MAY extend the interface with provider-specific
 *     methods (e.g. minimax-text adds `generateText`/`describeImage`).
 *     Those are typed via module augmentation in the adapter file.
 *   - Errors come from a hierarchy rooted at `ProviderError`; the
 *     registry wraps them so callers can catch one type.
 *   - The `isAvailable()` method is required on every adapter so the
 *     Director (lib/agent-tools) can skip providers whose CLI binary
 *     is missing rather than letting them fail at call time.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// AssetRef
// ---------------------------------------------------------------------------

/**
 * AssetRef is the wire-shape every adapter's `generate*` returns.
 * Three flavours are supported:
 *   - Synchronous image: `kind: 'image'`, `url` populated immediately.
 *   - Synchronous video: `kind: 'video'`, `url` populated immediately.
 *   - Async job:        `kind: 'job'`, `jobId` populated; caller must
 *                       poll the provider's status endpoint for the
 *                       eventual URL. This is the common shape for
 *                       Higgsfield (MCP async tools) and Leonardo
 *                       (which returns a generationId and renders
 *                       async).
 */
export type AssetKind = 'image' | 'video' | 'job';

export interface AssetRef {
  kind: AssetKind;
  provider: string;
  /** Public URL once the asset is rendered. */
  url?: string;
  /** Local file path if the adapter wrote the asset to disk. */
  path?: string;
  /** Provider's async-job id. Populated when `kind === 'job'`. */
  jobId?: string;
  /** Free-form provider-specific metadata (raw CLI response, request id, etc.). */
  raw?: unknown;
  /** Optional duration in seconds (video only). */
  durationSec?: number;
  /** Optional mime type. */
  mimeType?: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Common settings for image generation. */
export interface GenerateImageOptions {
  prompt: string;
  /** Negative prompt (provider-dependent support). */
  negativePrompt?: string;
  /** Aspect ratio short-form (e.g. "1:1", "16:9"). */
  aspectRatio?: string;
  width?: number;
  height?: number;
  /** Number of images to produce (1-8 depending on provider). */
  n?: number;
  seed?: number;
  /** Provider-specific style UUIDs (Leonardo Nano Banana family). */
  styleIds?: string[];
  /** Quality level for GPT Image family. */
  quality?: 'LOW' | 'MEDIUM' | 'HIGH';
  /** Provider-specific model id. Falls back to the adapter's default. */
  model?: string;
  /** Hard timeout override in ms. Default: 60_000 (per spec). */
  timeoutMs?: number;
  /** AbortSignal so the Director can cancel a tool call. */
  signal?: AbortSignal;
  /** Provider-specific reference image (image-to-image / start frame). */
  referenceImage?: { url?: string; path?: string; id?: string };
  /** Free-form extras for forward-compat without extending the type. */
  extra?: Record<string, unknown>;
}

/** Common settings for video generation. */
export interface GenerateVideoOptions {
  prompt: string;
  /** Optional start-frame image (URL, local path, or provider asset id). */
  imageId?: string;
  imagePath?: string;
  imageUrl?: string;
  /** Duration in seconds. Provider-specific valid set. */
  durationSec?: number;
  /** Provider-specific model id. Falls back to the adapter's default. */
  model?: string;
  /** Hard timeout override in ms. Default: 60_000 (per spec). */
  timeoutMs?: number;
  signal?: AbortSignal;
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Root of the provider-error hierarchy. Catching this catches every
 *  concrete failure from every adapter. */
export class ProviderError extends Error {
  constructor(
    /** Stable machine-readable code (e.g. 'SPAWN', 'PARSE', 'TIMEOUT'). */
    public readonly code: string,
    message: string,
    /** Provider that produced the error (matches `ProviderAdapter.name`). */
    public readonly provider: string,
    /** Optional hint shown to the user. */
    public readonly hint?: string,
    /** Underlying cause for debug logs. */
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** The CLI binary is not installed (or not on PATH). */
export class ProviderUnavailableError extends ProviderError {
  constructor(provider: string, binary: string, cause?: unknown) {
    super(
      'UNAVAILABLE',
      `Provider "${provider}" CLI binary "${binary}" is not available on PATH`,
      provider,
      `Install the CLI for ${provider} (see DECISIONS.md ADR-005) or set the *_BIN env var to its absolute path.`,
      cause,
    );
    this.name = 'ProviderUnavailableError';
  }
}

/** The CLI process was killed because it exceeded `timeoutMs`. */
export class ProviderTimeoutError extends ProviderError {
  constructor(provider: string, timeoutMs: number) {
    super(
      'TIMEOUT',
      `Provider "${provider}" exceeded ${timeoutMs}ms timeout`,
      provider,
      'Increase the per-call timeoutMs, or split the work into smaller requests.',
    );
    this.name = 'ProviderTimeoutError';
  }
}

/** The CLI exited non-zero with no parseable error payload. */
export class ProviderExecError extends ProviderError {
  constructor(provider: string, exitCode: number | string, stderr: string) {
    super(
      String(exitCode),
      `Provider "${provider}" exited ${exitCode}: ${stderr.slice(0, 400) || 'no stderr'}`,
      provider,
    );
    this.name = 'ProviderExecError';
  }
}

/** The CLI's stdout could not be parsed as JSON, or Zod validation failed. */
export class ProviderParseError extends ProviderError {
  constructor(provider: string, reason: string, raw?: string) {
    super(
      'PARSE',
      `Provider "${provider}" returned unparseable output: ${reason}`,
      provider,
      undefined,
      raw,
    );
    this.name = 'ProviderParseError';
  }
}

/** Provider rejected the request for a non-recoverable reason (auth, plan). */
export class ProviderRejectedError extends ProviderError {
  constructor(provider: string, code: number | string, message: string, hint?: string) {
    super(String(code), message, provider, hint);
    this.name = 'ProviderRejectedError';
  }
}

/** Provider doesn't support the requested operation. The Director
 *  uses this to fall back to another adapter. */
export class UnsupportedOperationError extends ProviderError {
  constructor(provider: string, operation: 'image' | 'video' | 'text') {
    super(
      'UNSUPPORTED',
      `Provider "${provider}" does not support ${operation} generation`,
      provider,
      'Pick a different provider for this tool call.',
    );
    this.name = 'UnsupportedOperationError';
  }
}

// ---------------------------------------------------------------------------
// ProviderAdapter
// ---------------------------------------------------------------------------

/**
 * The unified adapter contract. Every adapter under `lib/providers/`
 * implements this. The Director (lib/agent-tools) calls only these
 * three methods.
 */
export interface ProviderAdapter {
  /** Stable id used in tool-call routing (e.g. "higgsfield", "mmx",
   *  "leonardo", "minimax-text", "minimax-video"). */
  readonly name: string;

  /** Human-readable label for the UI. */
  readonly label: string;

  /** True if the backing CLI binary (or HTTP credentials) are usable
   *  in the current environment. Cheap to call — adapters cache. */
  isAvailable(): Promise<boolean>;

  /** Generate an image. Throws {@link UnsupportedOperationError} if
   *  the provider doesn't do image generation (e.g. M3 text-only). */
  generateImage(opts: GenerateImageOptions): Promise<AssetRef>;

  /** Generate a video. Throws {@link UnsupportedOperationError} if
   *  the provider doesn't do video generation. */
  generateVideo(opts: GenerateVideoOptions): Promise<AssetRef>;
}

// ---------------------------------------------------------------------------
// Zod helpers for adapter implementations
// ---------------------------------------------------------------------------

/**
 * Loose Zod schema for "a JSON object the CLI returned". Each adapter
 * narrows further in its own schema. We export it so adapter tests
 * can re-use the same validation entry-point.
 */
export const ProviderJson = z.record(z.string(), z.unknown());

/**
 * Re-export z so adapter files don't have to import it from
 * `zod` directly — keeps the import surface tight.
 */
export { z };
