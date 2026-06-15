import { describe, expect, it } from 'vitest';
import { checkCanonCompliance, formatCanonCheck } from '@/lib/canon/guard';

describe('checkCanonCompliance — PRIME (Kael)', () => {
  it('passes clean when cyberdeck + channel tag + anchor are present', () => {
    const r = checkCanonCompliance(
      'kael',
      '<<<9349dc19-0801-40de-8bb6-e433328f83e2>>> Master4never, glowing forehead cyberdeck, AIART4NEVER tag on his collar, keep the same man.',
    );
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('warns (does not block) when his cyberdeck + tag are missing', () => {
    const r = checkCanonCompliance('kael', 'A reflective netrunner portrait, same face, edited from reference.');
    expect(r.ok).toBe(true); // warnings don't block
    const rules = r.violations.map((v) => v.rule).sort();
    expect(rules).toContain('prime-cyberdeck-missing');
    expect(rules).toContain('prime-channel-tag-missing');
    expect(r.violations.every((v) => v.severity === 'warn')).toBe(true);
  });
});

describe('checkCanonCompliance — variant (Kaelus Vorne)', () => {
  it('BLOCKS when a cyberdeck is described on the variant', () => {
    const r = checkCanonCompliance(
      'kaelus-vorne',
      '<<<812c9a78-4b78-4910-a301-3083c8c65ecc>>> Kaelus Vorne in crimson armor with a glowing cyberdeck on his forehead, same man.',
    );
    expect(r.ok).toBe(false);
    expect(r.violations.find((v) => v.rule === 'no-cyberdeck-on-variant')?.severity).toBe('error');
  });

  it('BLOCKS when the variant wears the AIART4NEVER channel tag', () => {
    const r = checkCanonCompliance(
      'kaelus-vorne',
      '<<<812c9a78>>> Kaelus wearing an AIART4NEVER label on his collar.',
    );
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.rule === 'no-channel-tag-on-variant')).toBe(true);
  });

  it('passes a clean on-canon variant prompt', () => {
    const r = checkCanonCompliance(
      'kaelus-vorne',
      '<<<812c9a78-4b78-4910-a301-3083c8c65ecc>>> Kaelus Vorne, Chapter Master of the Ashen Halo, crimson and gold ceramite, service studs, same face.',
    );
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
  });
});

describe('checkCanonCompliance — consistency mandate', () => {
  it('warns when no identity anchor is present', () => {
    const r = checkCanonCompliance('kael', 'A brand-new cyberpunk character with a cyberdeck and an AIART4NEVER tag.');
    expect(r.ok).toBe(true);
    expect(r.violations.some((v) => v.rule === 'missing-identity-anchor' && v.severity === 'warn')).toBe(true);
  });
});

describe('formatCanonCheck', () => {
  it('summarises ok / warnings / violations', () => {
    expect(formatCanonCheck({ ok: true, violations: [] })).toBe('canon: ok');
    expect(
      formatCanonCheck({ ok: false, violations: [{ rule: 'no-cyberdeck-on-variant', severity: 'error', detail: 'x' }] }),
    ).toContain('violation');
    expect(
      formatCanonCheck({ ok: true, violations: [{ rule: 'prime-cyberdeck-missing', severity: 'warn', detail: 'x' }] }),
    ).toContain('warning');
  });
});
