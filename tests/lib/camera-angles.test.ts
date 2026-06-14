// V1.0.7-PROMPT-ENG-A3: pin the 14-angle catalog contract that
// `components/Settings/CameraAnglePicker.tsx` and
// `lib/image-prompt-builder.ts` (buildMcslaFragment) rely on.
//
// This is a separate file from `image-prompt-builder-wiring.test.ts`
// because the catalog is a pure data file with its own invariants:
// 14 angles, 5 registers, unique ids, all entries shaped consistently.

import { describe, it, expect } from 'vitest';
import {
  CAMERA_ANGLES,
  CAMERA_ANGLE_IDS,
  CAMERA_ANGLE_REGISTER_LABELS,
  getCameraAngleById,
  getCameraAnglesByRegister,
} from '@/lib/camera-angles';

describe('lib/camera-angles — 14-angle catalog', () => {
  it('exposes exactly 14 angles', () => {
    expect(CAMERA_ANGLES).toHaveLength(14);
  });

  it('uses unique slugs across the 14 entries', () => {
    const ids = CAMERA_ANGLES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('matches the 5 emotional registers defined in the source skill', () => {
    const registers = new Set(CAMERA_ANGLES.map((a) => a.register));
    expect(registers).toEqual(
      new Set(['eye-level', 'low', 'high', 'dutch', 'intent']),
    );
  });

  it('exposes a non-empty promptFragment for every angle', () => {
    for (const a of CAMERA_ANGLES) {
      expect(typeof a.promptFragment).toBe('string');
      expect(a.promptFragment.trim().length).toBeGreaterThan(0);
    }
  });

  it('exposes a non-empty intent for every angle', () => {
    for (const a of CAMERA_ANGLES) {
      expect(typeof a.intent).toBe('string');
      expect(a.intent.trim().length).toBeGreaterThan(0);
    }
  });

  it('matches the breakdown the skill file documents (3 eye-level, 3 low, 3 high, 2 dutch, 3 intent)', () => {
    const grouped = getCameraAnglesByRegister();
    expect(grouped['eye-level']).toHaveLength(3);
    expect(grouped['low']).toHaveLength(3);
    expect(grouped['high']).toHaveLength(3);
    expect(grouped['dutch']).toHaveLength(2);
    expect(grouped['intent']).toHaveLength(3);
  });

  describe('getCameraAngleById', () => {
    it('returns the matching angle for a known slug', () => {
      const a = getCameraAngleById('low-angle-30');
      expect(a).toBeDefined();
      expect(a?.label).toBe('Low Angle (30°)');
      expect(a?.register).toBe('low');
    });

    it('returns undefined for an unknown slug', () => {
      expect(getCameraAngleById('not-a-real-angle')).toBeUndefined();
    });

    it('returns undefined for an empty / undefined input', () => {
      expect(getCameraAngleById(undefined)).toBeUndefined();
      expect(getCameraAngleById('')).toBeUndefined();
    });
  });

  describe('CAMERA_ANGLE_IDS', () => {
    it('matches the 14 ids in catalog order', () => {
      expect(CAMERA_ANGLE_IDS).toEqual(CAMERA_ANGLES.map((a) => a.id));
    });
  });

  describe('CAMERA_ANGLE_REGISTER_LABELS', () => {
    it('has a label for every register', () => {
      for (const reg of ['eye-level', 'low', 'high', 'dutch', 'intent'] as const) {
        expect(typeof CAMERA_ANGLE_REGISTER_LABELS[reg]).toBe('string');
        expect(CAMERA_ANGLE_REGISTER_LABELS[reg].length).toBeGreaterThan(0);
      }
    });
  });
});
