/**
 * Story 10.5 — history compaction (token-budgeted sliding-window).
 *
 * Long multi-turn sessions eventually assemble a `messages[]` that would
 * overflow the model's context window and hard-fail the turn. This pure helper
 * trims the OLDEST conversation turns so the assembled context stays within
 * budget, while ALWAYS keeping the most recent operator intent (FR-1 / AC1).
 *
 * Why sliding-window (not summary): the IDENTITY-LOCK + APPROVAL state does NOT
 * live in the message history — the canon identity / hard rules / Element-anchor
 * token are in the `system` block (rebuilt every turn by `buildSystem`, never
 * part of `messages`), and the active character / Higgsfield connector / approval
 * state live in the request-scoped `RunContext` singleton, read by the tools via
 * `currentRunContext()`. So dropping old messages cannot change identity-lock or
 * approval behaviour (AC3). A window is also deterministic, adds no mid-turn LLM
 * call, and can never itself fail a turn.
 *
 * KNOWN LIMITATION (inherent to any window; documented, not a bug): a produced
 * asset URL returned in an OLD tool-result message can age out of the window, so
 * a much-later "reframe/animate that image" may lose the URL. This only bites in
 * very long sessions (past the context budget, ~hundreds of turns) and is
 * strictly better than the alternative (overflow → the whole turn hard-fails).
 * Preserving recent asset-bearing tool-results is a deliberate future enhancement.
 *
 * PROVIDER-VALIDITY INVARIANT: the returned slice never BEGINS with a `tool`
 * (tool-result) message — a tool-result must follow the assistant tool-call that
 * produced it, so a leading orphan is an invalid chat-completions payload. This
 * holds on every path (fits, over-budget, and malformed input).
 *
 * PURE: no I/O, no LLM. Returns the SAME array reference unchanged when a
 * well-formed history already fits (AC2 — byte-for-byte parity for short convos).
 */
import type { ModelMessage } from 'ai';

export interface CompactOptions {
  /** The active model's context window in tokens (e.g. MiniMax-M3 = 128_000). */
  contextWindowTokens: number;
  /** Tokens to reserve for the model's response + tool outputs (≈ the model's
   *  defaultMaxTokens). Kept free so the reply isn't starved. */
  reserveTokens: number;
  /** Pre-computed token estimate of the `system` block (passed separately to
   *  streamText — it is NOT part of `messages` and is never trimmed here). */
  systemTokens: number;
  /** Token estimator. Defaults to a chars/4 heuristic; injectable for tests. */
  estimateTokens?: (text: string) => number;
}

/** Default rough token estimate: ~4 chars per token. Deliberately cheap and
 *  provider-agnostic; a slight over/under-estimate only shifts the trim point. */
const defaultEstimate = (text: string): number => Math.ceil(text.length / 4);

/** A stable text projection of a message for size estimation. `content` is
 *  `string | ContentBlock[]`; stringify the structured form so tool-calls and
 *  tool-results are counted too. */
function messageText(m: ModelMessage): string {
  const content = (m as { content?: unknown }).content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

/** Drop a leading run of `tool`-role messages. A tool-result with no preceding
 *  assistant tool-call in the slice is an invalid chat-completions payload; this
 *  enforces the provider-validity invariant on the degenerate/malformed paths. */
function dropLeadingOrphanTools(msgs: ModelMessage[]): ModelMessage[] {
  let i = 0;
  while (i < msgs.length && msgs[i].role === 'tool') i++;
  return i === 0 ? msgs : msgs.slice(i);
}

/**
 * Token-budgeted sliding-window compaction over a conversation history.
 *
 * - Empty input → returned as-is (the caller owns the "empty history" guard).
 * - A well-formed history that already fits (or has ≤ 1 message) → the SAME
 *   reference, unchanged (AC2).
 * - Over budget → keep the NEWEST messages until the token budget
 *   (`contextWindow − reserve − system`) is spent, always retaining the last
 *   message (operator intent, AC1), then snap the slice START to the first
 *   `user` message so it never begins with an orphaned `tool` result.
 * - The `system` block is never counted-in for trimming (only `systemTokens`).
 */
export function compactMessages(messages: ModelMessage[], opts: CompactOptions): ModelMessage[] {
  if (messages.length === 0) return messages;

  const estimate = opts.estimateTokens ?? defaultEstimate;
  const available = opts.contextWindowTokens - opts.reserveTokens - opts.systemTokens;
  const tokensOf = (m: ModelMessage): number => estimate(messageText(m));
  const total = messages.reduce((sum, m) => sum + tokensOf(m), 0);

  const fitsBudget = messages.length <= 1 || total <= available;

  // AC2: a well-formed history that already fits → identical array, no change.
  if (fitsBudget && messages[0].role !== 'tool') return messages;
  // Fits but malformed (leading tool) → just clean the leading orphan.
  if (fitsBudget) return dropLeadingOrphanTools(messages);

  // Over budget: accumulate newest-first until the budget is spent. The newest
  // message is always kept (even if it alone exceeds `available`).
  const kept: ModelMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = tokensOf(messages[i]);
    if (kept.length > 0 && used + t > available) break;
    kept.unshift(messages[i]);
    used += t;
  }

  // A valid conversation slice starts at a `user` turn — never at a dangling
  // `tool` result or an assistant whose paired result was dropped.
  const firstUser = kept.findIndex((m) => m.role === 'user');
  if (firstUser >= 0) return kept.slice(firstUser);

  // No `user` survived the raw window — operator intent must be present, so fall
  // back to the last user message in the whole history.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return [messages[i]];
  }
  // No user message anywhere (degenerate/malformed) — never lead with a tool.
  return dropLeadingOrphanTools(kept);
}
