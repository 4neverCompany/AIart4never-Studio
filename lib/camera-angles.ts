/**
 * V1.0.7-PROMPT-ENG-A3: Master Camera Angles catalog.
 *
 * 14 named camera angles mapped to emotional intent, drawn from
 * `docs/research/higgsfield-skills/banana-pro-director-camera-angles.md`.
 * Each entry exposes a stable `id` (stored in UserSettings.cameraAngle),
 * a `label` (shown in the picker), and a `promptFragment` that gets
 * folded into the MCSLA `C:` slot in the composed prompt.
 *
 * The 14 are split into 5 emotional registers:
 *   - eye-level (neutrality, connection)
 *   - low      (power, dominance, scale)
 *   - high     (vulnerability, detail, god's-eye)
 *   - dutch    (tension, chaos, unease)
 *   - intent   (psychological hooks — OTS, POV, macro)
 *
 * The picker UI in `components/Settings/CameraAnglePicker.tsx` renders
 * these grouped by register, and writes `settings.cameraAngle = id`
 * on click. `lib/image-prompt-builder.ts` reads it back via
 * `getCameraAngleById(id)` to assemble the MCSLA fragment.
 *
 * Source attribution lives in the skill file's comment header.
 */

export type CameraAngleRegister = 'eye-level' | 'low' | 'high' | 'dutch' | 'intent';

export interface CameraAngle {
  /** Stable slug; written to UserSettings.cameraAngle. */
  id: string;
  /** Human-readable label (English) shown in the picker. */
  label: string;
  /** Emotional register; used by the picker to group the 14. */
  register: CameraAngleRegister;
  /** One-line emotional intent, surfaced in the picker tooltip. */
  intent: string;
  /** Optional lens / focal length when the angle implies one. */
  lens?: string;
  /** Tilt/angle measurement when the angle is parametric. */
  angle?: string;
  /** Composed prompt fragment. Folded into the MCSLA `C:` slot
   *  by buildMcslaFragment. Built from `label` + `lens` + `angle`. */
  promptFragment: string;
}

const FRAGMENT = (label: string, lens?: string, angle?: string): string => {
  // Natural reading order: angle name first, then parametric
  // descriptors. Joined with `; ` to match the C-layer separator
  // used by buildMcslaFragment (movement, lens) — keeps the whole
  // C layer on a single separator convention.
  const bits: string[] = [label];
  if (angle) bits.push(angle);
  if (lens) bits.push(lens);
  return bits.join('; ');
};

export const CAMERA_ANGLES: readonly CameraAngle[] = [
  // ─── Eye level (neutrality, connection) ─────────────────────────
  { id: 'eye-level',            register: 'eye-level', label: 'Eye Level',              intent: 'Equality, honesty, neutral connection.',                      promptFragment: FRAGMENT('Eye Level') },
  { id: 'close-up-85',          register: 'eye-level', label: 'Close-up (85mm)',         intent: 'Intimacy, focus on facial emotion.',                          lens: '85mm', promptFragment: FRAGMENT('Close-up', '85mm') },
  { id: 'medium-shot-50',       register: 'eye-level', label: 'Medium Shot (50mm)',      intent: 'Natural conversation, everyday realism.',                     lens: '50mm', promptFragment: FRAGMENT('Medium shot', '50mm') },

  // ─── Low angles (power, dominance, scale) ───────────────────────
  { id: 'low-angle-30',         register: 'low',       label: 'Low Angle (30°)',        intent: 'Subtle authority, heroism.',                                  angle: '30° below eye level', promptFragment: FRAGMENT('Low angle', undefined, '30° below eye level') },
  { id: 'extreme-low-worms',    register: 'low',       label: 'Extreme Low (Worm\u2019s Eye)', intent: 'Absolute dominance, threat, monumental scale.',         angle: 'Worm\u2019s eye view',  promptFragment: FRAGMENT('Extreme low angle', undefined, 'Worm\u2019s eye view') },
  { id: 'wide-angle-close-up',  register: 'low',       label: 'Wide-Angle Close-up',    intent: 'Power distortion (Guy Ritchie energy), aggression.',         lens: '24mm',  promptFragment: FRAGMENT('Wide-angle close-up', '24mm') },

  // ─── High angles (vulnerability, detail, god's-eye) ─────────────
  { id: 'high-angle-30',        register: 'high',      label: 'High Angle (30°)',       intent: 'Subtle weakness, innocence.',                                 angle: '30° above eye level', promptFragment: FRAGMENT('High angle', undefined, '30° above eye level') },
  { id: 'extreme-high-bird',    register: 'high',      label: 'Extreme High (Bird\u2019s Eye)', intent: 'Disorientation, fate, god-like overview.',             angle: 'Bird\u2019s eye view',  promptFragment: FRAGMENT('Extreme high angle', undefined, 'Bird\u2019s eye view') },
  { id: 'top-down-flat-lay',    register: 'high',      label: 'Top-Down (Flat Lay)',    intent: 'Organisation, technical perfection, catalog feel.',          angle: 'top-down',             promptFragment: FRAGMENT('Top-down flat-lay', undefined, 'top-down') },

  // ─── Dutch (tension, chaos, unease) ─────────────────────────────
  { id: 'slight-tilt-5-10',     register: 'dutch',     label: 'Slight Tilt (5\u201310°)',    intent: 'Subtle discomfort, quiet unease.',                            angle: '5\u201310° tilt',      promptFragment: FRAGMENT('Slight Dutch tilt', undefined, '5\u201310° tilt') },
  { id: 'extreme-tilt-45',      register: 'dutch',     label: 'Extreme Tilt (45°)',     intent: 'Chaos, panic, reality fracture.',                             angle: '45° tilt',             promptFragment: FRAGMENT('Extreme Dutch tilt', undefined, '45° tilt') },

  // ─── Intent (psychological hooks) ───────────────────────────────
  { id: 'over-the-shoulder',    register: 'intent',    label: 'Over the Shoulder (OTS)', intent: 'Pulls the viewer into the scene.',                            promptFragment: FRAGMENT('Over-the-shoulder shot') },
  { id: 'pov',                  register: 'intent',    label: 'POV',                    intent: 'Total immersion — the viewer is the protagonist.',           promptFragment: FRAGMENT('First-person POV') },
  { id: 'macro',                register: 'intent',    label: 'Macro',                 intent: 'Obsession with detail, the microscopic.',                    lens: 'Macro lens', promptFragment: FRAGMENT('Macro shot', 'Macro lens') },
] as const;

export const CAMERA_ANGLE_IDS: readonly string[] = CAMERA_ANGLES.map((a) => a.id);

/** Resolve a UserSettings.cameraAngle slug to its full record. */
export function getCameraAngleById(id: string | undefined): CameraAngle | undefined {
  if (!id) return undefined;
  return CAMERA_ANGLES.find((a) => a.id === id);
}

/** Picker grouping helper: returns the 14 angles bucketed by register. */
export function getCameraAnglesByRegister(): Record<CameraAngleRegister, CameraAngle[]> {
  const out: Record<CameraAngleRegister, CameraAngle[]> = {
    'eye-level': [],
    'low': [],
    'high': [],
    'dutch': [],
    'intent': [],
  };
  for (const a of CAMERA_ANGLES) out[a.register].push(a);
  return out;
}

export const CAMERA_ANGLE_REGISTER_LABELS: Record<CameraAngleRegister, string> = {
  'eye-level': 'Eye Level — neutrality & connection',
  'low': 'Low Angles — power & dominance',
  'high': 'High Angles — vulnerability & overview',
  'dutch': 'Dutch Angles — tension & unease',
  'intent': 'Psychological Intent — OTS, POV, Macro',
};

// ─── V1.7.0-M2.1: contextual (AI-chosen) camera angle ───────────────────────
//
// Until v1.6.0 the camera angle was a single global `settings.cameraAngle`
// applied to every image in a batch — a noir close-up and a wide battle
// scene got the identical angle. M2.1 lets the idea-generation model pick a
// fitting angle PER prompt. The Settings picker is redefined from "the global
// value" to a "Default / Lock": when the user pins an angle there it wins;
// when it's empty the AI's per-item choice is used.

/** Compact menu of all valid angle ids + their emotional intent, injected
 *  into the idea-generation prompt so the model picks from the real catalog
 *  (and we can validate its choice by id). */
export function buildCameraAngleMenu(): string {
  return CAMERA_ANGLES
    .map((a) => `- ${a.id} (${a.register}): ${a.intent}`)
    .join('\n');
}

/** True when `id` is one of the 14 catalog slugs. */
export function isCameraAngleId(id: unknown): id is string {
  return typeof id === 'string' && CAMERA_ANGLES.some((a) => a.id === id);
}

/**
 * Resolve the angle that should actually drive the MCSLA `C:` fragment.
 * Precedence: a non-empty `settingAngle` is a user LOCK and always wins;
 * otherwise the AI's per-item `itemAngle` is used (when it's a valid id);
 * otherwise undefined (no fragment). Invalid ids are ignored, never passed
 * through to the composer.
 */
export function resolveEffectiveCameraAngle(
  settingAngle: string | undefined,
  itemAngle: string | undefined,
): string | undefined {
  if (isCameraAngleId(settingAngle)) return settingAngle;
  if (isCameraAngleId(itemAngle)) return itemAngle;
  return undefined;
}
