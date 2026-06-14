/**
 * MMX CLI client — typed wrapper around MiniMax's `mmx` binary.
 *
 * @deprecated 2026-06-02. Multimodal (image/music/video/speech/describe)
 * still flows through this module and the matching /api/mmx/* routes, so
 * the file is kept. The text-generation half of mmx was replaced by
 * 'nca' on 2026-05-02 (NCA-INTEGRATION-DEV) and then by the vercel-ai
 * route on 2026-06-02 (LLM-INTEGRATION-0513 + 0513-CONSOLIDATION).
 * New code should reach for the vercel-ai /api/ai/prompt path
 * instead of spawning mmx for text. Multimodal mmx usage is unchanged
 * — the MmxImageOptions type is still consumed by
 * `lib/image-prompt-builder.ts` (Leonardo path reads `.leonardo`, the
 * mmx image route reads `.mmx`).
 *
 * Runs each command as a one-shot child process with `--output json`, parses
 * the result, and surfaces structured errors. We always use spawn() with an
 * argument array (never a shell string) so user-supplied prompts and queries
 * cannot be interpreted as shell metacharacters — important because every
 * caller of these helpers eventually feeds in user-controlled text.
 *
 * Configuration:
 *   - MMX_BIN  (env)  override the binary path. Default: "mmx" (PATH lookup).
 *   - MMX_API_KEY / MINIMAX_API_KEY (env) consumed by mmx itself; we just pass
 *     environment through. We never accept an api-key argument from callers.
 *
 * NOT done in this module:
 *   - Caching, retries, rate limiting — caller's responsibility.
 *   - Public-asset wiring of file outputs (music, speech, video) — caller
 *     decides where to write and how to expose.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { spawn as SpawnFn } from 'node:child_process';

// BUGFIX 2026-04-30: previously captured `process.env.MMX_BIN ?? 'mmx'` at
// module-load time, which made post-install mutation of process.env.MMX_BIN
// (done by /api/mmx/setup after running `npm install -g mmx-cli`) a no-op.
// Read dynamically so an absolute path written by the setup route — e.g.
// `C:\Users\…\AppData\Roaming\npm\mmx.cmd` on Windows — is honoured on the
// very next call without re-importing the module.
function mmxBin(): string {
  return process.env.MMX_BIN || 'mmx';
}

// BUGFIX 2026-04-30: when MMX_BIN points at a Windows .cmd shim (which is
// what `npm install -g mmx-cli` produces — `C:\Users\…\AppData\Roaming\npm\mmx.cmd`),
// `child_process.spawn(bin, args)` fails without `shell: true`. Node 16+
// enforces this strictly per CVE-2024-27980 (no implicit cmd.exe wrap for
// .cmd / .bat). Without this, every isAvailable() probe returned false on
// Windows even after a successful install — the symptom Maurice reported as
// "npm install -g mmx-cli reported success but mmx is still not runnable".
//
// Trade-off: shell:true means args are joined into a command string the
// shell parses, so shell metacharacters in args become a real risk. mmx
// arg arrays are constructed via pushFlag/pushBool with controlled flag
// names, so the only attacker-influenced inputs are user-supplied prompts
// (--prompt <text>). Since this is a desktop app where the user is the
// only prompt source, the shell-metachar risk is bounded to self-injection.
// If we ever expose mmx behind a shared service, switch to spawning
// `cmd.exe /d /s /c <bin>` with manual quoting instead.
function spawnNeedsShell(bin: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
}

// Test-injection seam. The default is the real node:child_process.spawn;
// tests replace it via {@link __setSpawnForTests} to avoid invoking the
// real mmx binary. Keeping the seam in the module is more robust than
// vi.mock('node:child_process') across vitest's varying behavior with
// built-in modules under jsdom.
let _spawn: typeof SpawnFn = nodeSpawn;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MmxError extends Error {
  constructor(
    public readonly code: number | string,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'MmxError';
  }
}

/**
 * Thrown when the user's MiniMax Token Plan does not include the requested
 * model (e.g. image-01 on a non-Plus plan). Callers — especially image gen —
 * should treat this as "MMX unavailable, try the fallback provider", not as
 * a generic failure.
 */
export class MmxQuotaError extends MmxError {
  constructor(message: string, hint?: string) {
    super(4, message, hint);
    this.name = 'MmxQuotaError';
  }
}

/** Thrown when the binary itself cannot be spawned (not installed, ENOENT). */
export class MmxSpawnError extends MmxError {
  constructor(message: string) {
    super('SPAWN', message);
    this.name = 'MmxSpawnError';
  }
}

// ---------------------------------------------------------------------------
// Run helpers
// ---------------------------------------------------------------------------

export interface MmxRunOptions {
  /** Hard timeout. Process is SIGTERM'd if exceeded. Default: 5 minutes. */
  timeoutMs?: number;
  /** Abort signal. Aborting kills the in-flight subprocess. */
  signal?: AbortSignal;
}

interface MmxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runMmx(args: string[], opts: MmxRunOptions = {}): Promise<MmxRunResult> {
  return new Promise((resolve, reject) => {
    const bin = mmxBin();
    const child = _spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: opts.signal,
      shell: spawnNeedsShell(bin),
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    child.once('error', (err) => {
      clearTimeout(timer);
      reject(new MmxSpawnError(`failed to spawn ${mmxBin()}: ${err.message}`));
    });

    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: code ?? -1,
      });
    });
  });
}

interface MmxJsonError {
  code?: number | string;
  message?: string;
  hint?: string;
}

/**
 * Run mmx with --output json prepended; parse stdout and surface structured
 * errors. Throws {@link MmxQuotaError} for plan-restriction errors so callers
 * can choose to fall back to a different provider rather than re-throw.
 */
async function runMmxJson<T>(args: string[], opts: MmxRunOptions = {}): Promise<T> {
  const fullArgs = ['--output', 'json', ...args];
  const result = await runMmx(fullArgs, opts);

  let parsed: unknown;
  if (result.stdout.trim()) {
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new MmxError(
        'PARSE',
        `mmx returned non-JSON output (exit ${result.exitCode}): ${result.stdout.slice(0, 200)}`,
      );
    }
  }

  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    const err = (parsed as { error: MmxJsonError }).error;
    const code = err.code ?? 'UNKNOWN';
    const msg = err.message ?? 'mmx error';
    const hint = err.hint;
    if (code === 4 || /token plan|not support|requires the Plus plan/i.test(msg)) {
      throw new MmxQuotaError(msg, hint);
    }
    throw new MmxError(code, msg, hint);
  }

  if (result.exitCode !== 0) {
    throw new MmxError(
      result.exitCode,
      `mmx exited ${result.exitCode}: ${result.stderr.trim() || 'no stderr'}`,
    );
  }

  // QA-W1: empty stdout + exit 0 fell through to `parsed as T` and silently
  // returned undefined. Callers that destructure (e.g. const { url } = ...)
  // hit a TypeError far from the source. Surface it as a parse error here.
  if (parsed === undefined) {
    throw new MmxError(
      'PARSE',
      `mmx returned empty output (exit ${result.exitCode})`,
    );
  }

  return parsed as T;
}

// Push --flag / --flag <value> pairs onto an args array, skipping undefined.
function pushFlag(args: string[], flag: string, value: string | number | undefined): void {
  if (value === undefined) return;
  args.push(flag, String(value));
}
function pushBool(args: string[], flag: string, value: boolean | undefined): void {
  if (value) args.push(flag);
}

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

export interface MmxImageOptions {
  aspectRatio?: string;
  n?: number;
  seed?: number;
  width?: number;
  height?: number;
  promptOptimizer?: boolean;
  aigcWatermark?: boolean;
  responseFormat?: 'url' | 'base64';
  outDir?: string;
  outPrefix?: string;
}

export interface MmxImageResult {
  /** Image URLs when responseFormat is "url" (default) or unspecified. */
  urls: string[];
  /** Local file paths when --out / --out-dir was requested. */
  files: string[];
  /** Base64-encoded payloads when responseFormat is "base64". */
  base64: string[];
}

interface MmxImageJsonResponse {
  data?: { image_urls?: string[]; image_base64?: string[] };
  // Some mmx versions surface saved file paths under output_files; we tolerate either shape.
  output_files?: string[];
  files?: string[];
  // Fallback shapes — accept whatever the CLI emits and pick what we can.
  urls?: string[];
}

export async function generateImage(
  prompt: string,
  opts: MmxImageOptions = {},
  runOpts?: MmxRunOptions,
): Promise<MmxImageResult> {
  const args = ['image', 'generate', '--prompt', prompt];
  pushFlag(args, '--aspect-ratio', opts.aspectRatio);
  pushFlag(args, '--n', opts.n);
  pushFlag(args, '--seed', opts.seed);
  pushFlag(args, '--width', opts.width);
  pushFlag(args, '--height', opts.height);
  pushBool(args, '--prompt-optimizer', opts.promptOptimizer);
  pushBool(args, '--aigc-watermark', opts.aigcWatermark);
  pushFlag(args, '--response-format', opts.responseFormat);
  pushFlag(args, '--out-dir', opts.outDir);
  pushFlag(args, '--out-prefix', opts.outPrefix);

  const json = await runMmxJson<MmxImageJsonResponse>(args, runOpts);
  return {
    urls: json.data?.image_urls ?? json.urls ?? [],
    files: json.output_files ?? json.files ?? [],
    base64: json.data?.image_base64 ?? [],
  };
}

// ---------------------------------------------------------------------------
// Music generation
// ---------------------------------------------------------------------------

export interface MmxMusicOptions {
  lyrics?: string;
  instrumental?: boolean;
  lyricsOptimizer?: boolean;
  vocals?: string;
  genre?: string;
  mood?: string;
  instruments?: string;
  tempo?: string;
  bpm?: number;
  key?: string;
  avoid?: string;
  useCase?: string;
  structure?: string;
  out?: string;
}

export interface MmxMusicResult {
  /** Saved file path if --out was supplied. */
  path?: string;
  /** Raw response payload for callers that want the URL or audio bytes ref. */
  raw: unknown;
}

export async function generateMusic(
  prompt: string,
  opts: MmxMusicOptions = {},
  runOpts?: MmxRunOptions,
): Promise<MmxMusicResult> {
  if (opts.lyricsOptimizer && (opts.lyrics || opts.instrumental)) {
    throw new MmxError(
      'INVALID',
      'lyricsOptimizer cannot be combined with lyrics or instrumental',
    );
  }
  if (opts.instrumental && opts.lyrics) {
    throw new MmxError('INVALID', 'instrumental cannot be combined with lyrics');
  }

  const args = ['music', 'generate', '--prompt', prompt];
  pushFlag(args, '--lyrics', opts.lyrics);
  pushBool(args, '--instrumental', opts.instrumental);
  pushBool(args, '--lyrics-optimizer', opts.lyricsOptimizer);
  pushFlag(args, '--vocals', opts.vocals);
  pushFlag(args, '--genre', opts.genre);
  pushFlag(args, '--mood', opts.mood);
  pushFlag(args, '--instruments', opts.instruments);
  pushFlag(args, '--tempo', opts.tempo);
  pushFlag(args, '--bpm', opts.bpm);
  pushFlag(args, '--key', opts.key);
  pushFlag(args, '--avoid', opts.avoid);
  pushFlag(args, '--use-case', opts.useCase);
  pushFlag(args, '--structure', opts.structure);
  pushFlag(args, '--out', opts.out);

  const json = await runMmxJson<{ output_file?: string; path?: string }>(args, runOpts);
  return { path: json.output_file ?? json.path ?? opts.out, raw: json };
}

// ---------------------------------------------------------------------------
// Video generation
// ---------------------------------------------------------------------------

export interface MmxVideoOptions {
  model?: string;
  firstFrame?: string;
  lastFrame?: string;
  subjectImage?: string;
  callbackUrl?: string;
  download?: string;
  /** Don't wait for completion — return the task id immediately. */
  noWait?: boolean;
  pollIntervalSeconds?: number;
}

export interface MmxVideoResult {
  /** Set when --no-wait is used (or when mmx returns one before completion). */
  taskId?: string;
  /** Local file path if --download was supplied AND the task completed. */
  path?: string;
  raw: unknown;
}

interface MmxVideoJsonResponse {
  task_id?: string;
  taskId?: string;
  output_file?: string;
  path?: string;
}

export async function generateVideo(
  prompt: string,
  opts: MmxVideoOptions = {},
  runOpts?: MmxRunOptions,
): Promise<MmxVideoResult> {
  const args = ['video', 'generate', '--prompt', prompt];
  pushFlag(args, '--model', opts.model);
  pushFlag(args, '--first-frame', opts.firstFrame);
  pushFlag(args, '--last-frame', opts.lastFrame);
  pushFlag(args, '--subject-image', opts.subjectImage);
  pushFlag(args, '--callback-url', opts.callbackUrl);
  pushFlag(args, '--download', opts.download);
  pushBool(args, '--no-wait', opts.noWait);
  pushFlag(args, '--poll-interval', opts.pollIntervalSeconds);

  const json = await runMmxJson<MmxVideoJsonResponse>(args, runOpts);
  return {
    taskId: json.task_id ?? json.taskId,
    path: json.output_file ?? json.path ?? opts.download,
    raw: json,
  };
}

// ---------------------------------------------------------------------------
// Speech synthesis
// ---------------------------------------------------------------------------

export interface MmxSpeechOptions {
  model?: string;
  voice?: string;
  speed?: number;
  volume?: number;
  pitch?: number;
  format?: string;
  sampleRate?: number;
  bitrate?: number;
  channels?: number;
  language?: string;
  subtitles?: boolean;
  out?: string;
}

export interface MmxSpeechResult {
  path?: string;
  raw: unknown;
}

export async function synthesizeSpeech(
  text: string,
  opts: MmxSpeechOptions = {},
  runOpts?: MmxRunOptions,
): Promise<MmxSpeechResult> {
  const args = ['speech', 'synthesize', '--text', text];
  pushFlag(args, '--model', opts.model);
  pushFlag(args, '--voice', opts.voice);
  pushFlag(args, '--speed', opts.speed);
  pushFlag(args, '--volume', opts.volume);
  pushFlag(args, '--pitch', opts.pitch);
  pushFlag(args, '--format', opts.format);
  pushFlag(args, '--sample-rate', opts.sampleRate);
  pushFlag(args, '--bitrate', opts.bitrate);
  pushFlag(args, '--channels', opts.channels);
  pushFlag(args, '--language', opts.language);
  pushBool(args, '--subtitles', opts.subtitles);
  pushFlag(args, '--out', opts.out);

  const json = await runMmxJson<{ output_file?: string; path?: string }>(args, runOpts);
  return { path: json.output_file ?? json.path ?? opts.out, raw: json };
}

// ---------------------------------------------------------------------------
// Vision (image describe)
// ---------------------------------------------------------------------------

export interface MmxVisionOptions {
  /** Question about the image. Default: "Describe the image." */
  prompt?: string;
}

export interface MmxVisionResult {
  description: string;
  raw: unknown;
}

interface MmxVisionJsonResponse {
  description?: string;
  text?: string;
  data?: { description?: string; text?: string };
}

/**
 * Describe an image. Pass either a local file path / URL via `imageOrFileId`
 * (mmx auto base64-encodes local files) OR pass `{fileId: "..."}` to use a
 * pre-uploaded MiniMax file ID.
 */
export async function describeImage(
  source: { image: string } | { fileId: string },
  opts: MmxVisionOptions = {},
  runOpts?: MmxRunOptions,
): Promise<MmxVisionResult> {
  const args = ['vision', 'describe'];
  if ('image' in source) {
    args.push('--image', source.image);
  } else {
    args.push('--file-id', source.fileId);
  }
  pushFlag(args, '--prompt', opts.prompt);

  const json = await runMmxJson<MmxVisionJsonResponse>(args, runOpts);
  const description = json.description ?? json.text ?? json.data?.description ?? json.data?.text ?? '';
  return { description, raw: json };
}

// ---------------------------------------------------------------------------
// Web search
// ---------------------------------------------------------------------------
//
// CAMOFOX-CAMOUFOX-1.1.0 (2026-06-06): the `webSearch()` function and
// its `MmxSearchResult` / `MmxSearchJsonResponse` types are REMOVED
// in v1.1.0. No production code called them (the trending-enrichment
// loop in `app/api/{pi,mmx,nca,ai}/prompt/route.ts` uses
// `@/lib/web-search` directly), and the only test that exercised
// them was `tests/lib/mmx-client.test.ts`, which is also updated.
// The web-search path now lives in `lib/camofox/client.ts` (camofox
// sidecar) with `lib/web-search.ts` (DDG/Brave) as the fallback.
//
// If mmx ever grows a real web-search product feature (e.g. an
// mmx-native trend discovery), add it back as a new function with
// a different name to avoid collision with the deleted symbol.

// ---------------------------------------------------------------------------
// Health / availability
// ---------------------------------------------------------------------------

/**
 * Probe whether mmx is callable in the current environment. Cheap: shells out
 * to `mmx --version` with a 5s timeout and reports back. Use this to gate UI
 * affordances (the music button, etc.) instead of catching exceptions inside
 * a hot path.
 */
export async function isAvailable(): Promise<boolean> {
  try {
    const result = await runMmx(['--version'], { timeoutMs: 5000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

// M3.3-P3 commit b: the text-prompt block (MmxPromptOptions + the
// `prompt` async generator + the parseStreamLine / extractTextFromResponse
// helpers + the MmxMessage interface) was the mmx chat path that
// routed /api/mmx/prompt. The default-flip in commit a locked every
// client-side call to /api/ai/prompt, so this whole block is dead.
// The multimodal helpers above (image / music / video / speech /
// describe) and the isAvailable / isAuthenticated / spawn-mock
// test hooks below stay — those are the 8 mmx routes that
// /api/mmx/{image,video,music,speech,describe,setup,status,availability}
// still depend on.

/**
 * MMX-AVAILABILITY: cheap auth check used by the AI Agent settings tab
 * and the streamAI router. mmx itself reads MMX_API_KEY / MINIMAX_API_KEY
 * from env (the desktop wrapper hydrates them from config.json), so
 * the presence of either is a reasonable proxy for "mmx can call out".
 */
export function isAuthenticated(): boolean {
  return Boolean(
    (process.env.MMX_API_KEY && process.env.MMX_API_KEY.trim()) ||
      (process.env.MINIMAX_API_KEY && process.env.MINIMAX_API_KEY.trim()),
  );
}

// Test-only: replace the spawn implementation. Pass `null` to restore the
// default `node:child_process.spawn`. Not part of the public API.
export function __setSpawnForTests(fn: typeof SpawnFn | null): void {
  _spawn = fn ?? nodeSpawn;
}

// Test-only export so unit tests can construct args without re-implementing
// pushFlag / pushBool. Not part of the public API.
export const __test = { runMmx, runMmxJson };
