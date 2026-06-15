/**
 * Instagram plan builder tests — the PROVEN Composio carousel sequence.
 *
 * N>1 → N child steps + 1 parent (children placeholders in order) + 1 publish.
 * N==1 → single create + publish. Caption + ig_user_id threading.
 */
import { describe, it, expect } from 'vitest';
import {
  buildInstagramPlan,
  IG_CREATE_MEDIA,
  IG_PUBLISH_MEDIA,
  PARENT_TOKEN,
  DEFAULT_IG_USER_ID,
  PUBLISH_MAX_WAIT_SECONDS,
} from '@/lib/publish/instagram';
import type { PublishRequest } from '@/lib/publish/types';

function req(over: Partial<PublishRequest> = {}): PublishRequest {
  return {
    target: 'instagram',
    connectorId: 'composio-ig',
    assets: [],
    caption: 'hello world',
    ...over,
  };
}

describe('buildInstagramPlan — carousel (N>1)', () => {
  const assets = [
    { id: 'i1', url: 'https://c/1.png' },
    { id: 'i2', url: 'https://c/2.png' },
    { id: 'i3', url: 'https://c/3.png' },
    { id: 'i4', url: 'https://c/4.png' },
  ];
  const plan = buildInstagramPlan(req({ assets, igUserId: 'ig-123' }));

  it('produces 4 child steps + 1 parent + 1 publish (6 total)', () => {
    expect(plan.steps).toHaveLength(6);
    expect(plan.target).toBe('instagram');
  });

  it('emits one carousel-child create per image, in order, with image_url', () => {
    for (let i = 0; i < 4; i++) {
      const step = plan.steps[i]!;
      expect(step.tool).toBe(IG_CREATE_MEDIA);
      expect(step.args).toMatchObject({
        ig_user_id: 'ig-123',
        is_carousel_item: true,
        image_url: assets[i]!.url,
      });
      // Children never carry a caption — only the parent does.
      expect(step.args.caption).toBeUndefined();
    }
  });

  it('parent references the child placeholders in order and carries the caption', () => {
    const parent = plan.steps[4]!;
    expect(parent.tool).toBe(IG_CREATE_MEDIA);
    expect(parent.args).toMatchObject({
      ig_user_id: 'ig-123',
      media_type: 'CAROUSEL',
      children: ['$child[0]', '$child[1]', '$child[2]', '$child[3]'],
      caption: 'hello world',
    });
  });

  it('final step publishes the parent via $parent placeholder + max_wait_seconds', () => {
    const pub = plan.steps[5]!;
    expect(pub.tool).toBe(IG_PUBLISH_MEDIA);
    expect(pub.args).toEqual({
      ig_user_id: 'ig-123',
      creation_id: PARENT_TOKEN,
      max_wait_seconds: PUBLISH_MAX_WAIT_SECONDS,
    });
  });
});

describe('buildInstagramPlan — single (N==1)', () => {
  const plan = buildInstagramPlan(
    req({ assets: [{ id: 'i1', url: 'https://c/1.png' }] }),
  );

  it('produces a single create + a publish (2 steps)', () => {
    expect(plan.steps).toHaveLength(2);
  });

  it('single create carries image_url + caption (no carousel flags)', () => {
    const create = plan.steps[0]!;
    expect(create.tool).toBe(IG_CREATE_MEDIA);
    expect(create.args).toEqual({
      ig_user_id: DEFAULT_IG_USER_ID,
      image_url: 'https://c/1.png',
      caption: 'hello world',
    });
  });

  it('publish references $parent (the single create) by creation_id', () => {
    const pub = plan.steps[1]!;
    expect(pub.tool).toBe(IG_PUBLISH_MEDIA);
    expect(pub.args.creation_id).toBe(PARENT_TOKEN);
  });
});

describe('buildInstagramPlan — defaults & guards', () => {
  it('defaults ig_user_id to "me" when not supplied', () => {
    const plan = buildInstagramPlan(req({ assets: [{ id: 'i1', url: 'u' }] }));
    expect(plan.steps[0]!.args.ig_user_id).toBe('me');
  });

  it('throws when there are no assets', () => {
    expect(() => buildInstagramPlan(req({ assets: [] }))).toThrow();
  });
});
