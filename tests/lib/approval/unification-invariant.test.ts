/**
 * Story 10.1 — single canonical approval chokepoint (invariant).
 *
 * Seeds Story 10.7's CI invariant guard: confirms that BOTH the spend-heavy
 * generation paths AND the publish path obtain + verify a hash-bound Approval
 * token from the SAME canonical gate (`lib/approval/gate.ts`), and that the
 * retired `lib/agent-loop/hil.ts` / `app/api/ai/confirm` sibling surface is
 * gone. A source-level check so a regression (a new generation path that skips
 * the gate, or a re-introduced second approval surface) fails CI rather than
 * shipping the "single chokepoint" claim while it's silently untrue.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const SPEND_PATHS = [
  'lib/agent-tools/generate-image.ts',
  'lib/agent-tools/generate-video.ts',
  // Story 10.1 follow-up: reframe_image is a real Higgsfield image generation
  // (credit spend) exposed to the agent — migrated onto the canonical gate too.
  'lib/agent-tools/reframe-image.ts',
];
const PUBLISH_PATH = 'lib/publish/dispatch.ts';

describe('Story 10.1 — single canonical approval chokepoint (invariant; seeds Story 10.7)', () => {
  it('both spend (generation) paths obtain + verify a hash-bound token via the canonical gate', () => {
    for (const p of SPEND_PATHS) {
      const s = read(p);
      expect(s, `${p} must call assertApproved from the canonical gate`).toMatch(/assertApproved\s*\(/);
      expect(s, `${p} must verifyToken before the spend`).toMatch(/verifyToken\s*\(/);
      expect(s, `${p} must import from lib/approval/gate`).toMatch(/from ['"]@\/lib\/approval\/gate['"]/);
    }
  });

  it('the publish path verifies a hash-bound token FIRST and fails closed (Story 10.7 / AC2,AC3)', () => {
    const s = read(PUBLISH_PATH);
    // Not merely "a verifyToken somewhere": the token is checked against
    // deps.approvalToken and a missing/mismatched token fails CLOSED. Deleting
    // this guard fails the assertion — the guard is real, not advisory.
    expect(s, 'dispatch must verify deps.approvalToken fail-closed').toMatch(
      /if\s*\(\s*!verifyToken\s*\(\s*deps\.approvalToken/,
    );
    expect(s, 'a bad/missing publish token must fail closed').toMatch(/ApprovalRequiredError/);
  });

  it('no generation path imports the retired hil.ts / requireApproval surface', () => {
    for (const p of SPEND_PATHS) {
      const s = read(p);
      expect(s, `${p} must not import from agent-loop/hil`).not.toMatch(
        /from ['"]@\/lib\/agent-loop\/hil['"]/,
      );
      expect(s, `${p} must not call requireApproval`).not.toMatch(/requireApproval\s*\(/);
    }
  });

  it('the retired hil.ts module and /api/ai/confirm route no longer exist', () => {
    expect(existsSync(join(ROOT, 'lib/agent-loop/hil.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'app/api/ai/confirm/route.ts'))).toBe(false);
  });

  it('no production module OUTSIDE lib/publish imports the publish runtime API (no-publish-bypass; Story 10.7 / AC2,AC3)', () => {
    // FR-12: only lib/publish may CALL publish() or BUILD a publish plan/request.
    // The airtight, false-positive-free proxy is "no production file outside the
    // module VALUE-imports it" — you cannot invoke publish()/buildPublishApprovalRequest
    // without importing the module. `import type` is allowed (a type can't call
    // anything); tests and lib/publish itself are exempt. A future caller added
    // outside the module trips this → CI red (the guard is real, not advisory).
    const PROD_DIRS = ['app', 'lib', 'bin', 'components', 'hooks'];
    const VALUE_IMPORT = /(^|\n)\s*import\s+(?!type\b)[^;\n]*\bfrom\s+['"]@\/lib\/publish(\/[^'"]+)?['"]/;
    const DYNAMIC_IMPORT = /import\s*\(\s*['"]@\/lib\/publish(\/[^'"]+)?/;
    const offenders: string[] = [];
    for (const dir of PROD_DIRS) {
      const base = join(ROOT, dir);
      if (!existsSync(base)) continue;
      for (const rel of readdirSync(base, { recursive: true }) as string[]) {
        if (!/\.(ts|tsx)$/.test(rel)) continue;
        const norm = rel.replace(/\\/g, '/');
        if (dir === 'lib' && norm.startsWith('publish/')) continue; // the module itself
        if (/\.test\.[tj]sx?$/.test(norm)) continue; // tests may import it
        const src = readFileSync(join(base, rel), 'utf8');
        if (VALUE_IMPORT.test(src) || DYNAMIC_IMPORT.test(src)) offenders.push(`${dir}/${norm}`);
      }
    }
    expect(
      offenders,
      `these files illegally import the publish runtime API (FR-12): ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
