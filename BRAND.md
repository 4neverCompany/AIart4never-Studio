# MashupForge — Brand Kit

This is the **canonical source** for the MashupForge brand tokens.
The same tokens are referenced from `CONTRIBUTING.md` and the code
(`app/globals.css`, `tailwind.config.*`, `components/`) so that
contributors and reviewers always know what "on-brand" means.

If a token is added or changed here, the corresponding code values
in `app/globals.css` and `tailwind.config.*` must be updated to
match. The CI brand-name guard
(`.github/workflows/brand-guards.yml`) enforces the canonical
product name; see the *Forbidden product names* section below.

---

## 1. Product Names

| Use | Name | Notes |
| --- | --- | --- |
| Canonical product name | **MashupForge** | One word, capital M, capital F. Never split as "Mashup Forge", "MashupForge Studio", etc. |
| Short form (UI labels, tabs) | **MashupForge** | The full name fits almost everywhere. Avoid an acronym. |
| The maker | **4neverCompany** | Used in copyright notices, the `publisher` field of the Tauri bundle, and the email contact for security disclosures. |
| Watermark / channel default | **MashupForge** | When a user has not set a `channelName`, the watermark applied to exported images is "MashupForge". |
| Package name (`package.json`) | `mashupforge` | Lowercase, single word, no separators. |
| npm registry name | `mashupforge` | Matches `package.json`. |
| Cargo crate name | `app` | The Tauri shell keeps the Cargo crate name as `app` for cache stability (see `docs/bmad/reviews/POLISH-001.md` for the rationale); the *product* name is `MashupForge`, not the crate name. |

### Forbidden product names

The brand-guards CI workflow
(`.github/workflows/brand-guards.yml`) blocks the following strings
from appearing in any committed source file (with a small allowlist
for `CHANGELOG.md`, `README.md`, `docs/`, and a few landing-page
paths). Do not introduce these strings into new code or copy:

1. The retired v0.x package name — the lowercase, hyphenated
   codename the project used before being renamed to MashupForge.
   The package name in `package.json` is `mashupforge`; the old
   name is forbidden.
2. The retired v0.x product name — the multi-word "studio" name
   the product used before being renamed to MashupForge.
3. The retired short form of the v0.x product name — the
   one-phrase descriptor that appeared in many of the early
   content-niche pickers and AI prompts.
4. The corrupted PWA manifest name — a four-time-prefixed string
   that ended up in the early `public/manifest.json` and was
   rendered as the installed PWA name on Chrome / Edge.

If you need the exact string values for any of these (e.g. to
write a migration script or to check the brand-guards allowlist
in CI), see the `FORBIDDEN` array in
`.github/workflows/brand-guards.yml`. This file deliberately
omits the literal values so the brand-guards guard stays green.

---

## 2. Color Tokens

The 4neverCompany palette is restrained — three named tokens carry
the whole brand voice. Use these by name in code
(`var(--color-agency-black)`, etc.) and in Tailwind via the
custom utilities in `app/globals.css`.

| Token | Hex | OKLCH equivalent | Use for |
| --- | --- | --- | --- |
| **Agency Black** | `#050505` | `oklch(0.087 0.000 0)` | Backgrounds, deep surfaces, the NSIS installer's "About" panel, the desktop splash screen |
| **Metallic Gold** | `#C5A062` | `oklch(0.730 0.082 79.2)` | Borders, accents, highlights, the wordmark rule, "premium" / "vault" surfaces, success / saved states |
| **Electric Blue** | `#00E6FF` | `oklch(0.834 0.142 211.7)` | Buttons, active states, links, focus rings, the loading-screen ring, the CTA hero glow |

**Mode:** Dark mode is the default and the only fully supported
mode. There is no light-mode stylesheet. If a contributor is
building a component that reads badly on dark, it is a component
bug, not a theming gap.

**Aesthetic:** Premium, tech / circuit-board, restrained. Avoid
gradients on body copy; gradients are reserved for hero elements
and the wordmark rule. Avoid pure black `#000000` — always use
Agency Black `#050505` so the dark surfaces have a hint of
warmth.

**Don'ts:**
- No ad-hoc hex values. If you need a neutral that's not on this
  list, use the zinc scale (`bg-zinc-900`, `text-zinc-400`, etc.)
  — those are part of the design system but are explicitly
  *neutrals*, not branded colors.
- No neon green, no red, no purple. The brand does not use a
  fourth accent color. A red/green pair is acceptable for
  success/error semantics but should be muted (`emerald-500`,
  `rose-500`) and used sparingly.

---

## 3. Typography

| Token | Implementation | Use for |
| --- | --- | --- |
| **AETHER SANS** | `Space Grotesk` (Google Fonts, self-hosted via `next/font/google`) | Headings, body, UI labels — the entire default sans family. Loaded in `app/layout.tsx` as `--font-sans`. |
| **NEXUS MONO** | `JetBrains Mono` (Google Fonts, self-hosted via `next/font/google`) | Technical strings, code, hashes, timestamps, IDs, the in-app "stats" panel. Loaded in `app/layout.tsx` as `--font-mono`. |

**Why the aliasing?** "AETHER SANS" and "NEXUS MONO" are the
internal brand names. The actual open-source fonts (Space Grotesk,
JetBrains Mono) were chosen because they (a) carry the same
geometric-tech / "circuit-board" feel the brand calls for, (b) are
licensed under SIL OFL 1.1 which permits redistribution, and (c)
are already used as canonical system fonts in the 4neverCompany
design language. See `app/layout.tsx` for the mapping and
`NOTICE` §6 for license details.

**Type scale:** follow the Tailwind defaults (`text-sm`, `text-base`,
`text-lg`, `text-xl`, …) for body. For hero/display, use
`type-display` (defined in `app/globals.css` as the
`@layer components` rule that scales to `clamp(2.5rem, 5vw, 4rem)`).

---

## 4. Voice & Tone

MashupForge's copy voice is:

- **Terse and confident.** "Generate. Compare. Schedule." not
  "Welcome to our AI-powered content generation suite!".
- **Builder-facing.** Speak to the person who actually opens the
  terminal. Don't over-explain.
- **No marketing superlatives** in product UI. "Premium",
  "powerful", "next-generation" are reserved for the landing page
  and the public release notes — never inside the studio.
- **Emoji-light.** No emoji in product UI, ever. `lucide-react`
  icons only.

---

## 5. Where the tokens live in code

| Token group | Code location |
| --- | --- |
| Color CSS variables | `app/globals.css` (`:root { --color-agency-black: #050505; ... }`) |
| Tailwind utilities | `app/globals.css` (`@layer utilities` + the `bg-zinc-950` default body) |
| Font loading | `app/layout.tsx` (`Space_Grotesk`, `JetBrains_Mono` from `next/font/google`) |
| `type-display`, `type-muted` component classes | `app/globals.css` (`@layer components`) |
| Splash-screen wordmark / tagline | `src-tauri/frontend-stub/index.html` |

When you change a value here, change it in **all** of the
locations above. The brand-name guard CI does not (yet) lint for
hex-value drift; that is a code-review responsibility.

---

## 6. When to update this file

- Adding a new product surface that introduces a new color
  (e.g. a "warning amber" for destructive actions): add the token
  here first, then plumb it into `globals.css`.
- Renaming the product: update §1 (canonical name), then grep for
  the old name and update everywhere.
- Deprecating a token: keep it in the table with a "deprecated"
  note and a migration deadline; do not delete it silently.

---

*Maintained by the 4neverCompany design + engineering teams.
For questions, open a discussion in
`#brand-and-design` on the team chat, or file a PR against this
file directly.*
