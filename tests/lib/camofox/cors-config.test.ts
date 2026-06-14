/**
 * V1.1.3-CORS (2026-06-07): vitest for the TypeScript
 * CORS-origin parser. Mirrors the Rust helper in
 * `src-tauri/src/lib.rs:resolve_camofox_cors_origins` — same
 * rules, same default. The integration test in
 * `src-tauri/tests/camofox_lifecycle.rs:cors_origins_*` exercises
 * the Rust side; together they pin the wire.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAMOFOX_CORS_ORIGINS,
  formatCorsOrigins,
  parseCorsOrigins,
  resolveCorsOrigins,
} from '@/lib/camofox/cors-config';

describe('parseCorsOrigins', () => {
  it('returns the default whitelist when input is null', () => {
    const r = parseCorsOrigins(null);
    expect(r.origins).toEqual([...DEFAULT_CAMOFOX_CORS_ORIGINS]);
    expect(r.isDefault).toBe(true);
    expect(r.rawInput).toBeNull();
  });

  it('returns the default whitelist when input is undefined', () => {
    const r = parseCorsOrigins(undefined);
    expect(r.isDefault).toBe(true);
    expect(r.origins.length).toBeGreaterThan(0);
  });

  it('returns the default whitelist when input is the empty string', () => {
    const r = parseCorsOrigins('');
    expect(r.isDefault).toBe(true);
    expect(r.rawInput).toBe('');
  });

  it('returns the default whitelist when input is whitespace-only', () => {
    const r = parseCorsOrigins('   \t\n  ');
    expect(r.isDefault).toBe(true);
  });

  it('passes through a valid CSV unchanged', () => {
    const r = parseCorsOrigins('http://localhost:3000,https://mashupforge.vercel.app');
    expect(r.origins).toEqual(['http://localhost:3000', 'https://mashupforge.vercel.app']);
    expect(r.isDefault).toBe(false);
    expect(r.rawInput).toBe('http://localhost:3000,https://mashupforge.vercel.app');
  });

  it('rejects the wildcard `*` and falls back to default', () => {
    const r = parseCorsOrigins('*');
    expect(r.origins).toEqual([...DEFAULT_CAMOFOX_CORS_ORIGINS]);
    expect(r.isDefault).toBe(true);
  });

  it('drops the wildcard from a CSV that also has valid origins', () => {
    const r = parseCorsOrigins('*,http://localhost:3000');
    expect(r.origins).toEqual(['http://localhost:3000']);
    expect(r.isDefault).toBe(false);
  });

  it('drops non-http(s) schemes (file://, ftp://, null)', () => {
    const r = parseCorsOrigins(
      'http://ok.example,file:///etc/passwd,ftp://nope,https://alsook.example,null',
    );
    expect(r.origins).toEqual(['http://ok.example', 'https://alsook.example']);
  });

  it('trims whitespace around each entry', () => {
    const r = parseCorsOrigins('  http://a.example ,  https://b.example  ');
    expect(r.origins).toEqual(['http://a.example', 'https://b.example']);
  });

  it('drops empty entries (double comma, trailing comma)', () => {
    const r = parseCorsOrigins('http://a.example,,https://b.example,');
    expect(r.origins).toEqual(['http://a.example', 'https://b.example']);
  });

  it('falls back to default when every entry is rejected', () => {
    const r = parseCorsOrigins('*,file://x,ftp://y');
    expect(r.origins).toEqual([...DEFAULT_CAMOFOX_CORS_ORIGINS]);
    expect(r.isDefault).toBe(true);
  });
});

describe('DEFAULT_CAMOFOX_CORS_ORIGINS', () => {
  it('contains the local dev origin and the Vercel production origin', () => {
    expect(DEFAULT_CAMOFOX_CORS_ORIGINS).toContain('http://localhost:3000');
    expect(DEFAULT_CAMOFOX_CORS_ORIGINS).toContain('https://mashupforge.vercel.app');
  });

  it('contains no wildcard', () => {
    expect(DEFAULT_CAMOFOX_CORS_ORIGINS).not.toContain('*');
  });

  it('contains only http(s) origins', () => {
    for (const origin of DEFAULT_CAMOFOX_CORS_ORIGINS) {
      expect(origin.startsWith('http://') || origin.startsWith('https://')).toBe(true);
    }
  });
});

describe('formatCorsOrigins', () => {
  it('roundtrips a valid input through parse + format', () => {
    const input = 'http://a.example,https://b.example';
    const parsed = parseCorsOrigins(input);
    expect(formatCorsOrigins(parsed)).toBe(input);
  });

  it('formats the default whitelist as comma-separated', () => {
    const parsed = parseCorsOrigins(null);
    const formatted = formatCorsOrigins(parsed);
    expect(formatted.split(',').length).toBe(DEFAULT_CAMOFOX_CORS_ORIGINS.length);
    expect(formatted).toContain('http://localhost:3000');
    expect(formatted).toContain('https://mashupforge.vercel.app');
  });
});

describe('resolveCorsOrigins', () => {
  it('is a thin pass-through to parseCorsOrigins', () => {
    const a = parseCorsOrigins('http://x.example');
    const b = resolveCorsOrigins('http://x.example');
    expect(b).toEqual(a);
  });
});
