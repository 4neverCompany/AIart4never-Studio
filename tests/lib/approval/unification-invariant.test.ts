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
import { existsSync, readFileSync } from 'node:fs';
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

  it('the publish path verifies a hash-bound token via the canonical gate (unchanged reference)', () => {
    expect(read(PUBLISH_PATH)).toMatch(/verifyToken\s*\(/);
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
});
