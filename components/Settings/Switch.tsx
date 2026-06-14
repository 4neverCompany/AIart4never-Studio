'use client';

/**
 * M4 unified control kit — the single toggle/switch used across Settings.
 * Replaces the 7 hand-rolled toggles that had drifted into two sizes, two
 * ARIA patterns, and two accent colors. One gold accent (#c5a062, Maurice's
 * call), one ARIA contract.
 *
 * ARIA: deliberately `aria-pressed` (toggle-button semantics) + an
 * "Enable/Disable {label}" aria-label — NOT role="switch"/aria-checked.
 * This matches the pre-existing ToggleRow + the Desktop platform toggles
 * that `tests/integration/desktop-platform-toggle.test.tsx` pins by
 * `aria-pressed` and `getByLabelText('Enable/Disable X')`. Keeping that
 * contract is what lets every call site adopt this component without a
 * behavioral/test change.
 *
 * Sizes:
 *   - `sm` (default): h-5 w-9 — the ToggleRow / Desktop-tab footprint.
 *   - `md`: h-6 w-11 — the larger SettingsModal / Watermark footprint.
 */
const SIZES = {
  sm: { track: 'h-5 w-9', thumb: 'h-4 w-4', on: 'translate-x-4' },
  md: { track: 'h-6 w-11', thumb: 'h-5 w-5', on: 'translate-x-5' },
} as const;

export interface SwitchProps {
  /** Current on/off state. */
  checked: boolean;
  /** Called with the NEXT value when toggled. */
  onChange: (next: boolean) => void;
  /**
   * The thing being toggled, as a noun phrase — used to build the
   * aria-label `Enable {label}` / `Disable {label}` (e.g. "Twitter / X",
   * "the agentic Director pipeline", "launch at startup").
   */
  label: string;
  disabled?: boolean;
  size?: keyof typeof SIZES;
}

export function Switch({ checked, onChange, label, disabled = false, size = 'sm' }: SwitchProps) {
  const sz = SIZES[size];
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      disabled={disabled}
      aria-pressed={checked}
      aria-label={checked ? `Disable ${label}` : `Enable ${label}`}
      className={[
        'relative inline-flex shrink-0 cursor-pointer rounded-full border-2 border-transparent',
        'transition-colors focus:outline-none focus:ring-2 focus:ring-[#c5a062]/40',
        sz.track,
        disabled
          ? 'bg-zinc-800 cursor-not-allowed opacity-40'
          : checked
            ? 'bg-[#c5a062]'
            : 'bg-zinc-700',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block transform rounded-full bg-white shadow transition-transform',
          sz.thumb,
          checked ? sz.on : 'translate-x-0',
        ].join(' ')}
      />
    </button>
  );
}
