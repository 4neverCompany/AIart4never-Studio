import { describe, it, expect } from 'vitest';
import { getErrorMessage, isError } from '@/lib/errors';

describe('getErrorMessage', () => {
  it('returns Error.message for Error instances', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns the value itself when given a string', () => {
    expect(getErrorMessage('plain')).toBe('plain');
  });

  it('extracts .message from object-shaped errors with a string message', () => {
    expect(getErrorMessage({ message: 'shaped' })).toBe('shaped');
  });

  it('falls back to JSON.stringify for arbitrary objects', () => {
    expect(getErrorMessage({ code: 42 })).toBe('{"code":42}');
  });

  it('returns "Unknown error" for circular structures that fail JSON.stringify', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(getErrorMessage(circular)).toBe('Unknown error');
  });

  it('stringifies null', () => {
    expect(getErrorMessage(null)).toBe('null');
  });

  it('returns "Unknown error" for undefined input', () => {
    expect(getErrorMessage(undefined)).toBe('Unknown error');
  });

  it('ignores non-string .message fields on object errors', () => {
    expect(getErrorMessage({ message: 42 })).toBe('{"message":42}');
  });
});

describe('isError', () => {
  it('narrows Error instances', () => {
    expect(isError(new Error('x'))).toBe(true);
    expect(isError(new TypeError('y'))).toBe(true);
  });

  it('rejects non-Error values', () => {
    expect(isError('string')).toBe(false);
    expect(isError({ message: 'shaped' })).toBe(false);
    expect(isError(null)).toBe(false);
    expect(isError(undefined)).toBe(false);
  });
});
