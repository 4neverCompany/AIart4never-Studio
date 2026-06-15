/**
 * THE HUMAN GATE tests — the product's core safety property.
 *
 * The gate must throw for: an empty set, ANY unapproved asset, and any approved
 * asset missing a url. It must pass only when every asset is explicitly
 * approved AND has a url. The soft watermark advisory must never throw.
 */
import { describe, it, expect } from 'vitest';
import {
  assertPublishable,
  softWatermarkWarnings,
  PublishGateError,
} from '@/lib/publish/gate';
import type { GeneratedImage } from '@/types/mashup';

function img(over: Partial<GeneratedImage> = {}): GeneratedImage {
  return {
    id: 'a1',
    prompt: 'p',
    url: 'https://cdn.example.com/a1.png',
    approved: true,
    ...over,
  };
}

describe('assertPublishable', () => {
  it('throws empty-set when the list is empty', () => {
    expect(() => assertPublishable([])).toThrow(PublishGateError);
    try {
      assertPublishable([]);
    } catch (e) {
      expect(e).toBeInstanceOf(PublishGateError);
      expect((e as PublishGateError).code).toBe('empty-set');
    }
  });

  it('throws not-approved when ANY asset is unapproved (approved !== true)', () => {
    try {
      assertPublishable([img(), img({ id: 'a2', approved: false })]);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PublishGateError);
      expect((e as PublishGateError).code).toBe('not-approved');
      expect((e as PublishGateError).assetIds).toEqual(['a2']);
    }
  });

  it('treats undefined approved as not-approved (no implicit pass)', () => {
    try {
      assertPublishable([img({ approved: undefined })]);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as PublishGateError).code).toBe('not-approved');
    }
  });

  it('throws missing-url when an approved asset lacks a url', () => {
    try {
      assertPublishable([img(), img({ id: 'a2', url: undefined })]);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PublishGateError);
      expect((e as PublishGateError).code).toBe('missing-url');
      expect((e as PublishGateError).assetIds).toEqual(['a2']);
    }
  });

  it('throws missing-url for a blank/whitespace url', () => {
    try {
      assertPublishable([img({ url: '   ' })]);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as PublishGateError).code).toBe('missing-url');
    }
  });

  it('passes when every asset is approved and has a url', () => {
    expect(() =>
      assertPublishable([img(), img({ id: 'a2' }), img({ id: 'a3' })]),
    ).not.toThrow();
  });

  it('checks approval BEFORE url (an unapproved set without urls reports not-approved)', () => {
    try {
      assertPublishable([img({ approved: false, url: undefined })]);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as PublishGateError).code).toBe('not-approved');
    }
  });
});

describe('softWatermarkWarnings', () => {
  it('warns for assets with no watermark tag marker', () => {
    const warnings = softWatermarkWarnings([
      img({ id: 'a1', tags: ['cyberpunk'] }),
      img({ id: 'a2', tags: ['watermarked'] }),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('a1');
  });

  it('returns no warnings when all assets carry a watermark marker', () => {
    expect(
      softWatermarkWarnings([img({ tags: ['watermark'] })]),
    ).toEqual([]);
  });

  it('never throws on assets with no tags', () => {
    expect(() => softWatermarkWarnings([img({ tags: undefined })])).not.toThrow();
    expect(softWatermarkWarnings([img({ tags: undefined })])).toHaveLength(1);
  });
});
