/**
 * Pinterest plan builder tests — single create-pin step shape.
 */
import { describe, it, expect } from 'vitest';
import { buildPinterestPlan, PINTEREST_CREATE_PIN } from '@/lib/publish/pinterest';
import type { PublishRequest } from '@/lib/publish/types';

function req(over: Partial<PublishRequest> = {}): PublishRequest {
  return {
    target: 'pinterest',
    connectorId: 'composio-pin',
    assets: [{ id: 'p1', url: 'https://c/pin.png' }],
    caption: 'a moody pin',
    boardId: 'board-42',
    ...over,
  };
}

describe('buildPinterestPlan', () => {
  it('produces a single create-pin step with board_id, image_url, description', () => {
    const plan = buildPinterestPlan(req());
    expect(plan.target).toBe('pinterest');
    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0]!;
    expect(step.tool).toBe(PINTEREST_CREATE_PIN);
    expect(step.args).toEqual({
      board_id: 'board-42',
      image_url: 'https://c/pin.png',
      description: 'a moody pin',
    });
  });

  it('pins the FIRST asset when multiple are supplied', () => {
    const plan = buildPinterestPlan(
      req({
        assets: [
          { id: 'p1', url: 'https://c/first.png' },
          { id: 'p2', url: 'https://c/second.png' },
        ],
      }),
    );
    expect(plan.steps[0]!.args.image_url).toBe('https://c/first.png');
  });

  it('threads options.link through as the pin link when present', () => {
    const plan = buildPinterestPlan(req({ options: { link: 'https://shop.example.com' } }));
    expect(plan.steps[0]!.args.link).toBe('https://shop.example.com');
  });

  it('throws when boardId is missing', () => {
    expect(() => buildPinterestPlan(req({ boardId: undefined }))).toThrow();
  });

  it('throws when there are no assets', () => {
    expect(() => buildPinterestPlan(req({ assets: [] }))).toThrow();
  });
});
