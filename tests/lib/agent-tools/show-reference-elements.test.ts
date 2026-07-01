/**
 * Story 2.8 — `show_reference_elements` tool tests.
 *
 * The tool is the agent's READ-ONLY live canon lookup. These tests assert:
 *  - schema (get requires elementId),
 *  - `create`/unknown actions are refused BEFORE any connector call,
 *  - no connector → ToolNotAvailableError,
 *  - a single resolved element writes the RunContext memo (the spend anchor),
 *  - an ambiguous (>1) list writes NOTHING (spend fails safe),
 *  - the file never imports the approval gate (read-only).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const listSpy = vi.fn();
const getSpy = vi.fn();
vi.mock('@/lib/higgsfield/elements', () => ({
  listReferenceElements: (...a: unknown[]) => listSpy(...a),
  getReferenceElement: (...a: unknown[]) => getSpy(...a),
}));

import {
  executeShowReferenceElements,
  showReferenceElementsTool,
} from '@/lib/agent-tools/show-reference-elements';
import { ValidationError, ToolNotAvailableError } from '@/lib/agent-tools/errors';
import {
  __setCurrentRunContextForTests,
  currentRunContext,
  type RunContext,
} from '@/lib/agent-loop/run-context';
import type { McpServerConfig } from '@/lib/mcp';

const CONNECTOR: McpServerConfig = {
  id: 'hf-1', name: 'Higgsfield', transport: 'http',
  url: 'https://hf.example/mcp', headers: {}, enabled: true, trusted: true, addedAt: 0,
};
const UUID = 'f45172ea-8fbd-4aac-bda1-4c694e276080';

function enterCtx(connector: McpServerConfig | undefined, characterId: RunContext['characterId'] = 'kael'): void {
  __setCurrentRunContextForTests({
    runId: 'run_test', stepCounter: 0, totalCostUsd: 0, budgetUsd: 1,
    ...(characterId ? { characterId } : {}),
    ...(connector ? { higgsfieldConnector: connector } : {}),
  });
}

beforeEach(() => { listSpy.mockReset(); getSpy.mockReset(); __setCurrentRunContextForTests(null); });
afterEach(() => { __setCurrentRunContextForTests(null); });

describe('executeShowReferenceElements — schema + read-only boundary', () => {
  it('rejects action="get" without an elementId (ValidationError)', async () => {
    enterCtx(CONNECTOR);
    const r = await executeShowReferenceElements({ action: 'get' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ValidationError);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('rejects action="create" (and unknown actions) BEFORE any connector call', async () => {
    enterCtx(CONNECTOR);
    for (const action of ['create', 'delete', 'nope']) {
      const r = await executeShowReferenceElements({ action, elementId: UUID });
      expect(r.ok, action).toBe(false);
      if (!r.ok) expect(r.error, action).toBeInstanceOf(ValidationError);
    }
    // The canon-mutating write never reaches the connector.
    expect(listSpy).not.toHaveBeenCalled();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('throws ToolNotAvailableError when no connector is in context', async () => {
    // No run context at all.
    let r = await executeShowReferenceElements({ action: 'list' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ToolNotAvailableError);
    // Run context present but no connector.
    enterCtx(undefined);
    r = await executeShowReferenceElements({ action: 'list' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(ToolNotAvailableError);
    expect(listSpy).not.toHaveBeenCalled();
  });
});

describe('executeShowReferenceElements — resolution writes the spend anchor', () => {
  it('a single name match resolves + writes ctx.resolvedElements under the active character', async () => {
    enterCtx(CONNECTOR, 'kael');
    listSpy.mockResolvedValue({
      items: [{ id: UUID, name: 'Master4never-Prime-Reality-Core', description: 'Use <<<this-id>>> ...' }],
      nextCursor: undefined,
    });
    const r = await executeShowReferenceElements({ action: 'list', nameFilter: 'Reality-Core' });
    expect(r.ok).toBe(true);
    if (r.ok && r.value.action === 'list') {
      expect(r.value.count).toBe(1);
      expect(r.value.ambiguous).toBe(false);
      expect(r.value.resolved).toBe(true);
    }
    expect(currentRunContext()?.resolvedElements?.get('kael')).toEqual({
      elementId: UUID, name: 'Master4never-Prime-Reality-Core',
    });
  });

  it('an AMBIGUOUS (>1) list writes NOTHING to the memo (spend fails safe)', async () => {
    enterCtx(CONNECTOR, 'kael');
    listSpy.mockResolvedValue({
      items: [
        { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Master4never-Prime-Reality-Core' },
        { id: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'Master4never-Prime-CORE-INK' },
      ],
      nextCursor: undefined,
    });
    const r = await executeShowReferenceElements({ action: 'list', nameFilter: 'Master4never' });
    expect(r.ok).toBe(true);
    if (r.ok && r.value.action === 'list') {
      expect(r.value.count).toBe(2);
      expect(r.value.ambiguous).toBe(true);
      expect(r.value.resolved).toBe(false);
    }
    expect(currentRunContext()?.resolvedElements?.get('kael')).toBeUndefined();
  });

  it('action="get" resolves + writes the memo (the conscious pick)', async () => {
    enterCtx(CONNECTOR, 'kael');
    getSpy.mockResolvedValue({ id: UUID, name: 'Master4never-Prime-Reality-Core', description: '...' });
    const r = await executeShowReferenceElements({ action: 'get', elementId: UUID });
    expect(r.ok).toBe(true);
    if (r.ok && r.value.action === 'get') expect(r.value.element.id).toBe(UUID);
    expect(currentRunContext()?.resolvedElements?.get('kael')?.elementId).toBe(UUID);
  });

  it('an explicit characterId writes the memo under THAT key (multi-character beats)', async () => {
    enterCtx(CONNECTOR, 'kael');
    getSpy.mockResolvedValue({ id: UUID, name: 'Kaelus-Vorne' });
    await executeShowReferenceElements({ action: 'get', elementId: UUID, characterId: 'kaelus-vorne' });
    expect(currentRunContext()?.resolvedElements?.get('kaelus-vorne')?.elementId).toBe(UUID);
    expect(currentRunContext()?.resolvedElements?.get('kael')).toBeUndefined();
  });
});

describe('show_reference_elements — governance invariants', () => {
  it('the tool source NEVER imports the approval gate (read-only)', () => {
    const src = readFileSync(join(process.cwd(), 'lib/agent-tools/show-reference-elements.ts'), 'utf8');
    expect(src).not.toMatch(/@\/lib\/approval/);
    expect(src).not.toMatch(/assertApproved|verifyToken/);
  });

  it('exposes a Vercel-AI tool with description + schemas', () => {
    const obj = showReferenceElementsTool as unknown as Record<string, unknown>;
    expect(typeof obj.description).toBe('string');
    expect(obj.inputSchema).toBeDefined();
    expect(obj.outputSchema).toBeDefined();
  });
});
