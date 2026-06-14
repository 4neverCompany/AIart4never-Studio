/**
 * CAMOFOX-CAMOUFOX-1.1.0 (2026-06-06): unit tests for the macros
 * module. Tiny — the module is mostly type-definitions and a
 * Pinterest URL builder that's not yet called from production code
 * (R9 in the master plan).
 */
import { describe, expect, it } from 'vitest';
import { CAMOFOX_MACROS, buildManualSearchUrl } from '@/lib/camofox/macros';

describe('buildManualSearchUrl', () => {
  it('builds a Pinterest search URL with encoded query', () => {
    const url = buildManualSearchUrl('pinterest', 'cute cats & dogs');
    expect(url).toBe('https://www.pinterest.com/search/pins/?q=cute%20cats%20%26%20dogs');
  });

  it('encodes special characters in the query', () => {
    const url = buildManualSearchUrl('pinterest', 'a/b?c=d&e=f');
    expect(url).toBe('https://www.pinterest.com/search/pins/?q=a%2Fb%3Fc%3Dd%26e%3Df');
  });
});

describe('CAMOFOX_MACROS', () => {
  it('contains exactly 14 macros (snapshot of v1.11.2)', () => {
    // If the upstream macro list changes, this test forces us to
    // update the client deliberately. See the comment in macros.ts
    // for the upstream list.
    expect(CAMOFOX_MACROS.length).toBe(14);
  });

  it('every macro starts with @', () => {
    for (const m of CAMOFOX_MACROS) {
      expect(m.startsWith('@')).toBe(true);
    }
  });

  it('does not contain @pinterest_search (R9 — upstream gap)', () => {
    expect(CAMOFOX_MACROS).not.toContain('@pinterest_search');
  });
});
