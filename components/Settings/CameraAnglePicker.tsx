'use client';

import { motion } from 'motion/react';
import { Camera, Check, X } from 'lucide-react';
import {
  CAMERA_ANGLES,
  CAMERA_ANGLE_REGISTER_LABELS,
  getCameraAngleById,
  getCameraAnglesByRegister,
  type CameraAngle,
  type CameraAngleRegister,
} from '@/lib/camera-angles';
import type { UserSettings } from '@/types/mashup';

interface CameraAnglePickerProps {
  /** Current value (a slug from CAMERA_ANGLES) or undefined. */
  value: string | undefined;
  /** Called with the new slug, or `undefined` to clear. */
  onChange: (next: string | undefined) => void;
  /** UserSettings for type inference. Not actually used at runtime
   *  but the prop keeps the parent aware of the wire shape. */
  settings: UserSettings;
  /** Optional: hide the helper subtitle (used when embedded inline). */
  compact?: boolean;
}

/**
 * V1.0.7-PROMPT-ENG-A3: Settings UI picker for the 14-angle camera
 * catalog. Renders one card per angle, grouped by the 5 emotional
 * registers. Click to select; click the same card or the "Clear"
 * button to deselect. The selected slug is written to
 * `UserSettings.cameraAngle` via the `onChange` prop.
 *
 * No external state — the parent owns `value`. This makes the
 * picker trivial to test (just pass a value + an onChange spy).
 */
export function CameraAnglePicker({ value, onChange, compact = false }: CameraAnglePickerProps) {
  const grouped = getCameraAnglesByRegister();
  const selected = getCameraAngleById(value);
  const registerOrder: CameraAngleRegister[] = ['eye-level', 'low', 'high', 'dutch', 'intent'];

  return (
    <div className="space-y-4">
      {!compact && (
        <div className="flex items-start justify-between gap-3">
          <p className="text-[11px] text-zinc-500 leading-relaxed flex-1">
            Optional <span className="text-zinc-400">lock</span>. Leave empty and the AI
            picks a fitting angle per image; pick one here to force that angle on every
            image in a batch. The chosen angle&apos;s lens + tilt + intent fold into the
            MCSLA director protocol.
            Source: <span className="text-zinc-400">banana-pro-director-camera-angles.md</span>.
          </p>
          {selected && (
            <button
              type="button"
              onClick={() => onChange(undefined)}
              className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-medium text-zinc-400 hover:text-zinc-200 bg-zinc-900/60 hover:bg-zinc-800/60 border border-zinc-800/60 transition-colors"
            >
              <X className="h-3 w-3" aria-hidden={true} />
              Clear
            </button>
          )}
        </div>
      )}

      <div className="space-y-4">
        {registerOrder.map((reg) => {
          const angles = grouped[reg];
          if (angles.length === 0) return null;
          return (
            <div key={reg}>
              <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-2 px-1">
                {CAMERA_ANGLE_REGISTER_LABELS[reg]}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {angles.map((a) => (
                  <AngleCard
                    key={a.id}
                    angle={a}
                    selected={value === a.id}
                    onClick={() => onChange(value === a.id ? undefined : a.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AngleCard({ angle, selected, onClick }: {
  angle: CameraAngle;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      whileHover={{ scale: 1.01 }}
      whileTap={{ scale: 0.99 }}
      className={[
        'group relative text-left p-3 rounded-xl border transition-colors',
        selected
          ? 'border-[#00e6ff] bg-[#00e6ff]/8'
          : 'border-zinc-800/60 bg-zinc-950/40 hover:border-zinc-700/60 hover:bg-zinc-900/40',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Camera
            className={`h-3.5 w-3.5 shrink-0 ${selected ? 'text-[#00e6ff]' : 'text-zinc-500 group-hover:text-zinc-400'}`}
            aria-hidden={true}
          />
          <div className="text-xs font-semibold text-zinc-100 truncate">{angle.label}</div>
        </div>
        {selected && (
          <Check className="h-3.5 w-3.5 text-[#00e6ff] shrink-0" aria-hidden={true} />
        )}
      </div>
      <p className="text-[10px] text-zinc-500 mt-1.5 leading-relaxed line-clamp-2">
        {angle.intent}
      </p>
    </motion.button>
  );
}

/** Re-export the catalog for callers that just want the list. */
export { CAMERA_ANGLES };
