/**
 * Shared Higgsfield reference-Element core (framework-free) — Story 2.8.
 *
 * Character canon is resolved LIVE from the operator's Higgsfield workspace
 * instead of hardcoded records. This module is the single MCP-facing source of
 * truth for READ-ONLY reference-element lookups, mirroring the submit/poll split
 * in `generate.ts`. Three consumers share it so they can't drift:
 *   - the `show_reference_elements` agent tool (the agent's live lookup),
 *   - `GET /api/canon/element` (the client Canon-panel rail),
 *   - `/api/ai/prompt` caption/idea/enhance (server-side persona resolve).
 *
 * READ-ONLY by construction: only `list` + `get` are ever sent to the connector.
 * `create` (a real WRITE to the operator's authoritative Element store) is NEVER
 * issued from here — the agent tool's schema also forbids it (Story 2.8 §6).
 *
 * Confirmed live contract (`show_reference_elements`, verified against the
 * deployed server 2026-07-01):
 *   - list : args `{ action:'list', cursor?:number, size?:int(1..100) }` →
 *            `{ items: Element[], next_cursor: number|null }`, ordered created_at DESC.
 *   - get  : args `{ action:'get', element_id:string }` →
 *            `{ items: [Element], next_cursor: null }` (SAME envelope, one item).
 *   - Element = `{ id, name, category, description, status, medias[], created_at }`.
 *   - There is NO server-side name filter — name matching is client-side over pages.
 */

import { callMcpTool, connectMcp } from '@/lib/mcp';
import type { McpServerConfig } from '@/lib/mcp';
import { unwrapToolPayload } from './generate';

/** The read-only reference-element tool slug advertised by the Higgsfield MCP server. */
export const SHOW_REFERENCE_ELEMENTS_TOOL = 'show_reference_elements';

export interface ReferenceElement {
  id: string;
  name: string;
  category?: string;
  /** Free-text lore — the live, authoritative canon for this character. */
  description?: string;
  /** Unix seconds (float). The list is created_at DESC, so newer elements come first. */
  createdAt?: number;
  /** `medias[0].url` — the locked reference image (convenience for the client rail). */
  imageUrl?: string;
}

export interface ReferenceElementPage {
  items: ReferenceElement[];
  /** Pass back as `cursor` to fetch the next page; absent when the list is exhausted. */
  nextCursor?: number;
}

/** Parse one raw element object into a {@link ReferenceElement}; undefined if it lacks id+name. */
export function parseReferenceElement(raw: unknown): ReferenceElement | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!id || !name) return undefined;
  const el: ReferenceElement = { id, name };
  if (typeof o.category === 'string') el.category = o.category;
  if (typeof o.description === 'string') el.description = o.description;
  if (typeof o.created_at === 'number') el.createdAt = o.created_at;
  const medias = o.medias;
  if (Array.isArray(medias) && medias.length > 0) {
    const first = medias[0] as Record<string, unknown> | undefined;
    if (first && typeof first.url === 'string' && first.url) el.imageUrl = first.url;
  }
  return el;
}

/**
 * Defensively unwrap the MCP result into `{ items, nextCursor }`. `unwrapToolPayload`
 * handles both the wrapped `{ content: [{ text: '<json>' }] }` shape AND a direct
 * `{ items, next_cursor }` object, so this works for the live wire result and for
 * test fixtures passed as plain objects.
 */
export function parseElementPage(raw: unknown): ReferenceElementPage {
  const o = (unwrapToolPayload(raw) ?? {}) as Record<string, unknown>;
  const rawItems = Array.isArray(o.items) ? o.items : [];
  const items: ReferenceElement[] = [];
  for (const it of rawItems) {
    const el = parseReferenceElement(it);
    if (el) items.push(el);
  }
  const page: ReferenceElementPage = { items };
  if (typeof o.next_cursor === 'number') page.nextCursor = o.next_cursor;
  return page;
}

/** Close a connection, swallowing close errors so they don't mask the result. */
async function closeQuietly(connection: { close: () => Promise<void> }): Promise<void> {
  try {
    await connection.close();
  } catch {
    /* a failed close must not turn a success into a failure */
  }
}

/** One page of `list`. Always closes the MCP connection. */
export async function listReferenceElements(args: {
  connector: McpServerConfig;
  cursor?: number;
  size?: number;
  signal?: AbortSignal;
}): Promise<ReferenceElementPage> {
  let connection: Awaited<ReturnType<typeof connectMcp>> | undefined;
  try {
    connection = await connectMcp(args.connector, args.signal ? { signal: args.signal } : undefined);
    const raw = await callMcpTool(connection.client, SHOW_REFERENCE_ELEMENTS_TOOL, {
      action: 'list',
      ...(typeof args.cursor === 'number' ? { cursor: args.cursor } : {}),
      ...(typeof args.size === 'number' ? { size: args.size } : {}),
    });
    return parseElementPage(raw);
  } finally {
    if (connection) await closeQuietly(connection);
  }
}

/** `get` one element by id. Returns undefined if the server has no such element. Always closes. */
export async function getReferenceElement(args: {
  connector: McpServerConfig;
  elementId: string;
  signal?: AbortSignal;
}): Promise<ReferenceElement | undefined> {
  let connection: Awaited<ReturnType<typeof connectMcp>> | undefined;
  try {
    connection = await connectMcp(args.connector, args.signal ? { signal: args.signal } : undefined);
    const raw = await callMcpTool(connection.client, SHOW_REFERENCE_ELEMENTS_TOOL, {
      action: 'get',
      element_id: args.elementId,
    });
    return parseElementPage(raw).items[0];
  } finally {
    if (connection) await closeQuietly(connection);
  }
}
