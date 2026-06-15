/**
 * Dispatcher tests — gate-first publish with placeholder resolution.
 *
 * `@/lib/mcp` is mocked so `callMcpTool` is fully controllable and never hits
 * the network. `connect` is injected as a fake returning a client + close spy.
 * We assert:
 *   - the gate runs BEFORE connect (an unapproved set never connects),
 *   - child ids from prior steps are wired into the parent's `children` and the
 *     publish step's `creation_id`,
 *   - the final publish id is returned,
 *   - a mid-plan step error → { ok:false } AND the client is still closed,
 *   - extractId is defensive about result shape.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- mock the MCP primitive --------------------------------------------------
const callMcpToolSpy = vi.fn();
vi.mock('@/lib/mcp', () => ({
  callMcpTool: (...args: unknown[]) => callMcpToolSpy(...args),
  // connectMcp is injected in tests, but the module re-exports it; provide a
  // throwing stub so an accidental real-connect is loud.
  connectMcp: vi.fn(() => {
    throw new Error('real connectMcp should never be called in tests');
  }),
  getServer: vi.fn(async (id: string) => ({
    id,
    name: 'fake',
    transport: 'http' as const,
    url: 'https://mcp.example.com',
    enabled: true,
    trusted: true,
    addedAt: 0,
  })),
}));

import {
  publish,
  extractId,
  ApprovalRequiredError,
  buildPublishApprovalRequest,
} from '@/lib/publish/dispatch';
import type { DispatchRequest, PublishDeps } from '@/lib/publish/dispatch';
import type { PublishRequest } from '@/lib/publish/types';
import { requestApproval } from '@/lib/approval';
import type { ApprovalToken } from '@/lib/approval';
import type { GeneratedImage } from '@/types/mashup';

const closeSpy = vi.fn();
const connectSpy = vi.fn();

function fakeConnect() {
  closeSpy.mockResolvedValue(undefined);
  connectSpy.mockResolvedValue({ client: { __fake: true }, close: closeSpy });
  return connectSpy as unknown as PublishDeps['connect'];
}

function approved(id: string, url = `https://cdn/${id}.png`): GeneratedImage {
  return { id, prompt: 'p', url, approved: true };
}

/**
 * Mint a REAL approval token for a publish request via the unified chokepoint,
 * using an auto-approving operator stub (no network). This is exactly how a
 * production caller obtains the token it then hands to `publish`.
 */
async function tokenFor(request: PublishRequest): Promise<ApprovalToken> {
  const decision = await requestApproval(buildPublishApprovalRequest(request), {
    askOperator: async () => ({ verdict: 'approved' }),
  });
  if (!decision.token) throw new Error('test setup: expected an approval token');
  return decision.token;
}

/** A create result whose id is `containerId`. */
function createResult(containerId: string) {
  return [{ type: 'text', text: JSON.stringify({ id: containerId }) }];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('publish — gate enforcement', () => {
  it('an unapproved set returns ok:false and NEVER connects', async () => {
    const req: DispatchRequest = {
      target: 'instagram',
      connectorId: 'c',
      assets: [{ id: 'i1', url: 'https://cdn/i1.png' }],
      caption: 'x',
    };
    const deps: PublishDeps = {
      connect: fakeConnect(),
      assetsForGate: [{ id: 'i1', prompt: 'p', url: 'https://cdn/i1.png', approved: false }],
      // A VALID token so we get past the 4NE-26 token gate and exercise the
      // per-asset `approved`-flag gate that this test targets.
      approvalToken: await tokenFor(req),
    };

    const res = await publish(req, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/not approved/i);
    // The hard stop: gate threw before any network.
    expect(connectSpy).not.toHaveBeenCalled();
    expect(callMcpToolSpy).not.toHaveBeenCalled();
  });

  it('an empty set returns ok:false and never connects', async () => {
    const req: DispatchRequest = { target: 'instagram', connectorId: 'c', assets: [], caption: 'x' };
    const res = await publish(req, {
      connect: fakeConnect(),
      assetsForGate: [],
      approvalToken: await tokenFor(req),
    });
    expect(res.ok).toBe(false);
    expect(connectSpy).not.toHaveBeenCalled();
  });
});

describe('publish — 4NE-26 approval-token enforcement (no bypass)', () => {
  it('a MISSING token returns ok:false (ApprovalRequiredError) and NEVER connects', async () => {
    const req: DispatchRequest = {
      target: 'instagram',
      connectorId: 'c',
      assets: [{ id: 'i1', url: 'https://cdn/i1.png' }],
      caption: 'x',
    };
    const res = await publish(req, {
      connect: fakeConnect(),
      assetsForGate: [approved('i1')],
      // No valid token (cast around the required field to simulate a bypass attempt).
      approvalToken: undefined as unknown as ApprovalToken,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeInstanceOf(ApprovalRequiredError);
    expect(connectSpy).not.toHaveBeenCalled();
    expect(callMcpToolSpy).not.toHaveBeenCalled();
  });

  it('a MISMATCHED token (approved a different request) is rejected and never connects', async () => {
    const approvedReq: DispatchRequest = {
      target: 'instagram',
      connectorId: 'c',
      assets: [{ id: 'i1', url: 'https://cdn/i1.png' }],
      caption: 'original caption',
    };
    // Token bound to the original request...
    const token = await tokenFor(approvedReq);
    // ...but we attempt to publish a DIFFERENT request (caption tampered).
    const tamperedReq: DispatchRequest = { ...approvedReq, caption: 'tampered caption' };

    const res = await publish(tamperedReq, {
      connect: fakeConnect(),
      assetsForGate: [approved('i1')],
      approvalToken: token,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeInstanceOf(ApprovalRequiredError);
    expect(connectSpy).not.toHaveBeenCalled();
    expect(callMcpToolSpy).not.toHaveBeenCalled();
  });
});

describe('publish — Instagram carousel placeholder resolution', () => {
  it('wires child ids into the parent and returns the publish id', async () => {
    const assets = [
      { id: 'i1', url: 'https://cdn/i1.png' },
      { id: 'i2', url: 'https://cdn/i2.png' },
      { id: 'i3', url: 'https://cdn/i3.png' },
    ];
    // 3 children → child ids; parent → parent id; publish → published id.
    callMcpToolSpy
      .mockResolvedValueOnce(createResult('child-1'))
      .mockResolvedValueOnce(createResult('child-2'))
      .mockResolvedValueOnce(createResult('child-3'))
      .mockResolvedValueOnce(createResult('parent-9'))
      .mockResolvedValueOnce([{ type: 'text', text: JSON.stringify({ id: 'PUBLISHED_42' }) }]);

    const req: DispatchRequest = {
      target: 'instagram',
      connectorId: 'c',
      assets,
      caption: 'cap',
      igUserId: 'me',
    };
    const deps: PublishDeps = {
      connect: fakeConnect(),
      assetsForGate: assets.map((a) => approved(a.id, a.url)),
      approvalToken: await tokenFor(req),
    };

    const res = await publish(req, deps);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.publishedId).toBe('PUBLISHED_42');

    // 5 tool calls: 3 children + parent + publish.
    expect(callMcpToolSpy).toHaveBeenCalledTimes(5);

    // The parent call (4th) must have the resolved child ids in order.
    const parentCall = callMcpToolSpy.mock.calls[3]!;
    expect(parentCall[1]).toBe('INSTAGRAM_POST_IG_USER_MEDIA');
    expect(parentCall[2]).toMatchObject({
      media_type: 'CAROUSEL',
      children: ['child-1', 'child-2', 'child-3'],
      caption: 'cap',
    });

    // The publish call (5th) must reference the parent id, not the literal token.
    const publishCall = callMcpToolSpy.mock.calls[4]!;
    expect(publishCall[1]).toBe('INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH');
    expect(publishCall[2]).toMatchObject({ creation_id: 'parent-9' });

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('publish — single image', () => {
  it('resolves $parent to the single create id on the publish step', async () => {
    callMcpToolSpy
      .mockResolvedValueOnce(createResult('single-1'))
      .mockResolvedValueOnce(createResult('PUB-1'));

    const req: DispatchRequest = {
      target: 'instagram',
      connectorId: 'c',
      assets: [{ id: 'i1', url: 'https://cdn/i1.png' }],
      caption: 'one',
    };
    const res = await publish(req, {
      connect: fakeConnect(),
      assetsForGate: [approved('i1')],
      approvalToken: await tokenFor(req),
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.publishedId).toBe('PUB-1');
    const publishCall = callMcpToolSpy.mock.calls[1]!;
    expect(publishCall[2]).toMatchObject({ creation_id: 'single-1' });
  });
});

describe('publish — Pinterest', () => {
  it('runs the single create-pin step and returns the pin id', async () => {
    callMcpToolSpy.mockResolvedValueOnce(createResult('pin-77'));
    const req: DispatchRequest = {
      target: 'pinterest',
      connectorId: 'c',
      assets: [{ id: 'p1', url: 'https://cdn/p1.png' }],
      caption: 'pin it',
      boardId: 'board-1',
    };
    const res = await publish(req, {
      connect: fakeConnect(),
      assetsForGate: [approved('p1')],
      approvalToken: await tokenFor(req),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.publishedId).toBe('pin-77');
    expect(callMcpToolSpy).toHaveBeenCalledTimes(1);
    expect(callMcpToolSpy.mock.calls[0]![1]).toBe('PINTEREST_CREATE_PIN');
  });
});

describe('publish — error handling', () => {
  it('a mid-plan step error returns ok:false AND still closes the client', async () => {
    callMcpToolSpy
      .mockResolvedValueOnce(createResult('child-1'))
      .mockRejectedValueOnce(new Error('IG rate limit')); // 2nd child fails

    const assets = [
      { id: 'i1', url: 'https://cdn/i1.png' },
      { id: 'i2', url: 'https://cdn/i2.png' },
    ];
    const req: DispatchRequest = { target: 'instagram', connectorId: 'c', assets, caption: 'cap' };
    const res = await publish(req, {
      connect: fakeConnect(),
      assetsForGate: assets.map((a) => approved(a.id, a.url)),
      approvalToken: await tokenFor(req),
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/rate limit/i);
    // The client must be closed even on the failure path.
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('returns ok:false when the connector cannot be resolved', async () => {
    const req: DispatchRequest = {
      target: 'pinterest',
      connectorId: 'missing',
      assets: [{ id: 'p1', url: 'https://cdn/p1.png' }],
      caption: 'x',
      boardId: 'b',
    };
    const res = await publish(req, {
      connect: fakeConnect(),
      assetsForGate: [approved('p1')],
      approvalToken: await tokenFor(req),
      getConnector: async () => undefined,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/unknown connector/i);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('returns ok:false when the final step yields no extractable id', async () => {
    callMcpToolSpy
      .mockResolvedValueOnce(createResult('single-1'))
      // A result with no id-bearing key and no text part: nothing to extract.
      .mockResolvedValueOnce([{ type: 'image', mimeType: 'image/png' }]);
    const req: DispatchRequest = {
      target: 'instagram',
      connectorId: 'c',
      assets: [{ id: 'i1', url: 'https://cdn/i1.png' }],
      caption: 'x',
    };
    const res = await publish(req, {
      connect: fakeConnect(),
      assetsForGate: [approved('i1')],
      approvalToken: await tokenFor(req),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/no published id/i);
  });
});

describe('extractId — defensive shape handling', () => {
  it('reads a bare string id', () => {
    expect(extractId('abc123')).toBe('abc123');
  });
  it('reads { id }', () => {
    expect(extractId({ id: 'x1' })).toBe('x1');
  });
  it('reads alt id keys (creation_id, pin_id)', () => {
    expect(extractId({ creation_id: 'c9' })).toBe('c9');
    expect(extractId({ pin_id: 'p9' })).toBe('p9');
  });
  it('reads an MCP text-part array carrying JSON', () => {
    expect(extractId([{ type: 'text', text: '{"id":"t7"}' }])).toBe('t7');
  });
  it('reads a nested { data: { id } } envelope', () => {
    expect(extractId({ data: { id: 'd1' } })).toBe('d1');
  });
  it('returns undefined when no id is present', () => {
    expect(extractId({ foo: 'bar' })).toBeUndefined();
    expect(extractId([{ type: 'text', text: 'plain text, no json' }])).toBe('plain text, no json');
    expect(extractId(null)).toBeUndefined();
  });
});
