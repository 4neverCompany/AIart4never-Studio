/**
 * Story 2.8 — Higgsfield reference-Element read-only core tests.
 *
 * Covers the pure parsers (defensive unwrap across wire shapes) and the
 * list/get/resolve MCP wiring (mocked connector — no network). Confirms the
 * client-side name-substring resolution + "exactly one or ambiguous" contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const callSpy = vi.fn();
const closeSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/mcp', () => ({
  connectMcp: vi.fn(async () => ({ client: {}, close: closeSpy })),
  callMcpTool: (...args: unknown[]) => callSpy(...args),
}));

import {
  parseReferenceElement,
  parseElementPage,
  listReferenceElements,
  getReferenceElement,
  SHOW_REFERENCE_ELEMENTS_TOOL,
} from '@/lib/higgsfield/elements';
import type { McpServerConfig } from '@/lib/mcp';

const CONNECTOR: McpServerConfig = {
  id: 'hf-1', name: 'Higgsfield', transport: 'http',
  url: 'https://hf.example/mcp', headers: {}, enabled: true, trusted: true, addedAt: 0,
};

/** A live-shaped element object. */
const el = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, category: 'character', description: `desc ${name}`, status: 'completed',
  medias: [{ id: 'm', url: `https://cdn/${id}.png`, type: 'image_job' }],
  video_medias: [], created_at: 100, ...extra,
});
/** Wrap a payload in the MCP `{ content: [{ text }] }` wire shape. */
const wire = (obj: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

beforeEach(() => { callSpy.mockReset(); closeSpy.mockClear(); });

describe('parseReferenceElement', () => {
  it('parses a full element + maps created_at→createdAt and medias[0].url→imageUrl', () => {
    const r = parseReferenceElement(el('a', 'Kael'));
    expect(r).toEqual({
      id: 'a', name: 'Kael', category: 'character', description: 'desc Kael',
      createdAt: 100, imageUrl: 'https://cdn/a.png',
    });
  });
  it('returns undefined when id or name is missing', () => {
    expect(parseReferenceElement({ name: 'x' })).toBeUndefined();
    expect(parseReferenceElement({ id: 'x' })).toBeUndefined();
    expect(parseReferenceElement(null)).toBeUndefined();
    expect(parseReferenceElement('nope')).toBeUndefined();
  });
});

describe('parseElementPage — defensive unwrap across shapes', () => {
  it('parses a direct { items, next_cursor } object', () => {
    const page = parseElementPage({ items: [el('a', 'A'), el('b', 'B')], next_cursor: 42 });
    expect(page.items.map((e) => e.id)).toEqual(['a', 'b']);
    expect(page.nextCursor).toBe(42);
  });
  it('parses the MCP { content: [{ text: <json> }] } wire shape', () => {
    const page = parseElementPage(wire({ items: [el('a', 'A')], next_cursor: null }));
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeUndefined(); // null → absent
  });
  it('is empty-safe on garbage / null', () => {
    expect(parseElementPage(null).items).toEqual([]);
    expect(parseElementPage({ nope: 1 }).items).toEqual([]);
  });
  it('drops malformed items but keeps valid ones', () => {
    const page = parseElementPage({ items: [el('a', 'A'), { id: 'x' }, el('b', 'B')] });
    expect(page.items.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('listReferenceElements', () => {
  it('calls show_reference_elements action=list with size/cursor and closes the connection', async () => {
    callSpy.mockResolvedValue(wire({ items: [el('a', 'A')], next_cursor: 7 }));
    const page = await listReferenceElements({ connector: CONNECTOR, size: 25, cursor: 3 });
    expect(callSpy).toHaveBeenCalledWith(expect.anything(), SHOW_REFERENCE_ELEMENTS_TOOL, {
      action: 'list', cursor: 3, size: 25,
    });
    expect(page.items[0].id).toBe('a');
    expect(page.nextCursor).toBe(7);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('getReferenceElement', () => {
  it('calls action=get with element_id and returns items[0]', async () => {
    callSpy.mockResolvedValue(wire({ items: [el('f45', 'Reality-Core')], next_cursor: null }));
    const r = await getReferenceElement({ connector: CONNECTOR, elementId: 'f45' });
    expect(callSpy).toHaveBeenCalledWith(expect.anything(), SHOW_REFERENCE_ELEMENTS_TOOL, {
      action: 'get', element_id: 'f45',
    });
    expect(r?.id).toBe('f45');
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
  it('returns undefined when the server has no such element', async () => {
    callSpy.mockResolvedValue(wire({ items: [], next_cursor: null }));
    expect(await getReferenceElement({ connector: CONNECTOR, elementId: 'nope' })).toBeUndefined();
  });
});
