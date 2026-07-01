/**
 * Story 2.8 Tool Registry — `show_reference_elements` (READ-ONLY).
 *
 * The agent's live, agent-driven canon lookup. Character identity is no longer
 * hardcoded — before drawing a recurring character the agent calls this tool to
 * resolve the character's CURRENT Higgsfield reference Element (its id AND its
 * `description`, which IS the live lore). Two actions:
 *   - `list` → paged reference Elements, optionally client-side name-filtered;
 *   - `get`  → one Element by id.
 *
 * Governance (Story 2.8 §6):
 *   - READ-ONLY: the schema admits only `list`/`get`; `create` (a real WRITE to
 *     the operator's authoritative Element store) is hard-rejected at the wrapper
 *     boundary BEFORE any MCP connect. This file never touches the approval gate.
 *   - It reaches Higgsfield ONLY via the operator's per-request connector from the
 *     RunContext (never a raw passthrough of the connector to the model).
 *   - STRUCTURAL ANCHOR: when the tool resolves EXACTLY ONE element (a single
 *     `list` name match, or an explicit `get`) it records `{ characterId →
 *     { elementId, name } }` on `ctx.resolvedElements`. That memo — NOT any
 *     `<<<id>>>` the model types — is what the credit-spend path anchors to. An
 *     ambiguous (>1) `list` writes NOTHING, so an unresolved/ambiguous character
 *     structurally cannot reach a spend (the spend path fails safe).
 */

import { tool } from 'ai';
import { z } from 'zod';
import {
  ToolNotAvailableError,
  ToolExecutionError,
  safeExecute,
  type ToolResult,
} from './errors';
import { currentRunContext, type RunContext } from '@/lib/agent-loop/run-context';
import type { CharacterId } from '@/lib/canon';
import {
  listReferenceElements,
  getReferenceElement,
  type ReferenceElement,
} from '@/lib/higgsfield/elements';

// ---------------------------------------------------------------------------
// Zod schemas — action constrained to list|get ONLY (create is absent by design)
// ---------------------------------------------------------------------------

export const zShowReferenceElementsInput = z
  .object({
    action: z.enum(['list', 'get']),
    /**
     * Which character this resolution is for. When a single element is resolved,
     * it is written to the RunContext memo under this key (defaults to the run's
     * active character). Anchoring at spend time reads that memo.
     */
    characterId: z.string().optional(),
    /** action='get': the element id to fetch (and resolve). */
    elementId: z.string().uuid().optional(),
    /** action='list': case-insensitive SUBSTRING name filter, applied client-side. */
    nameFilter: z.string().optional(),
    /** action='list': pagination cursor (a number — the prev response's next_cursor). */
    cursor: z.number().optional(),
    /** action='list': page size (1-100). */
    size: z.number().int().min(1).max(100).optional(),
  })
  .refine((d) => d.action === 'list' || (d.action === 'get' && !!d.elementId), {
    message: 'action="get" requires elementId',
  });
export type ShowReferenceElementsInput = z.infer<typeof zShowReferenceElementsInput>;

const zReferenceElementOut = z
  .object({
    id: z.string(),
    name: z.string(),
    category: z.string().optional(),
    description: z.string().optional(),
    createdAt: z.number().optional(),
    imageUrl: z.string().optional(),
  })
  .passthrough();

export const zShowReferenceElementsOutput = z.union([
  z.object({ action: z.literal('get'), element: zReferenceElementOut }),
  z.object({
    action: z.literal('list'),
    elements: z.array(zReferenceElementOut),
    count: z.number().int().min(0),
    /** True when a name filter matched more than one element — pick consciously via `get`. */
    ambiguous: z.boolean(),
    /** True when exactly one element was resolved AND written to the RunContext memo. */
    resolved: z.boolean(),
  }),
]);
export type ShowReferenceElementsOutput = z.infer<typeof zShowReferenceElementsOutput>;

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/** Write a single resolved element to the per-turn keyed memo (the spend anchor source). */
function writeResolvedElement(ctx: RunContext, characterId: CharacterId, el: ReferenceElement): void {
  if (!ctx.resolvedElements) ctx.resolvedElements = new Map();
  ctx.resolvedElements.set(characterId, { elementId: el.id, name: el.name });
}

export async function executeShowReferenceElements(
  rawInput: unknown,
  opts: { signal?: AbortSignal } = {},
): Promise<ToolResult<ShowReferenceElementsOutput>> {
  return safeExecute(async () => {
    // Parse FIRST — a malformed input (or a `create`/unknown action the schema
    // rejects) is refused here, BEFORE we ever touch the connector.
    const parsed = zShowReferenceElementsInput.safeParse(rawInput);
    if (!parsed.success) throw parsed.error;
    const input = parsed.data;

    // READ-ONLY invariant (defensive belt-and-braces on top of the Zod enum): a
    // future schema slip must NOT be able to smuggle a canon-mutating write to
    // the connector. Any action other than list/get stops here, before connect.
    if (input.action !== 'list' && input.action !== 'get') {
      throw new ToolExecutionError(
        'show_reference_elements',
        `action "${(input as { action: string }).action}" is not allowed — this tool is read-only (list/get).`,
        { retryable: false },
      );
    }

    const ctx = currentRunContext();
    if (!ctx || !ctx.higgsfieldConnector) {
      throw new ToolNotAvailableError(
        'show_reference_elements',
        'No Higgsfield connector configured — add one in Customize (the chat client '
          + "must include the operator's enabled+trusted Higgsfield connector in the request).",
      );
    }
    const connector = ctx.higgsfieldConnector;
    const memoKey = (input.characterId ?? ctx.characterId) as CharacterId | undefined;

    try {
      if (input.action === 'get') {
        const element = await getReferenceElement({
          connector,
          elementId: input.elementId!,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        if (!element) {
          throw new ToolExecutionError(
            'show_reference_elements',
            `no reference element with id ${input.elementId}`,
            { retryable: false },
          );
        }
        if (memoKey) writeResolvedElement(ctx, memoKey, element);
        return zShowReferenceElementsOutput.parse({ action: 'get', element });
      }

      // action === 'list' — page (bounded) and name-filter client-side (there is
      // no server-side name filter). No filter → a single page (browse).
      const needle = (input.nameFilter ?? '').trim().toLowerCase();
      const size = input.size ?? 50;
      const maxPages = needle ? 6 : 1;
      const collected: ReferenceElement[] = [];
      let cursor: number | undefined = input.cursor;
      for (let page = 0; page < maxPages; page++) {
        const { items, nextCursor } = await listReferenceElements({
          connector,
          size,
          ...(cursor != null ? { cursor } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        for (const el of items) {
          if (!needle || el.name.toLowerCase().includes(needle)) collected.push(el);
        }
        if (nextCursor == null || nextCursor === cursor) break;
        cursor = nextCursor;
      }

      // Resolve ONLY on an unambiguous single name match — an ambiguous (>1) set
      // writes nothing, so the spend path fails safe and the agent must pick
      // consciously (read the descriptions, then `get` the right id).
      let resolved = false;
      if (needle && collected.length === 1 && memoKey) {
        writeResolvedElement(ctx, memoKey, collected[0]);
        resolved = true;
      }
      return zShowReferenceElementsOutput.parse({
        action: 'list',
        elements: collected,
        count: collected.length,
        ambiguous: needle ? collected.length > 1 : false,
        resolved,
      });
    } catch (e) {
      if (e instanceof ToolNotAvailableError || e instanceof ToolExecutionError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new ToolExecutionError('show_reference_elements', msg, { retryable: true, cause: e });
    }
  });
}

// ---------------------------------------------------------------------------
// Vercel AI SDK `tool()` definition
// ---------------------------------------------------------------------------

export const showReferenceElementsTool = tool({
  description:
    'READ-ONLY lookup of the operator\'s Higgsfield reference Elements (reusable characters). '
    + 'Call this BEFORE drawing any recurring character to resolve its CURRENT canonical Element — '
    + 'the Element `description` IS the character\'s live canon (locked look, hard rules), always prefer it over memory. '
    + 'action="list" (optionally with a nameFilter) returns candidate Elements; read their descriptions to find the current one '
    + '(its description says "Use <<<this-id>>> ... Supersedes ..."). action="get" fetches one Element by id and locks it in as the '
    + 'anchor for this turn. If a list returns MORE THAN ONE match, do not guess — read the descriptions and `get` the right one, or ask the operator. '
    + 'Spends no credits and never creates or edits Elements.',
  inputSchema: zShowReferenceElementsInput,
  outputSchema: zShowReferenceElementsOutput,
  execute: async (input, options) => {
    const result = await executeShowReferenceElements(input, {
      signal: options?.abortSignal,
    });
    if (!result.ok) throw result.error;
    return result.value;
  },
});
