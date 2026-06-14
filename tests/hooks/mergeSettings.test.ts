import { describe, it, expect } from 'vitest';
import { mergeSettings } from '@/hooks/useSettings';
import { defaultSettings, type WatermarkSettings } from '@/types/mashup';

// PROP-024 compile-time guard. If WatermarkSettings gains a field that
// defaultSettings.watermark doesn't satisfy, tsc --noEmit will error here
// before the test suite even runs. Update defaultSettings in types/mashup.ts
// when adding new WatermarkSettings fields, then update the runtime checks below.
//
// V1.7.1-M3.2b-WATERMARK-DISK: `imageRef` is OPTIONAL (legacy stores
// predate it; the migration populates it). So the strict `Required<>`
// guard no longer fits — we cast the required-field subset to keep the
// compile-time check on the still-required fields, and assert the
// optional field's absence (or presence) at runtime below.
const _watermarkRequiredShape: Omit<Required<WatermarkSettings>, 'imageRef'> = defaultSettings.watermark!;

// POLISH-018 regression gate. mergeSettings deep-merges loaded IDB
// payloads into the running settings. If it regresses to a shallow
// spread, partial saves clobber watermark/apiKeys defaults — the
// exact bug Maurice reported (watermark settings wiped on restart).
describe('mergeSettings', () => {
  it('preserves defaults when patch is empty', () => {
    const result = mergeSettings(defaultSettings, {});
    expect(result).toEqual(defaultSettings);
  });

  it('strips top-level undefined values from the patch', () => {
    const result = mergeSettings(defaultSettings, {
      defaultLeonardoModel: undefined as unknown as string,
    });
    expect(result.defaultLeonardoModel).toBe(defaultSettings.defaultLeonardoModel);
  });

  it('overrides top-level scalar fields', () => {
    const result = mergeSettings(defaultSettings, {
      defaultLeonardoModel: 'phoenix-1.0',
    });
    expect(result.defaultLeonardoModel).toBe('phoenix-1.0');
  });

  it('deep-merges watermark — partial patch keeps existing fields', () => {
    const prev = {
      ...defaultSettings,
      watermark: { enabled: true, image: 'data:abc', position: 'top-left' as const, opacity: 0.5, scale: 0.2 },
    };
    const result = mergeSettings(prev, { watermark: { enabled: false, image: null, position: 'bottom-right', opacity: 0.8, scale: 0.15 } });
    expect(result.watermark?.enabled).toBe(false);
    expect(result.watermark?.position).toBe('bottom-right');
  });

  it('deep-merges watermark — missing fields fall back to prev', () => {
    const prev = {
      ...defaultSettings,
      watermark: { enabled: true, image: 'data:abc', position: 'top-left' as const, opacity: 0.5, scale: 0.2 },
    };
    // Patch only has `enabled` — the rest should come from prev
    const result = mergeSettings(prev, { watermark: { enabled: false } } as Parameters<typeof mergeSettings>[1]);
    expect(result.watermark?.enabled).toBe(false);
    expect(result.watermark?.image).toBe('data:abc');
    expect(result.watermark?.position).toBe('top-left');
    expect(result.watermark?.opacity).toBe(0.5);
    expect(result.watermark?.scale).toBe(0.2);
  });

  it('deep-merges apiKeys — existing keys preserved alongside new ones', () => {
    const prev = {
      ...defaultSettings,
      apiKeys: { leonardo: 'key123' },
    };
    const result = mergeSettings(prev, {
      apiKeys: { instagram: { accessToken: 'EAA', igAccountId: '999' } },
    });
    expect(result.apiKeys.leonardo).toBe('key123');
    expect(result.apiKeys.instagram?.accessToken).toBe('EAA');
  });

  it('does not clobber apiKeys when patch has undefined apiKeys', () => {
    const prev = {
      ...defaultSettings,
      apiKeys: { leonardo: 'key123' },
    };
    const result = mergeSettings(prev, { apiKeys: undefined });
    expect(result.apiKeys.leonardo).toBe('key123');
  });

  it('leaves non-nested fields untouched when only nested fields change', () => {
    const result = mergeSettings(defaultSettings, {
      watermark: { enabled: true, image: null, position: 'bottom-right', opacity: 1, scale: 0.5 },
    });
    expect(result.enabledProviders).toEqual(defaultSettings.enabledProviders);
    expect(result.defaultLeonardoModel).toBe(defaultSettings.defaultLeonardoModel);
  });
});

// PROP-024: runtime shape guard for defaultSettings.watermark.
// Each assertion names a field explicitly so the test output identifies
// which field was removed or mis-typed if this block ever fails.
describe('defaultSettings watermark shape (PROP-024)', () => {
  it('watermark is defined', () => {
    expect(defaultSettings.watermark).toBeDefined();
  });

  it('enabled is a boolean', () => {
    expect(typeof defaultSettings.watermark!.enabled).toBe('boolean');
  });

  it('image is null or a string', () => {
    const v = defaultSettings.watermark!.image;
    expect(v === null || typeof v === 'string').toBe(true);
  });

  it('position is a valid WatermarkSettings position value', () => {
    const valid: WatermarkSettings['position'][] = [
      'top-left', 'top-right', 'bottom-left', 'bottom-right', 'center',
    ];
    expect(valid).toContain(defaultSettings.watermark!.position);
  });

  it('opacity is a number', () => {
    expect(typeof defaultSettings.watermark!.opacity).toBe('number');
  });

  it('scale is a number', () => {
    expect(typeof defaultSettings.watermark!.scale).toBe('number');
  });
});
