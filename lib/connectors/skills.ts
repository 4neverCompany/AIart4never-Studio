/**
 * M2 — Skills layer (persisted).
 *
 * A {@link Skill} is a named, least-privilege bundle that grants the agent a
 * SUBSET of one connector's tools. The agent should be handed Skills, not raw
 * connectors: a connector may expose dozens of tools, but a Skill names only
 * the handful the agent needs for a given job.
 *
 * Storage mirrors the MCP registry's shape — a single key holding the whole
 * `Skill[]`, read/modified/written through `@/lib/persistence`. The CRUD is
 * thin; the interesting logic (`validateSkill`, `resolveSkillTools`) is PURE
 * and unit-tested without touching storage.
 */

import { get, set } from '@/lib/persistence';
import type { McpToolInfo } from '@/lib/mcp';
import type { Skill } from './types';

/** Storage key holding the full `Skill[]`. */
export const SKILLS_KEY = 'aiart4never_skills';

// ---------------------------------------------------------------------------
// Internal storage helpers
// ---------------------------------------------------------------------------

/** Read the raw array, tolerating a missing / corrupted value. */
async function readAll(): Promise<Skill[]> {
  const raw = await get<Skill[]>(SKILLS_KEY);
  return Array.isArray(raw) ? raw : [];
}

async function writeAll(skills: Skill[]): Promise<void> {
  await set(SKILLS_KEY, skills);
}

// ---------------------------------------------------------------------------
// CRUD surface
// ---------------------------------------------------------------------------

/** All persisted skills, in stored order. */
export async function listSkills(): Promise<Skill[]> {
  return readAll();
}

/** A single skill by id, or `undefined` if not found. */
export async function getSkill(id: string): Promise<Skill | undefined> {
  const skills = await readAll();
  return skills.find((s) => s.id === id);
}

/**
 * Upsert a skill. Matches on `id`: replaces in place if present, otherwise
 * appends. Validates first and THROWS on an invalid skill so a malformed
 * bundle never reaches storage.
 */
export async function saveSkill(skill: Skill): Promise<Skill[]> {
  const validation = validateSkill(skill);
  if (!validation.ok) {
    throw new Error(`invalid skill: ${validation.errors.join('; ')}`);
  }
  const skills = await readAll();
  const idx = skills.findIndex((s) => s.id === skill.id);
  if (idx >= 0) {
    skills[idx] = skill;
  } else {
    skills.push(skill);
  }
  await writeAll(skills);
  return skills;
}

/** Remove a skill by id. No-op if it doesn't exist. */
export async function removeSkill(id: string): Promise<Skill[]> {
  const skills = await readAll();
  const next = skills.filter((s) => s.id !== id);
  await writeAll(next);
  return next;
}

// ---------------------------------------------------------------------------
// PURE helpers (no storage) — unit-tested directly
// ---------------------------------------------------------------------------

export interface SkillValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a (possibly partial) skill WITHOUT touching storage.
 *
 * Rules:
 *  - `id`, `name`, `connectorId` must be non-empty strings.
 *  - `toolNames` must be a non-empty array of non-empty strings (a skill that
 *    grants no tools is meaningless and would silently give the agent nothing).
 *
 * Returns every problem found so a form can show them all at once.
 */
export function validateSkill(partial: Partial<Skill>): SkillValidationResult {
  const errors: string[] = [];

  if (!isNonEmptyString(partial.id)) errors.push('id is required');
  if (!isNonEmptyString(partial.name)) errors.push('name is required');
  if (!isNonEmptyString(partial.connectorId)) errors.push('connectorId is required');

  if (!Array.isArray(partial.toolNames) || partial.toolNames.length === 0) {
    errors.push('toolNames must be a non-empty array');
  } else if (!partial.toolNames.every((t) => isNonEmptyString(t))) {
    errors.push('toolNames must contain only non-empty strings');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * The result of resolving a skill against a connector's live tool list:
 * `granted` is the least-privilege subset the agent may actually call;
 * `missing` lists tool names the skill references but the connector no longer
 * advertises (renamed/removed upstream) — useful for surfacing a stale skill.
 */
export interface ResolvedSkillTools {
  granted: McpToolInfo[];
  missing: string[];
}

/**
 * Compute the LEAST-PRIVILEGE tool subset a skill grants, given the tools a
 * connector currently advertises.
 *
 * Intersects `skill.toolNames` with `availableTools`:
 *   - `granted`  = the `McpToolInfo` objects whose names the skill allow-lists
 *     AND the connector still exposes. This is what the agent gets — never the
 *     whole server, only the named subset.
 *   - `missing`  = names the skill references but the connector no longer
 *     exposes (so the UI can flag a skill that needs re-pointing).
 *
 * Pure: no storage, no network. The connector's full tool list comes from
 * `listMcpTools` at the call site; this function just narrows it.
 */
export function resolveSkillTools(
  skill: Skill,
  availableTools: McpToolInfo[],
): ResolvedSkillTools {
  const available = new Map(availableTools.map((t) => [t.name, t]));
  const granted: McpToolInfo[] = [];
  const missing: string[] = [];

  for (const name of skill.toolNames) {
    const tool = available.get(name);
    if (tool) {
      granted.push(tool);
    } else {
      missing.push(name);
    }
  }

  return { granted, missing };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}
