/**
 * V1.1.1-SKILLS-AUTO-USE: skill loader for the
 * `docs/research/higgsfield-skills/*.md` corpus.
 *
 * The repo ships a set of [agents.md](https://agents.md)-style
 * skills (frontmatter + body markdown). v1.1.0 added them to
 * `docs/research/` but nothing in the runtime read them - the
 * prompt generation path was using a hard-coded system prompt
 * with no awareness of the available skills. This loader:
 *
 *   1. Discovers the `*-SKILL.md` files in the skills dir.
 *   2. Parses the YAML frontmatter for `name` and `description`.
 *   3. Returns the body markdown (the actual skill content) plus
 *      the metadata the Settings UI needs (name, description,
 *      size in bytes) so the user can decide which to enable.
 *
 * The injection happens in `app/api/ai/prompt/route.ts` (and the
 * pi/nca routes if we want to extend there): the loader is
 * called at request time, the active skills' bodies are joined
 * with a separator, and the result is appended to the system
 * prompt right after the user-supplied `systemPrompt` field.
 *
 * Failure philosophy: a missing skills dir, a malformed
 * frontmatter, or any other loader error returns an empty
 * array. The caller then sees no skills and the prompt is
 * built without them - never a hard failure on a user's
 * machine that doesn't ship the corpus (CI, serverless, etc.).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface SkillMeta {
  /** Frontmatter `name` field, e.g. 'banana-pro-director'. */
  name: string;
  /** Frontmatter `description` field; first paragraph, trimmed. */
  description: string;
  /** Body markdown (everything after the closing `---`). */
  body: string;
  /** Absolute path to the source file. */
  source: string;
  /** Size in bytes of the body content. The Settings UI
   *  surfaces this so the user can see which skills are
   *  large enough to skip on small models. */
  bodyBytes: number;
}

const SKILLS_DIR = path.join(process.cwd(), 'docs', 'research', 'higgsfield-skills');

/** Optional allowlist for the *-SKILL.md pattern. We want the
 *  main skill, not the long-form reference (the 100KB+ ones).
 *  The main SKILL.md files are short, focused, and meant for
 *  auto-injection; the -cinema-SKILL.md and similar suffixes
 *  are reference docs that the user can read on demand. */
const SKILL_FILE_SUFFIX = '-SKILL.md';
// Exclude reference / cinematic variants that are too long to
// always inject. Update this allowlist if a new long-form
// reference is added.
const SKILL_FILE_BLOCKED_PATTERNS: readonly RegExp[] = [
  /-cinema-SKILL\.md$/i,
];

/**
 * Parse a single SKILL.md file's frontmatter and body. Returns
 * `null` if the file has no frontmatter or the frontmatter is
 * malformed - the caller should treat that as "skip this file".
 */
function parseSkillFile(contents: string, source: string): SkillMeta | null {
  if (!contents.startsWith('---')) return null;
  const end = contents.indexOf('\n---', 3);
  if (end < 0) return null;
  const fm = contents.slice(3, end).trim();
  const body = contents.slice(end + 4).replace(/^\r?\n/, '').trim();

  // Tiny frontmatter parser: just enough to pull `name` and
  // `description` out of the YAML block. We don't need a real
  // YAML parser - the agents.md frontmatter is always simple
  // key: value or key: > block. Multi-line `description: >`
  // gets joined into a single trimmed paragraph.
  const name = readScalar(fm, 'name') ?? path.basename(source, SKILL_FILE_SUFFIX);
  const description = readMultilineScalar(fm, 'description') ?? '';

  return {
    name,
    description,
    body,
    source,
    bodyBytes: Buffer.byteLength(body, 'utf8'),
  };
}

function readScalar(block: string, key: string): string | null {
  const re = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm');
  const m = block.match(re);
  if (!m) return null;
  // Strip surrounding quotes (single, double) so
  // `name: "banana-pro-director"` and `name: 'foo'` both parse
  // to the bare slug.
  const raw = m[1].trim();
  if (
    (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
    (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

function readMultilineScalar(block: string, key: string): string | null {
  // YAML folded scalar: `description: >` followed by indented
  // continuation lines. Join them with single spaces and trim.
  const head = new RegExp(`^${key}:\\s*>\\s*$`, 'm');
  const m = block.match(head);
  if (!m) {
    // Also accept the single-line form for short descriptions.
    return readScalar(block, key);
  }
  const after = block.slice(m.index! + m[0].length);
  const lines: string[] = [];
  for (const line of after.split(/\r?\n/)) {
    if (line === '' || line.trim() === '' || /^\S/.test(line)) break;
    lines.push(line.trim());
  }
  return lines.join(' ').replace(/\s+/g, ' ').trim() || null;
}

/**
 * Discover and parse every `*-SKILL.md` in the skills dir.
 * Returns an empty array on any filesystem / parse error so
 * the caller never has to deal with a missing corpus.
 */
export async function loadAllSkills(): Promise<SkillMeta[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(SKILLS_DIR);
  } catch {
    return [];
  }
  const targets = entries.filter(
    (f) => f.endsWith(SKILL_FILE_SUFFIX) && !SKILL_FILE_BLOCKED_PATTERNS.some((re) => re.test(f)),
  );
  const out: SkillMeta[] = [];
  for (const f of targets) {
    const full = path.join(SKILLS_DIR, f);
    let contents: string;
    try {
      contents = await fs.readFile(full, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseSkillFile(contents, full);
    if (parsed) out.push(parsed);
  }
  // Stable order: by name so the Settings UI doesn't shuffle
  // every render.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Build the system-prompt fragment for a list of active skill
 * names. Unknown names are silently skipped. Returns an empty
 * string when no active skills are present so the caller can
 * concatenate without a special case.
 *
 * V1.7.0-M2.2 (automatic skill selection): the block now opens with a
 * SKILL INDEX (name + description) and a routing instruction telling the
 * model to apply only the skill(s) that fit the CURRENT prompt, instead
 * of forcing every active skill onto every prompt. Before this, a noir
 * portrait and a wide battle scene received the identical skill payload.
 * The per-skill bodies still follow so an applied skill remains actionable.
 */
export async function buildSkillSystemBlock(activeNames: readonly string[]): Promise<string> {
  if (activeNames.length === 0) return '';
  const all = await loadAllSkills();
  const byName = new Map(all.map((s) => [s.name, s]));
  const selected = activeNames
    .map((n) => byName.get(n))
    .filter((s): s is SkillMeta => Boolean(s));
  if (selected.length === 0) return '';
  const index = selected
    .map((s, i) => `${i + 1}. ${s.name} — ${s.description || '(no description)'}`)
    .join('\n');
  return [
    '## Active Skills',
    '',
    // V1.7.0-M2.2: routing instruction — selective, not blanket application.
    'Apply ONLY the skill(s) whose description below matches the current prompt\'s subject, franchise, or mood. A skill that does not fit should be ignored, not forced. Treat an applied skill\'s content as authoritative directives that override generic prompt-engineering heuristics; never invoke a skill that is not listed here.',
    '',
    '### Skill Index',
    index,
    '',
    '---',
    '',
    ...selected.flatMap((s, i) => [
      `### Skill ${i + 1}: ${s.name}`,
      '',
      s.body,
      '',
    ]),
  ].join('\n');
}
