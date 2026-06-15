/**
 * 4NE-26 — Deterministic request-hash tests.
 *
 * Pure functions, no storage/network. We assert:
 *   - stableHash is deterministic across calls and key order,
 *   - it depends ONLY on material fields (kind/target/payloadPreview), NOT on
 *     summary/requestId,
 *   - a tampered material field changes the hash,
 *   - canonicalize sorts object keys and preserves array order.
 */
import { describe, it, expect } from 'vitest';
import { stableHash, canonicalize, fnv1a32 } from '@/lib/approval/hash';
import type { ApprovalRequest } from '@/lib/approval/types';

function req(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    kind: 'publish',
    summary: 'Publish 2 assets to instagram',
    target: 'instagram:my-connector',
    payloadPreview: { assetIds: ['a', 'b'], caption: 'hi' },
    ...over,
  };
}

describe('canonicalize', () => {
  it('sorts object keys so insertion order does not matter', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('preserves array order (order IS significant)', () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it('drops undefined-valued keys (matching JSON.stringify)', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it('is stable for nested structures regardless of key order', () => {
    const x = { outer: { z: 1, a: [{ q: 1, p: 2 }] } };
    const y = { outer: { a: [{ p: 2, q: 1 }], z: 1 } };
    expect(canonicalize(x)).toBe(canonicalize(y));
  });
});

describe('fnv1a32', () => {
  it('is deterministic and returns 8 hex chars', () => {
    const h = fnv1a32('hello');
    expect(h).toBe(fnv1a32('hello'));
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it('differs for different inputs', () => {
    expect(fnv1a32('hello')).not.toBe(fnv1a32('world'));
  });
});

describe('stableHash', () => {
  it('is deterministic across calls', () => {
    expect(stableHash(req())).toBe(stableHash(req()));
  });

  it('ignores summary and requestId (non-material)', () => {
    const a = stableHash(req({ summary: 'one', requestId: 'r1' }));
    const b = stableHash(req({ summary: 'totally different wording', requestId: 'r2' }));
    expect(a).toBe(b);
  });

  it('is stable regardless of payloadPreview key order', () => {
    const a = stableHash(req({ payloadPreview: { caption: 'hi', assetIds: ['a', 'b'] } }));
    const b = stableHash(req({ payloadPreview: { assetIds: ['a', 'b'], caption: 'hi' } }));
    expect(a).toBe(b);
  });

  it('changes when the target changes', () => {
    expect(stableHash(req({ target: 'instagram:x' }))).not.toBe(
      stableHash(req({ target: 'pinterest:x' })),
    );
  });

  it('changes when the kind changes', () => {
    expect(stableHash(req({ kind: 'publish' }))).not.toBe(
      stableHash(req({ kind: 'irreversible' })),
    );
  });

  it('changes when the payload is tampered (different caption)', () => {
    const original = stableHash(req({ payloadPreview: { assetIds: ['a'], caption: 'real' } }));
    const tampered = stableHash(req({ payloadPreview: { assetIds: ['a'], caption: 'evil' } }));
    expect(original).not.toBe(tampered);
  });
});
