/**
 * v1.2 Tool Registry — typed error classes.
 *
 * Every tool in `lib/agent-tools/*` throws one of these (or returns
 * a `Result`-shaped tuple — see `safeExecute` below). The Director
 * route (`app/api/ai/prompt/route.ts`) catches them at the loop
 * boundary and converts to either:
 *   - a JSON 4xx/5xx response (validation / not-available),
 *   - a `tool-result` error part that the model can react to
 *     mid-loop (recoverable errors), or
 *   - an SSE `data: {"error": "..."}` terminal event (fatal).
 *
 * The class hierarchy mirrors that policy:
 *
 *   AgentToolError (abstract base)
 *   ├── ValidationError          — input schema rejected (4xx, terminal)
 *   ├── ToolNotAvailableError    — provider missing / config wrong (4xx, terminal)
 *   ├── ToolTimeoutError         — provider didn't answer in time (retryable)
 *   ├── ToolExecutionError       — provider returned an error (retryable)
 *   └── AssetPersistError        — storage write failed (terminal)
 *
 * Use the `safeExecute` helper at the tool boundary so we always
 * convert thrown errors into typed `Result`s — the AI SDK's tool
 * execute() can return the typed error and let the model see it
 * as a tool-result, instead of crashing the whole stream.
 */
import { ZodError } from 'zod';
import type { z } from 'zod';

/**
 * Common base for every tool error. `code` is the string the route
 * layer pattern-matches on; `name` is the class name (for log
 * grep); `cause` preserves the underlying throwable for
 * postmortems.
 *
 * Note: extending `Error` with a real `cause` is supported by the
 * ES2022 Error constructor; we forward it explicitly so it survives
 * older transpilation targets (Vite target is ES2017, see
 * `tsconfig.json`).
 */
export abstract class AgentToolError extends Error {
  abstract readonly code: string;
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = new.target.name;
    if (cause !== undefined) this.cause = cause;
    // Maintain proper prototype chain for `instanceof` after transpile.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// 1. ValidationError — the model's tool-call payload didn't pass Zod
// ---------------------------------------------------------------------------

/**
 * Thrown when a tool's input schema rejects the model's tool-call
 * payload. Carries the raw Zod issues so the route layer can
 * serialise them in the 4xx response body.
 */
export class ValidationError extends AgentToolError {
  readonly code = 'VALIDATION_ERROR';
  readonly issues: z.core.$ZodIssue[];

  constructor(message: string, issues: z.core.$ZodIssue[], cause?: unknown) {
    super(message, cause);
    this.issues = issues;
  }

  /** Convenience: build a ValidationError from a Zod safeParse failure. */
  static fromZod(err: ZodError, label: string): ValidationError {
    return new ValidationError(
      `${label} input failed schema validation`,
      err.issues,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. ToolNotAvailableError — provider missing, OAuth expired, etc.
// ---------------------------------------------------------------------------

/**
 * Thrown when a tool is wired up but its underlying capability is
 * missing: a provider has no API key, OAuth hasn't completed,
 * camofox sidecar is not running, etc.
 *
 * Terminal — retrying without user intervention won't help.
 */
export class ToolNotAvailableError extends AgentToolError {
  readonly code = 'TOOL_NOT_AVAILABLE';
  readonly toolName: string;
  readonly reason: string;

  constructor(toolName: string, reason: string, cause?: unknown) {
    super(`tool "${toolName}" is not available: ${reason}`, cause);
    this.toolName = toolName;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 3. ToolTimeoutError — provider didn't respond in time
// ---------------------------------------------------------------------------

/**
 * Thrown when the underlying provider didn't respond within the
 * configured timeout. The Director loop MAY retry with the same
 * arguments (transient timeout) or MAY fall through to a different
 * model.
 */
export class ToolTimeoutError extends AgentToolError {
  readonly code = 'TOOL_TIMEOUT';
  readonly toolName: string;
  readonly timeoutMs: number;

  constructor(toolName: string, timeoutMs: number, cause?: unknown) {
    super(`tool "${toolName}" timed out after ${timeoutMs}ms`, cause);
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

// ---------------------------------------------------------------------------
// 4. ToolExecutionError — provider returned an error response
// ---------------------------------------------------------------------------

/**
 * Thrown when the provider responded (didn't time out) but with a
 * non-2xx or a payload-shape that doesn't match expectations. The
 * `retryable` flag tells the Director loop whether to try again.
 */
export class ToolExecutionError extends AgentToolError {
  readonly code = 'TOOL_EXECUTION_ERROR';
  readonly toolName: string;
  readonly retryable: boolean;
  readonly providerStatus?: number;

  constructor(
    toolName: string,
    message: string,
    opts: { retryable?: boolean; providerStatus?: number; cause?: unknown } = {},
  ) {
    super(`tool "${toolName}" failed: ${message}`, opts.cause);
    this.toolName = toolName;
    this.retryable = opts.retryable ?? false;
    this.providerStatus = opts.providerStatus;
  }
}

// ---------------------------------------------------------------------------
// 5. AssetPersistError — storage write failed
// ---------------------------------------------------------------------------

/**
 * Thrown when `persist_asset` could not write to the local store
 * (Tauri store / idb-keyval / localStorage quota exceeded). The
 * provider call already succeeded, so retrying without freeing
 * quota would burn another credit; we surface a clear terminal
 * error and let the user intervene.
 */
export class AssetPersistError extends AgentToolError {
  readonly code = 'ASSET_PERSIST_ERROR';
  readonly assetRefProvider: string;

  constructor(assetRefProvider: string, message: string, cause?: unknown) {
    super(
      `failed to persist asset from provider "${assetRefProvider}": ${message}`,
      cause,
    );
    this.assetRefProvider = assetRefProvider;
  }
}

// ---------------------------------------------------------------------------
// Result helper — safeExecute wraps a tool execute() so throws
// become typed Result objects, and the AI SDK can surface them as
// tool-result errors instead of crashing the stream.
// ---------------------------------------------------------------------------

/** Discriminated union — either Ok(value) or Err(agentToolError). */
export type ToolResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AgentToolError };

/** Sugar: build an Ok result. */
export function ok<T>(value: T): ToolResult<T> {
  return { ok: true, value };
}

/** Sugar: build an Err result. */
export function err<T>(error: AgentToolError): ToolResult<T> {
  return { ok: false, error };
}

/**
 * Wrap a tool's async execute() so any thrown value becomes a typed
 * `ToolResult`. We deliberately DON'T swallow random programmer
 * errors — only the known AgentToolError subclasses (and the common
 * Zod/TimeoutError shapes) are caught and converted. Everything else
 * re-throws so the test suite catches genuine bugs.
 */
export async function safeExecute<T>(fn: () => Promise<T>): Promise<ToolResult<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof AgentToolError) {
      return err(e);
    }
    if (e instanceof ZodError) {
      return err(ValidationError.fromZod(e, 'tool'));
    }
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      return err(new ToolExecutionError('unknown', 'DOMException TimeoutError', {
        retryable: true,
        cause: e,
      }));
    }
    if (e instanceof DOMException && e.name === 'AbortError') {
      return err(new ToolExecutionError('unknown', 'caller aborted', {
        retryable: false,
        cause: e,
      }));
    }
    // Unknown error — re-throw so it surfaces as a real bug, not a
    // hidden tool result.
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Type-narrowing helpers
// ---------------------------------------------------------------------------

export function isAgentToolError(e: unknown): e is AgentToolError {
  return e instanceof AgentToolError;
}

export function isRetryableError(e: unknown): boolean {
  return e instanceof ToolTimeoutError
    || (e instanceof ToolExecutionError && e.retryable);
}
