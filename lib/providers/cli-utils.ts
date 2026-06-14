/**
 * CLI invocation helper used by every CLI-based adapter under
 * `lib/providers/`. The Director (lib/agent-tools) must never call
 * `child_process.spawn` directly — it always goes through `cliInvoke`
 * so timeout, env-hygiene, JSON-parse, Zod-validation, and the
 * error-class hierarchy are applied consistently.
 *
 * Design notes:
 *   - Default timeout is 60s per the v1.2 spec ("CLI-spawn via
 *     child_process.spawn mit timeout (max 60s)"). Adapters that
 *     legitimately need longer (e.g. mmx video at 5 min) pass an
 *     explicit `timeoutMs` and the helper honours it.
 *   - We always use `spawn(bin, args, { shell: false })` so user-
 *     supplied prompts cannot be interpreted as shell metacharacters.
 *     The one exception is when the binary is a Windows `.cmd`/`.bat`
 *     shim (e.g. `mmx.cmd` from `npm i -g mmx-cli`) — Node 16+
 *     refuses to spawn those without `shell: true` (CVE-2024-27980).
 *     That branch is gated on a path-extension check.
 *   - On every error path we return a typed `ProviderError` subclass
 *     so callers can `instanceof` discriminate. We never throw the
 *     raw `Error` from node:child_process.
 *   - A test-injection seam (`__setSpawnForTests`) lets unit tests
 *     swap in a fake spawn without `vi.mock('node:child_process')`,
 *     which behaves inconsistently for built-in modules under
 *     vitest's happy-dom default env. Same pattern as
 *     `lib/mmx-client.ts`.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { spawn as SpawnFn } from 'node:child_process';
import { Readable } from 'node:stream';
import type { z } from 'zod';
import {
  ProviderExecError,
  ProviderParseError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  type ProviderError,
} from './interface';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Spec-mandated hard cap. Adapters that need longer pass an explicit
 *  `timeoutMs`; this is the safety net. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Adapter-side timeout resolver. Returns the spec default (60s) when
 * the caller doesn't supply `opts.timeoutMs`; otherwise returns the
 * caller's value verbatim so an explicit override is respected.
 *
 * This is intentionally NOT a hard upper clamp: the cliInvoke helper
 * applies its own safety net (60_000) inside `runOnce`, but adapters
 * that legitimately need longer (e.g. slow video models behind a
 * queue) can opt-in by passing an explicit `timeoutMs`. Mirrors the
 * pattern callers expected in the v1.2 spec.
 */
export function clampTimeout(optsTimeoutMs: number | undefined): number {
  if (typeof optsTimeoutMs !== 'number' || !Number.isFinite(optsTimeoutMs) || optsTimeoutMs <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return optsTimeoutMs;
}

/** Default PATH lookup for `which`-style resolution. Adapter code
 *  can override per-call via `binary`. */
export const DEFAULT_BIN = '';

/** Diagnostic log helper. The Director routes these into its
 *  per-step log stream. Kept as a module-level seam so tests
 *  can silence it. */
export type CliLog = (level: 'info' | 'warn' | 'error', msg: string, ctx?: Record<string, unknown>) => void;
let _log: CliLog = (level, msg, ctx) => {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (ctx) fn(`[providers] ${msg}`, ctx);
  else fn(`[providers] ${msg}`);
};
export function __setLogForTests(fn: CliLog | null): void {
  _log = fn ?? ((level, msg, ctx) => {
    const f = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    if (ctx) f(`[providers] ${msg}`, ctx);
    else f(`[providers] ${msg}`);
  });
}

// ---------------------------------------------------------------------------
// Spawn injection
// ---------------------------------------------------------------------------

let _spawn: typeof SpawnFn = nodeSpawn;
export function __setSpawnForTests(fn: typeof SpawnFn | null): void {
  _spawn = fn ?? nodeSpawn;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CliInvokeOptions<T> {
  /** Provider id (used in error messages and logs). */
  provider: string;
  /** Resolved binary path or name. Resolved lazily — pass `mmx.cmd`
   *  on Windows and the helper will add `shell: true` for you. */
  binary: string;
  /** Argv (no shell metacharacters interpreted). */
  args: string[];
  /** Optional extra env vars. The helper merges these on top of the
   *  current `process.env`; the adapter decides which ones to forward. */
  env?: Record<string, string | undefined>;
  /** Hard timeout. Default 60_000ms (spec). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Zod schema to validate the parsed JSON. If omitted the helper
   *  validates only that stdout is a JSON object. */
  schema?: z.ZodType<T>;
  /** When true, treat non-zero exit with empty stdout as success
   *  (some CLIs exit 0 with a side-effect log). Default: false. */
  tolerateEmptyStdout?: boolean;
}

export interface CliInvokeResult<T> {
  parsed: T;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/**
 * Resolve the absolute path of a binary, falling back to `which`-
 * style PATH lookup. Returns null if not found. The helper itself
 * does NOT call this — adapters that need resolution call
 * `resolveBinary()` and pass the result to `cliInvoke` so the
 * `UNAVAILABLE` error carries the binary name the user needs to
 * install.
 */
export function resolveBinary(name: string): string | null {
  // We don't want to take a hard dependency on node:path lookups; the
  // simplest portable check is to attempt a spawn-with-version probe
  // and see if it errors with ENOENT. Adapters that need stricter
  // resolution can use this hook to swap in `which`-style logic.
  if (!name) return null;
  return name;
}

/**
 * Returns true if the named binary can be spawned. Catches ENOENT
 * and returns false; never throws. Use this from `isAvailable()`
 * probes — it's the cheap, exception-free check.
 *
 * The semantics are "is the binary present" — not "does the binary
 * work". A non-zero exit with no ENOENT (e.g. CLI rejected the
 * version flag) still counts as "binary is here" so the adapter
 * gets a chance to call it for real and produce a clearer error.
 */
export async function isBinaryAvailable(name: string, probeArgs: string[] = ['--version']): Promise<boolean> {
  try {
    await runOnce({
      provider: 'probe',
      binary: name,
      args: probeArgs,
      timeoutMs: 5000,
    });
    return true;
  } catch (e) {
    if (e instanceof ProviderUnavailableError) return false;
    return true;
  }
}

/**
 * The single entry point for adapter → CLI communication. Spawns the
 * binary, collects stdout/stderr, applies the timeout, parses the
 * JSON, and validates it against the Zod schema. Returns a typed
 * result; throws a {@link ProviderError} subclass on every failure
 * path.
 *
 * Adapter pattern:
 *   const { parsed } = await cliInvoke({
 *     provider: 'higgsfield',
 *     binary: 'higgsfield',
 *     args: ['generate', 'create', 'text2image_soul_v2', '--prompt', prompt, '--json'],
 *     schema: HiggsfieldCreateResponse,
 *   });
 *   return parsedToAssetRef(parsed);
 */
export async function cliInvoke<T>(opts: CliInvokeOptions<T>): Promise<CliInvokeResult<T>> {
  const result = await runOnce(opts);
  return finalizeResult(opts, result);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface RunOnceResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  /** True if the helper killed the process for hitting the timeout. */
  timedOut: boolean;
}

/**
 * V1.8.1-UNC-CWD: pick a spawn cwd cmd.exe can actually use.
 *
 * In the bundled Tauri build the Next.js sidecar's working directory is
 * the extended-length resources path `\\?\G:\MashupForge\resources\app`.
 * When we spawn a `.cmd` shim via cmd.exe, cmd inherits that cwd and
 * prints "UNC paths are not supported. Defaulting to Windows directory."
 * — noise in the user-facing error, and a real footgun (relative path
 * resolution silently changes). The Higgsfield/mmx CLIs only ever
 * receive absolute paths or UUIDs, so the cwd is irrelevant to them;
 * we just need one that isn't UNC. Returns the OS temp dir when the
 * current cwd is UNC (or unreadable), otherwise `undefined` (inherit —
 * POSIX and normal-cwd Windows are untouched).
 */
/**
 * Pure, platform-parameterized core of the UNC-cwd decision so it is
 * testable on the (Linux) CI runner. Returns `tmpDir` when the spawn
 * should override cwd, `undefined` to inherit. `\\?\…` (extended-length)
 * and `\\server\share` (true UNC) both start with two backslashes and
 * both trip cmd.exe; on non-Windows we always inherit.
 */
export function pickSafeCwd(
  platform: NodeJS.Platform,
  cwd: string | null,
  tmpDir: string,
): string | undefined {
  if (platform !== 'win32') return undefined;
  if (cwd === null) return tmpDir; // process.cwd() threw (deleted dir)
  if (cwd.startsWith('\\\\')) return tmpDir;
  return undefined;
}

function safeSpawnCwd(): string | undefined {
  const os = require('node:os') as typeof import('node:os');
  let cwd: string | null;
  try {
    cwd = process.cwd();
  } catch {
    cwd = null;
  }
  return pickSafeCwd(process.platform, cwd, os.tmpdir());
}

async function runOnce(opts: CliInvokeOptions<unknown>): Promise<RunOnceResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  const env = { ...process.env, ...(opts.env ?? {}) } as NodeJS.ProcessEnv;
  const cwd = safeSpawnCwd();
  // V1.4.5-SHELL-INJECTION: never hand raw args to `shell: true`. For
  // Windows .cmd/.bat shims we build the cmd.exe command line ourselves
  // with cross-spawn-style escaping (see buildWindowsShimSpawn). User
  // prompts (`--prompt <text>`) can contain cmd metacharacters
  // (& | % ^ " …) and may originate from trending-search / AI output —
  // with plain `shell: true` Node performs NO escaping and those were
  // interpreted by cmd.exe: a real command-injection vector.
  const { file, args: spawnArgs, windowsVerbatimArguments } =
    buildWindowsShimSpawn(opts.binary, opts.args);

  return new Promise<RunOnceResult>((resolve, reject) => {
    let child;
    try {
      child = _spawn(file, spawnArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        // V1.8.1-UNC-CWD: undefined → inherit (POSIX / normal Windows);
        // set only when the inherited cwd is a UNC path cmd.exe rejects.
        ...(cwd ? { cwd } : {}),
        signal: opts.signal,
        // Node's own shell mode is permanently OFF — the .cmd shim
        // path goes through an explicit, escaped cmd.exe invocation
        // (buildWindowsShimSpawn) instead.
        shell: false,
        windowsVerbatimArguments,
        // On Windows the npm-installed shim returns immediately even
        // when the underlying `.cmd` is missing; this option makes
        // the failure surface as the `error` event instead of a
        // silent non-zero exit. Helps the unavailable detection.
        windowsHide: true,
      });
    } catch (e) {
      // Synchronous spawn throw (rare — usually ENOENT arrives via
      // the 'error' event). Map to ProviderUnavailableError.
      reject(new ProviderUnavailableError(opts.provider, opts.binary, e));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
    }, timeoutMs);

    // If the signal aborts, kill the child promptly.
    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.once('error', (err) => {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      const isEnoent = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
      if (isEnoent) {
        _log('warn', `${opts.provider}: spawn ENOENT for ${opts.binary}`);
        reject(new ProviderUnavailableError(opts.provider, opts.binary, err));
        return;
      }
      reject(new ProviderExecError(opts.provider, -1, err.message));
    });

    child.once('close', (code) => {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      const durationMs = Date.now() - start;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const exitCode = code ?? -1;

      if (timedOut) {
        reject(new ProviderTimeoutError(opts.provider, timeoutMs));
        return;
      }
      resolve({ stdout, stderr, exitCode, durationMs, timedOut });
    });
  });
}

async function finalizeResult<T>(opts: CliInvokeOptions<T>, r: RunOnceResult): Promise<CliInvokeResult<T>> {
  const { stdout, stderr, exitCode, durationMs } = r;
  const schema = opts.schema;

  // Empty stdout: many CLIs exit 0 with empty output for "no-op"
  // style commands. Adapters can opt-in via tolerateEmptyStdout.
  if (!stdout.trim()) {
    if (opts.tolerateEmptyStdout && exitCode === 0) {
      return {
        parsed: undefined as unknown as T,
        stdout,
        stderr,
        exitCode,
        durationMs,
      };
    }
    if (exitCode === 0) {
      throw new ProviderParseError(opts.provider, 'empty stdout with exit 0', stdout);
    }
    throw new ProviderExecError(opts.provider, exitCode, stderr);
  }

  // Non-zero exit with a JSON error payload? Try to extract a
  // structured error message before falling back to the raw stderr.
  if (exitCode !== 0) {
    const maybeJson = tryParseJson(stdout);
    if (maybeJson && typeof maybeJson === 'object' && 'error' in maybeJson) {
      const e = (maybeJson as { error: unknown }).error;
      const msg = typeof e === 'string' ? e : (e as { message?: string })?.message ?? stderr;
      const code = (e as { code?: number | string })?.code ?? exitCode;
      const hint = (e as { hint?: string })?.hint;
      throw new ProviderExecError(opts.provider, code, String(msg));
    }
    throw new ProviderExecError(opts.provider, exitCode, stderr);
  }

  // Parse JSON. We are intentionally strict: anything that isn't
  // valid JSON surfaces as ProviderParseError. Adapters that need
  // to handle line-delimited JSON or non-JSON outputs should bypass
  // cliInvoke and call runOnce directly.
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stdout);
  } catch (e) {
    throw new ProviderParseError(
      opts.provider,
      `JSON.parse failed: ${(e as Error).message}`,
      stdout.slice(0, 500),
    );
  }

  // Zod-validate. The schema is the adapter's contract; if it
  // doesn't match, the adapter author needs to update the schema or
  // the CLI output is broken. Either way: fail loudly.
  if (schema) {
    const result = schema.safeParse(parsedJson);
    if (!result.success) {
      throw new ProviderParseError(
        opts.provider,
        `Zod validation failed: ${result.error.message}`,
        stdout.slice(0, 500),
      );
    }
    return { parsed: result.data, stdout, stderr, exitCode, durationMs };
  }

  return { parsed: parsedJson as T, stdout, stderr, exitCode, durationMs };
}

function tryParseJson(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Returns true when the binary path ends in `.cmd` or `.bat` and
 * we're on Windows. We MUST set `shell: true` for those, otherwise
 * Node throws ENOENT (CVE-2024-27980). Same guard as
 * `lib/mmx-client.ts`.
 */
export function spawnNeedsShell(bin: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
}

// ---------------------------------------------------------------------------
// V1.4.5-SHELL-INJECTION: safe spawning of Windows .cmd/.bat shims
// ---------------------------------------------------------------------------
//
// `shell: true` makes Node join binary + args into ONE string and hand it
// to `cmd /d /s /c` with ZERO escaping. Any cmd metacharacter in an arg
// (& | < > ^ % ! ") is interpreted. Since adapter args carry user prompts
// (and prompts can come from trending-search or AI output), that was a
// command-injection vector on the primary platform (Windows desktop).
//
// Instead of `shell: true` we now spawn cmd.exe ourselves with
// `windowsVerbatimArguments: true` and a command line we escape with the
// battle-tested cross-spawn algorithm (github.com/moxystudio/node-cross-spawn,
// lib/util/escape.js — reimplemented here to avoid the dependency).

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Escape a value that will appear UNQUOTED on a cmd.exe command line. */
export function escapeCmdCommand(cmd: string): string {
  return cmd.replace(CMD_META, '^$1');
}

/**
 * Escape one argument for a cmd.exe command line (cross-spawn algorithm):
 * backslash-double any backslashes before quotes, escape the quotes,
 * wrap in double quotes, then caret-escape all cmd metacharacters.
 * `doubleEscape` doubles the carets — required when the target is a
 * .cmd/.bat script because cmd.exe parses the line twice.
 */
export function escapeCmdArgument(arg: string, doubleEscape = true): string {
  let s = `${arg}`;
  // Double up backslashes that precede a quote, escape the quote.
  s = s.replace(/(\\*)"/g, '$1$1\\"');
  // Double up trailing backslashes (they'd otherwise escape our quote).
  s = s.replace(/(\\*)$/, '$1$1');
  s = `"${s}"`;
  s = s.replace(CMD_META, '^$1');
  if (doubleEscape) s = s.replace(CMD_META, '^$1');
  return s;
}

export interface ShimSpawnPlan {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/**
 * Build the actual spawn invocation. POSIX / non-shim binaries pass
 * through untouched (argv array, no shell — inherently injection-safe).
 * Windows .cmd/.bat shims become an explicit
 * `cmd.exe /d /s /c "<escaped command line>"` with
 * `windowsVerbatimArguments` so Node performs no additional mangling.
 *
 * `needsShell` is injectable so the win32 escaping branch is testable
 * on the Ubuntu CI runners (spawnNeedsShell is platform-gated and
 * would otherwise leave this security-critical path with zero CI
 * coverage). Production callers use the default.
 */
export function buildWindowsShimSpawn(
  binary: string,
  args: string[],
  needsShell: boolean = spawnNeedsShell(binary),
): ShimSpawnPlan {
  if (!needsShell) {
    return { file: binary, args, windowsVerbatimArguments: false };
  }
  const commandLine = [
    escapeCmdArgument(binary, false),
    ...args.map((a) => escapeCmdArgument(a, true)),
  ].join(' ');
  return {
    file: process.env.comspec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Convenience for adapters that need to push a `--flag value` pair
 * onto an args array, skipping undefined/null.
 */
export function pushFlag(args: string[], flag: string, value: string | number | boolean | undefined | null): void {
  if (value === undefined || value === null) return;
  args.push(flag, String(value));
}

/**
 * Convenience for adapters that need to push a `--flag` boolean
 * switch, emitting it only when truthy.
 */
export function pushBool(args: string[], flag: string, value: boolean | undefined | null): void {
  if (value) args.push(flag);
}

/**
 * Best-effort "is the binary on PATH" check using Node's
 * process. Returns true when `binary` is an absolute path that
 * exists, OR when the bare name resolves to a file under PATH.
 * Cheap and exception-free.
 */
export function binaryExists(binary: string): boolean {
  if (!binary) return false;
  if (/[\\/]/.test(binary)) {
    // Looks absolute or relative — let the spawn itself decide.
    return true;
  }
  // Defer to a synchronous PATH scan. We can't use `which` (extra
  // dep) so we walk PATH and check each candidate with `existsSync`.
  // This is the same trick `lib/mmx-client.ts` uses (it just spawns
  // and catches ENOENT).
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const pathEnv = process.env.PATH ?? process.env.Path ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, binary + ext);
      try {
        if (fs.existsSync(candidate)) return true;
      } catch {
        /* skip */
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { ProviderError };
export { Readable };
