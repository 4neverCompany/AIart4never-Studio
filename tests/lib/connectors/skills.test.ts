/**
 * M2 — Skills layer tests.
 *
 * Persistence is mocked via `vi.mock('@/lib/persistence', ...)` with an
 * in-memory backing store (same pattern as tests/lib/mcp/registry.test.ts) so
 * CRUD exercises real read/modify/write logic without idb/tauri. The pure
 * helpers (`validateSkill`, `resolveSkillTools`) are tested directly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/persistence', () => ({
  get: vi.fn(),
  set: vi.fn(),
  __resetStoreForTests: vi.fn(),
}));

import {
  SKILLS_KEY,
  listSkills,
  getSkill,
  saveSkill,
  removeSkill,
  validateSkill,
  resolveSkillTools,
} from '@/lib/connectors/skills';
import type { Skill } from '@/lib/connectors/types';
import type { McpToolInfo } from '@/lib/mcp';
import * as persistenceModule from '@/lib/persistence';

const persistenceMock = {
  get: persistenceModule.get as ReturnType<typeof vi.fn>,
  set: persistenceModule.set as ReturnType<typeof vi.fn>,
};

let store: Record<string, unknown>;

function makeSkill(over: Partial<Skill> = {}): Skill {
  return {
    id: 'skill-1',
    name: 'Image Generation',
    description: 'Generate images via the connector',
    connectorId: 'higgsfield',
    toolNames: ['generate_image', 'upscale_image'],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  store = {};
  persistenceMock.get.mockImplementation(async (k: string) => store[k]);
  persistenceMock.set.mockImplementation(async (k: string, v: unknown) => {
    store[k] = v;
  });
});

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

describe('skills CRUD', () => {
  it('listSkills returns [] when nothing stored', async () => {
    expect(await listSkills()).toEqual([]);
  });

  it('listSkills tolerates a non-array stored value', async () => {
    store[SKILLS_KEY] = 'corrupted';
    expect(await listSkills()).toEqual([]);
  });

  it('saveSkill appends and persists under the right key', async () => {
    const s = makeSkill();
    await saveSkill(s);
    expect(persistenceMock.set).toHaveBeenCalledWith(SKILLS_KEY, [s]);
    expect(await listSkills()).toEqual([s]);
  });

  it('saveSkill upserts in place when the id already exists', async () => {
    await saveSkill(makeSkill());
    await saveSkill(makeSkill({ name: 'Renamed' }));
    const all = await listSkills();
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe('Renamed');
  });

  it('saveSkill throws (and does not persist) an invalid skill', async () => {
    await expect(saveSkill(makeSkill({ toolNames: [] }))).rejects.toThrow(/invalid skill/);
    expect(persistenceMock.set).not.toHaveBeenCalled();
  });

  it('getSkill finds by id and returns undefined when absent', async () => {
    await saveSkill(makeSkill());
    expect((await getSkill('skill-1'))?.name).toBe('Image Generation');
    expect(await getSkill('nope')).toBeUndefined();
  });

  it('removeSkill drops the matching skill', async () => {
    await saveSkill(makeSkill());
    await saveSkill(makeSkill({ id: 'skill-2' }));
    const next = await removeSkill('skill-1');
    expect(next.map((s) => s.id)).toEqual(['skill-2']);
    expect(await getSkill('skill-1')).toBeUndefined();
  });

  it('removeSkill is a no-op for an unknown id', async () => {
    await saveSkill(makeSkill());
    const next = await removeSkill('ghost');
    expect(next).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// validateSkill (pure)
// ---------------------------------------------------------------------------

describe('validateSkill', () => {
  it('accepts a valid skill', () => {
    expect(validateSkill(makeSkill())).toEqual({ ok: true, errors: [] });
  });

  it('requires id, name, connectorId', () => {
    const r = validateSkill({ toolNames: ['x'] });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('id is required');
    expect(r.errors).toContain('name is required');
    expect(r.errors).toContain('connectorId is required');
  });

  it('requires a non-empty toolNames array', () => {
    expect(validateSkill(makeSkill({ toolNames: [] })).errors).toContain(
      'toolNames must be a non-empty array',
    );
  });

  it('rejects toolNames containing empty strings', () => {
    expect(validateSkill(makeSkill({ toolNames: ['ok', '  '] })).errors).toContain(
      'toolNames must contain only non-empty strings',
    );
  });
});

// ---------------------------------------------------------------------------
// resolveSkillTools (pure) — least-privilege intersection + missing report
// ---------------------------------------------------------------------------

describe('resolveSkillTools', () => {
  const available: McpToolInfo[] = [
    { name: 'generate_image', description: 'gen' },
    { name: 'upscale_image', description: 'up' },
    { name: 'delete_everything', description: 'danger' },
  ];

  it('grants only the named subset (least privilege), not the whole server', () => {
    const skill = makeSkill({ toolNames: ['generate_image', 'upscale_image'] });
    const { granted, missing } = resolveSkillTools(skill, available);

    expect(granted.map((t) => t.name)).toEqual(['generate_image', 'upscale_image']);
    // The dangerous tool the connector exposes is NOT granted.
    expect(granted.some((t) => t.name === 'delete_everything')).toBe(false);
    expect(missing).toEqual([]);
  });

  it('reports tools the skill names but the connector no longer exposes', () => {
    const skill = makeSkill({ toolNames: ['generate_image', 'renamed_tool'] });
    const { granted, missing } = resolveSkillTools(skill, available);

    expect(granted.map((t) => t.name)).toEqual(['generate_image']);
    expect(missing).toEqual(['renamed_tool']);
  });

  it('returns empty granted when none of the named tools are available', () => {
    const skill = makeSkill({ toolNames: ['gone_a', 'gone_b'] });
    const { granted, missing } = resolveSkillTools(skill, available);

    expect(granted).toEqual([]);
    expect(missing).toEqual(['gone_a', 'gone_b']);
  });
});
