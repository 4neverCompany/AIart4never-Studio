/**
 * Story 2.8 — canon guard is now STRUCTURAL only (no hardcoded per-character
 * lore). Two rules: `missing-element-token` (error) + `weak-identity-lock` (warn).
 * The old cyberdeck / channel-tag / prime-vs-variant rules are gone — that lore
 * lives in the live Higgsfield Element description now.
 */
import { describe, expect, it } from 'vitest';
import { checkCanonCompliance, formatCanonCheck } from '@/lib/canon/guard';

const TOKEN = '<<<f45172ea-8fbd-4aac-bda1-4c694e276080>>>';

describe('checkCanonCompliance — missing-element-token (ERROR, the identity guarantee)', () => {
  it('BLOCKS (ok:false) a recurring-character prompt with no Element token', () => {
    const r = checkCanonCompliance('kael', 'Master4never on a neon rooftop at night, same man.');
    expect(r.ok).toBe(false);
    const v = r.violations.find((x) => x.rule === 'missing-element-token');
    expect(v?.severity).toBe('error');
    // The character id is surfaced (keeps the param genuinely used).
    expect(v?.detail).toContain('kael');
  });

  it('BLOCKS a variant prompt too — the rule is lore-agnostic (same check for every character)', () => {
    const r = checkCanonCompliance('kaelus-vorne', 'Kaelus Vorne in crimson ceramite, reference.');
    expect(r.ok).toBe(false);
    expect(r.violations.some((x) => x.rule === 'missing-element-token')).toBe(true);
  });

  it('passes clean (ok:true, no violations) when the Element token + prose lock are present', () => {
    const r = checkCanonCompliance('kael', `${TOKEN} Master4never on a rooftop, keep the same man and face.`);
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('no longer references any cyberdeck / channel-tag lore rules', () => {
    // A prompt that the OLD guard would have flagged (cyberdeck on a variant) is
    // now judged ONLY on the structural token — lore is the Element's job.
    const r = checkCanonCompliance('kaelus-vorne', `${TOKEN} Kaelus with a glowing forehead cyberdeck and an AIART4NEVER tag, same man.`);
    expect(r.ok).toBe(true);
    expect(r.violations.map((v) => v.rule)).not.toContain('no-cyberdeck-on-variant');
    expect(r.violations.map((v) => v.rule)).not.toContain('no-channel-tag-on-variant');
  });
});

describe('checkCanonCompliance — weak-identity-lock (WARN, advisory prose telemetry)', () => {
  it('warns (does NOT block) when the token is present but there is no prose reinforcement', () => {
    const r = checkCanonCompliance('kael', `${TOKEN} a rain-soaked neon alley at midnight.`);
    expect(r.ok).toBe(true); // warn doesn't block
    expect(r.violations.some((v) => v.rule === 'weak-identity-lock' && v.severity === 'warn')).toBe(true);
  });

  it('does not warn when prose reinforcement is present alongside the token', () => {
    const r = checkCanonCompliance('kael', `${TOKEN} a rooftop, same face, edited from reference.`);
    expect(r.violations.some((v) => v.rule === 'weak-identity-lock')).toBe(false);
  });
});

describe('formatCanonCheck', () => {
  it('summarises ok / warnings / violations', () => {
    expect(formatCanonCheck({ ok: true, violations: [] })).toBe('canon: ok');
    expect(
      formatCanonCheck({ ok: false, violations: [{ rule: 'missing-element-token', severity: 'error', detail: 'x' }] }),
    ).toContain('violation');
    expect(
      formatCanonCheck({ ok: true, violations: [{ rule: 'weak-identity-lock', severity: 'warn', detail: 'x' }] }),
    ).toContain('warning');
  });
});
