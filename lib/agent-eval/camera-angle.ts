/**
 * v1.2.3 — Eval heuristic: camera angle.
 *
 * Checks whether the prompt specifies a camera angle. MashupForge
 * ships a "framing:camera-angles" skill that nudges the model
 * to include one; this heuristic measures compliance.
 *
 * A prompt scores high when it names a known angle keyword
 * (case-insensitive). The keyword list is the documented
 * v1.0 set; v1.3 can extend it from a skill-loaded catalog.
 *
 * Pure function, no IO. Snapshot-tested in `aggregate.test.ts`.
 */

const ANGLE_KEYWORDS = [
  'low angle',
  'high angle',
  'dutch angle',
  'eye level',
  'overhead',
  'top-down',
  'birds eye',
  "bird's eye",
  'worm eye',
  'worm-eye',
  'wide angle',
  'telephoto',
  'fisheye',
  'panorama',
  '45 degree',
  '45°',
  '90 degree',
  '90°',
  'close-up',
  'close up',
  'extreme close-up',
  'medium shot',
  'wide shot',
  'extreme wide',
  'over the shoulder',
  'pov',
  'point of view',
  'first person',
  'third person',
] as const;

export interface CameraAngleResult {
  /** 0..1; 1.0 = at least one known angle keyword present, 0.5 = partial match, 0 = none. */
  score: number;
  /** True if the prompt names a known angle keyword. */
  hasExplicitAngle: boolean;
  /** The first matched angle keyword (for the Replay UI badge). */
  matched: string | null;
}

export function evalCameraAngle(prompt: string): CameraAngleResult {
  const lowered = prompt.toLowerCase();
  for (const kw of ANGLE_KEYWORDS) {
    if (lowered.includes(kw)) {
      return { score: 1, hasExplicitAngle: true, matched: kw };
    }
  }
  // Partial-credit: prompt mentions "angle" or "view" but not a known keyword.
  if (lowered.includes('angle') || lowered.includes('view') || lowered.includes('shot')) {
    return { score: 0.5, hasExplicitAngle: false, matched: null };
  }
  return { score: 0, hasExplicitAngle: false, matched: null };
}
