// TECHDEBT-001: UI tokens. Designer found three different success-greens
// (emerald-400/500/600) and ten distinct gold border opacities scattered
// across MainContent.tsx. This module names the canonical shades per role
// so future markup picks the *intent* (success text vs success solid vs
// success hover) instead of guessing a Tailwind shade.
//
// These are plain string constants, not a Tailwind plugin — Tailwind's
// JIT only sees literal class names in source, so building dynamic class
// strings at runtime would produce missing CSS. Each token below is a
// fully-formed class fragment that JIT can statically extract.
//
// Adding a new token? Verify it actually appears in compiled markup
// (interpolating into a className), not just imported and concatenated
// out of view, otherwise Tailwind will tree-shake it away.

// ── Status palette ──────────────────────────────────────────────────────────
// One token per (state × role) cell. `text` reads on dark bg; `solid`
// is a button/pill background; `solidHover` is the darker hover state;
// `border` and `subtleBg` compose translucent badge variants.

export const status = {
  success: {
    text: 'text-emerald-400',
    solid: 'bg-emerald-500',
    solidHover: 'hover:bg-emerald-600',
    border: 'border-emerald-500/30',
    subtleBg: 'bg-emerald-500/10',
  },
  warn: {
    text: 'text-amber-400',
    solid: 'bg-amber-500',
    solidHover: 'hover:bg-amber-600',
    border: 'border-amber-500/30',
    subtleBg: 'bg-amber-500/10',
  },
  error: {
    text: 'text-red-400',
    solid: 'bg-red-500',
    solidHover: 'hover:bg-red-600',
    border: 'border-red-500/30',
    subtleBg: 'bg-red-500/10',
  },
  info: {
    text: 'text-[#00e6ff]',
    solid: 'bg-[#00e6ff]',
    solidHover: 'hover:bg-[#33eaff]',
    border: 'border-[#00e6ff]/30',
    subtleBg: 'bg-[#00e6ff]/10',
  },
} as const;

// ── Brand gold border + tint scale ──────────────────────────────────────────
// The brand gold (#c5a062) was used at ten different opacities across
// MainContent. Collapse to four documented steps. Use `subtle` for
// passive surfaces, `default` for active borders / focused chrome,
// `strong` for hover states + focus rings, and `solid` only when the
// gold itself needs to read at full saturation (rarely — usually text).

export const gold = {
  hex: '#c5a062',
  text: 'text-[#c5a062]',
  border: {
    subtle: 'border-[#c5a062]/15',
    default: 'border-[#c5a062]/30',
    strong: 'border-[#c5a062]/50',
  },
  bg: {
    subtle: 'bg-[#c5a062]/10',
    default: 'bg-[#c5a062]/15',
    strong: 'bg-[#c5a062]/25',
  },
  ring: 'focus:ring-[#c5a062]/30',
} as const;

// ── Surface chrome ──────────────────────────────────────────────────────────
// Three depth layers + the canonical hairline border. zinc-800/60 was the
// dominant border weight in the codebase (38 occurrences) — keep it as
// the default. Use `surface.canvas` for full-bleed page background,
// `surface.raised` for cards/panels, `surface.elevated` for inputs and
// other raised controls inside a card.

export const surface = {
  canvas: 'bg-zinc-950',
  raised: 'bg-zinc-900',
  elevated: 'bg-zinc-800',
  hairline: 'border-zinc-800/60',
} as const;

// ── Composite recipes ───────────────────────────────────────────────────────
// Common multi-token combinations that appeared verbatim many times.
// Use these when the whole recipe matches; otherwise compose the parts
// above directly.

export const recipes = {
  /** A small status pill with subtle bg + matching text + soft border. */
  pillSuccess: `${status.success.subtleBg} ${status.success.text} ${status.success.border}`,
  pillWarn: `${status.warn.subtleBg} ${status.warn.text} ${status.warn.border}`,
  pillError: `${status.error.subtleBg} ${status.error.text} ${status.error.border}`,
  pillInfo: `${status.info.subtleBg} ${status.info.text} ${status.info.border}`,
  /** The dark input/select chrome used in modals and toolbars. */
  inputChrome: `${surface.canvas} border ${surface.hairline} ${gold.ring}`,
} as const;
