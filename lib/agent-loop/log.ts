/**
 * v1.2 — Director Route 2.0 step logger.
 *
 * Captures the chronological log of every meaningful event in a
 * `runDirectorLoop` invocation: the initial plan, every model
 * step, every tool call, every tool result, and the terminal
 * finalize. The shape is deliberately small and JSON-serialisable
 * so the Director route can stream the log to the client, the
 * Replay UI (v1.2 backlog) can render it, and the persistence
 * layer can write it through idb-keyval without further
 * transformation.
 *
 * Why a custom Step type and not the SDK's `StepResult<TOOLS>`:
 * the SDK type is generic over the toolset, has dozens of
 * properties, and is optimised for round-tripping through
 * `useChat`. Our log is a flat, audit-friendly record — the same
 * shape the user sees in the Replay UI.
 *
 * Step types:
 *   - `plan`        — initial reasoning, no tool call (idx 0)
 *   - `tool_call`   — model emitted a tool call
 *   - `tool_result` — the tool's execute() returned a value
 *   - `final`       — the model's terminal text (the "final prompt")
 *   - `error`       — loop aborted (budget / step limit / network)
 *
 * Conventions:
 *   - `idx` is 0-based, monotonically increasing, written by the
 *     logger so callers can't misnumber.
 *   - `cost` is USD for that step. `tool_result` is always 0
 *     (the LLM that *triggered* the tool call carries the cost;
 *     persisting the result twice would double-count).
 *   - `input` / `output` are typed as `unknown` because each tool
 *     has its own shape. The persistence layer keeps them
 *     verbatim; the Replay UI narrows by `tool` name.
 */
export type StepType = 'plan' | 'tool_call' | 'tool_result' | 'final' | 'error';

export interface Step {
  /** 0-based, monotonically increasing. Written by the logger. */
  idx: number;
  type: StepType;
  /** Set on `tool_call` and `tool_result`. */
  tool?: string;
  /** Tool call input. Serialised verbatim (model can emit anything). */
  input?: unknown;
  /** Tool execution result. `unknown` because each tool has its own shape. */
  output?: unknown;
  /** Free-form reasoning — model's natural-language text or error message. */
  reasoning?: string;
  /** Cost in USD for this step. Tool results and plan step are 0. */
  cost: number;
  /** Epoch ms when the step was recorded. */
  timestamp: number;
  /** Optional: how long the step took (LLM round-trip, tool execution). */
  durationMs?: number;
}

/**
 * Mutable in-memory accumulator for the Director loop. The
 * `append` method stamps the `idx` field, so the caller never
 * has to track the counter. `getAll` returns a readonly view so
 * the loop caller can pass the result around without worrying
 * about later mutations.
 *
 * For tests, the constructor takes an optional `clock` and
 * `idProvider` so deterministic timestamps and run ids are
 * possible without monkey-patching Date.
 */
export class StepLogger {
  private readonly steps: Step[] = [];
  private readonly clock: () => number;

  constructor(opts: { clock?: () => number } = {}) {
    this.clock = opts.clock ?? (() => Date.now());
  }

  /**
   * Record a step. The `idx` field on the input is overwritten
   * with the current length of the log. Returns the
   * stored-canonical record.
   */
  append(step: Omit<Step, 'idx'>): Step {
    const full: Step = { ...step, idx: this.steps.length };
    this.steps.push(full);
    return full;
  }

  /** Read-only view of the chronological log. */
  getAll(): readonly Step[] {
    return this.steps;
  }

  /** Sum of `cost` across every step. */
  totalCost(): number {
    return this.steps.reduce((sum, s) => sum + (s.cost || 0), 0);
  }

  /** Number of steps recorded so far. */
  size(): number {
    return this.steps.length;
  }
}

/**
 * Cap the size of large payloads before they hit the log. The
 * model occasionally returns a 5KB trending search result; we
 * truncate the in-memory copy to keep the JSON export
 * readable. The full payload still lives in the tool result
 * (and in the persistence layer if it's wired up).
 */
const MAX_LOG_PAYLOAD_CHARS = 4000;

export function truncateForLog(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > MAX_LOG_PAYLOAD_CHARS
      ? `${value.slice(0, MAX_LOG_PAYLOAD_CHARS)}…[truncated ${value.length - MAX_LOG_PAYLOAD_CHARS} chars]`
      : value;
  }
  if (Array.isArray(value)) {
    return value.map(truncateForLog);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateForLog(v);
    }
    return out;
  }
  return value;
}
