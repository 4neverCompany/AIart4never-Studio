import { describe, it, expect } from 'vitest';
import { ok, err, mapResult, unwrap, tryAsync } from '@/lib/result';

describe('result envelope', () => {
  it('ok narrows to value branch', () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it('err narrows to error branch', () => {
    const r = err('boom');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('boom');
  });

  it('mapResult transforms ok', () => {
    const r = mapResult(ok(2), (n) => n * 3);
    expect(r).toEqual({ ok: true, value: 6 });
  });

  it('mapResult passes err through', () => {
    const r = mapResult(err('x') as ReturnType<typeof err<string>>, (n: number) => n * 3);
    expect(r).toEqual({ ok: false, error: 'x' });
  });

  it('unwrap returns the value on ok', () => {
    expect(unwrap(ok('hi'))).toBe('hi');
  });

  it('unwrap throws an Error on err (Error instance)', () => {
    expect(() => unwrap(err(new Error('boom')))).toThrow('boom');
  });

  it('unwrap wraps string errors as Error', () => {
    expect(() => unwrap(err('boom'))).toThrow('boom');
  });

  it('tryAsync returns ok for resolved promises', async () => {
    const r = await tryAsync(async () => 7);
    expect(r).toEqual({ ok: true, value: 7 });
  });

  it('tryAsync returns err for rejected promises', async () => {
    const r = await tryAsync(async () => { throw new Error('nope'); });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.error as Error).message).toBe('nope');
  });
});
