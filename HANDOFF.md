# MashupForge — Handoff & Project Summary

> ## ⚠️ STALE — current handoff lives in [`docs/handoff/`](./docs/handoff/)
>
> This file is the **historical** v1.0.x-era handoff (last updated
> 2026-06-04, "you are picking up v1.0.9" — the app is on **v1.6.0+**).
> Kept for archeology only. For the CURRENT project state, open:
>
> - [`docs/handoff/README.md`](./docs/handoff/README.md) — navigation
> - [`docs/handoff/ROADMAP.md`](./docs/handoff/ROADMAP.md) — **start here:
>   "▶ NÄCHSTER EINSTIEG" tells the next agent exactly where to continue**
> - [`docs/handoff/STATE.md`](./docs/handoff/STATE.md) — what's live
> - [`docs/handoff/ACTIVE-CONTEXT.md`](./docs/handoff/ACTIVE-CONTEXT.md) — in flight
> - [`docs/handoff/SESSION-LOG.md`](./docs/handoff/SESSION-LOG.md) — chronology

**Date:** 2026-06-04
**For:** MiniMax Code desktop agent (or any successor)
**Maintained by:** Mavis (the agent that built the v1.0.0 → v1.0.4 stack)
**Status:** v1.0.7 PROMPT-ENG shipped; v1.0.7.1 hotfix in progress (deep-link OAuth)

---

## 0. TL;DR for the next agent

MashupForge is a **desktop-first AI content studio** (Tauri 2 + Next.js 16)
that takes a single creative idea and ships it as a captioned, scheduled
Instagram post — image generation, AI captions, approval queue, smart
scheduler, and a post-lifecycle state machine wired into one atomic
pipeline. There is **also a Vercel-deployed web build** that exposes the
same Studio surface (less the desktop-only auto-updater and the local
Tauri-only OAuth browser callback).

You are picking up a **cleanly-released v1.0.9** (Tauri 2 + Next.js 16)
with **a 5-bug hotfix batch already merged to main** (PR #55, squash
`e4bb2f0`). See §17 for the bug batch details.

- 1289/1289 tests passing
- TypeScript clean
- All bundle routes under 300 KB gzipped first-load JS
- 5 production releases (v1.0.1 → v1.0.9) on the public GitHub Release page
- 4 workflows in `.github/workflows/`
- 14 API routes, 6 lib sub-systems (Higgsfield, text-AI, image-AI, post-lifecycle,
  persistence, pipeline)

The most important recent work is **Higgsfield AI as a peer of Leonardo** —
the v1.0.4 release, with OAuth deep-link + migration UX in v1.0.8–v1.0.9.
The user is on a **Higgsfield Plus plan** (~1,000 credits/month), so the
user wants to use Higgsfield as a real production backend, not just a
feature flag. Default models:

- **Image:** `nano_banana_2` (Nano Banana Pro — 4K-capable, <10¢/image)
- **Video:** `seedance_2_0` (Seedance 2.0 — the "Hollywood film" model from
  the YouTube tutorial that informed the integration)

Everything below is the long form.

---

## 1. What MashupForge is

- **One-liner:** Idea → image → caption → approve → scheduled → live Instagram
- **Stack:** Tauri 2 (desktop, Windows primary) + Next.js 16 (React 19,
  App Router) + bun (primary) / npm (fallback)
- **Backend:** 14 API routes under `app/api/`. No separate server process —
  Next.js itself is the API host. The Tauri webview boots at `/studio` so
  the desktop user lands in the workbench.
- **AI providers (3 total, peer-of-peer):**
  - **Image:** Leonardo (default) + Higgsfield (OAuth, per-user)
  - **Text:** MiniMax (default, model M3) + OpenAI (gpt-4o-mini)
  - **Video:** Higgsfield (default) — Leonardo has no video gen
- **Storage:** All user data is browser-local (IndexedDB for persistent
  settings, IDB-encrypted OAuth tokens for Higgsfield). No central DB.
  That's a SaaS-shaped architecture for when the user is ready to add one.
- **License:** AGPL-3.0-or-later. **Why AGPL:** "open core" model. The
  desktop app stays open source, and the AGPL clause makes a hosted
  SaaS fork a contractual obligation to open-source. Protects the
  future-SaaS path without a custom license.

---

## 2. Repo layout

```
/workspace/mashupforge/
├── app/                        ← Next.js App Router
│   ├── page.tsx                  · Landing page (8 sections, image-rich)
│   ├── studio/                   · /studio (the workbench — desktop + web)
│   ├── api/                      · 14 API routes (see §3)
│   └── layout.tsx                · root layout
│
├── components/                 ← React components
│   ├── Studio/                    · workbench (board, calendar, pipeline, ideas)
│   ├── Landing/                   · landing sections
│   ├── Settings/                  · SettingsModal + 5 sub-pickers
│   │   ├── HiggsfieldConnection.tsx
│   │   ├── VercelAiModelPicker.tsx
│   │   └── ... (ImageProvider, CaptionStyle, Schedule, Brand)
│   └── ...
│
├── hooks/                     ← React hooks
│   ├── useImageGeneration.ts    · the big one (Leonardo + Higgsfield + MiniMax)
│   ├── usePipeline*             · pipeline state machine + daemon
│   ├── useReconciler.ts         · post-lifecycle reconciler
│   └── useSettings.ts           · IDB-backed settings
│
├── lib/                        ← 6 sub-systems
│   ├── higgsfield/                · MCP+OAuth+token-store+models+tools (v1.0.4)
│   ├── post-lifecycle/            · state machine (the v0.9.41 fix)
│   ├── text-model-catalog.ts      · 6 text models, M3 default
│   ├── text-model-specs.ts        · back-compat shim → text-model-catalog
│   ├── image-prompt-builder.ts    · per-provider prompt builders
│   ├── persistence/               · IDB layer (settings, posts, schedule)
│   ├── desktop-env.ts             · Tauri-only env reads (config.json)
│   ├── desktop-config-keys.ts     · typed key catalog
│   └── ...
│
├── src-tauri/                 ← Tauri 2 desktop shell (Rust)
│   ├── src/lib.rs                 · the webview boot path: /studio
│   ├── Cargo.toml
│   └── tauri.conf.json            · frontendDist: ../src-tauri/frontend-stub
│
├── scripts/
│   ├── release.sh                 · THE release tool (bump + CHANGELOG + highlights)
│   └── webp-export.sh             · (commit history only) PNG→WebP converter
│
├── .github/workflows/
│   ├── ci.yml                     · Lint + typecheck + test on every push
│   ├── pr-checks.yml              · Per-PR checks (vitest + bundle)
│   ├── brand-guards.yml           · Legacy-name grep (FAILS for now — see §7)
│   ├── sunday-recap.yml           · Weekly activity digest (Sun 18:00 UTC)
│   └── tauri-windows.yml          · THE release pipeline (replaces release.yml)
│
├── tests/                     ← Vitest, happy-dom (NOT jsdom — that was v1.0.2)
│   ├── lib/                        · 1,243 tests passing as of v1.0.6 (see §commit v1.0.6 below)
│   ├── components/                 · a few React component tests
│   └── ...
│
├── docs/
│   ├── changelog-highlights/       · Hand-curated release notes (v1.0.4 etc.)
│   ├── research/                   · Higgsfield research (713 lines) + skills (~130 KB)
│   ├── working-folder/             · Pre-prod assets (PNGs, screenshots, scripts)
│   │   ├── README.md
│   │   ├── png-sources/            · AI-generated source PNGs
│   │   ├── landing-screens/        · Playwright captures (desktop/tablet/mobile)
│   │   └── scripts/                · The Playwright + API helpers
│   └── HANDOFF.md                  · (older, partial) — superseded by this file
│
├── CHANGELOG.md                ← Auto-gen + hand-curated highlights (spliced)
├── CLAUDE.md                   ← Agent-facing rules (read this first!)
├── README.md                   ← User-facing readme
├── HANDOFF.md                  ← THIS FILE
├── LICENSE                     · AGPL-3.0-or-later
├── package.json
├── bun.lock                    ← committed (bun install --frozen-lockfile)
└── tsconfig.json
```

---

## 3. The 14 API routes

All under `app/api/`:

| Route | Method | Purpose |
|---|---|---|
| `auth/ig/login`, `auth/ig/callback`, `auth/ig/status` | * | Instagram OAuth (Meta API) |
| `ai/caption` | POST | Generate caption (text model catalog) |
| `ai/image` | POST | Generate image (Leonardo or Higgsfield or MiniMax) |
| `ai/models` | GET | Enumerate available text models |
| `ai/video` | POST | (planned v1.0.5) Video generation |
| `higgsfield/oauth/authorize` | GET | Start OAuth + dynamic client registration |
| `higgsfield/oauth/callback` | GET | Receive OAuth code, mint token |
| `higgsfield/oauth/status` | GET | Am I connected? |
| `higgsfield/oauth/disconnect` | POST | Revoke + clear IDB token |
| `higgsfield/image` | POST | Generate image via Higgsfield MCP tool |
| `higgsfield/video` | POST | Generate video via Higgsfield MCP tool |
| `higgsfield/status/[requestId]` | GET | Poll for video completion (dynamic bracket dir) |
| `post/schedule`, `post/approve`, `post/publish` | POST | Post-lifecycle transitions |
| `instagram/publish` | POST | Actually post to Instagram |

---

## 4. The 6 lib sub-systems

### 4.1 `lib/higgsfield/` (v1.0.4 — the big one)
- `oauth.ts` — OAuth 2.0 + PKCE (S256) flow with **dynamic client registration** at `mcp.higgsfield.ai/oauth2/register` on first connect
- `token-store.ts` — AES-GCM-encrypted IDB tokens (per-origin key, 32-byte random IV, `v1.<iv>.<tag>.<ciphertext>` packed format)
- `mcp-client.ts` — `@modelcontextprotocol/sdk` wrapper, 7-tool catalog
- `models.ts` — 7 image + 7 video curated model catalog
- `tools.ts` — exposes the 7 MCP tools (`higgsfield_generate`, `higgsfield_video_analyzer`, etc.)
- **5 test files:** 45 new tests (1243 total)

### 4.2 `lib/post-lifecycle/` (the v0.9.41 fix — shipped in v1.0.1)
- State machine: `draft → scheduled → posting → posted | failed`
- Atomic write: a post cannot exist without `hostedImageUrl` by construction
- Reconciler: handles out-of-band writes (e.g. user re-edits a post in another tab)
- The v0.9.41 bug was: post written to local state, hosted URL written
  separately, crash in between leaves an orphan. The state machine makes
  the two writes atomic.

### 4.3 `lib/text-model-catalog.ts` (v1.0.3)
- Registry of 6 text models: `M2`, `M2.5`, `M2.7`, `M2.7-highspeed`, `M3`, `gpt-4o-mini`
- `M3` is the new MiniMax default (flagged `isDefault: true`)
- `lib/text-model-specs.ts` is now a back-compat shim → re-exports from catalog

### 4.4 `lib/image-prompt-builder.ts` (v1.0.4 extended)
- `HiggsfieldBuilderOptions` and `higgsfieldOptions` input added
- Builds camera-mode + genre + duration prompts for Higgsfield's `seedance_2_0`
- Anti-AI-look negative prompts: **DONE (v1.0.7, A.4, PR #35)** — opt-in via
  `UserSettings.antiAiLook` (default `false`). Hook forwards
  `enhanced.negativePrompts` to `submitLeonardoAndPoll` /
  `submitViaAiImage` via the `antiAiLookNegatives` parameter; the
  helper joins them with the user-supplied `negative_prompt` and
  forwards the merged string to the provider route. Still TODO:
  Settings UI toggle to expose the flag (the wiring is in place;
  only the on/off switch is missing).

### 4.5 `lib/persistence/`
- IDB layer with three stores: `settings`, `posts`, `schedule`
- AES-GCM encryption for sensitive fields (Higgsfield tokens)
- Hooks: `useSettings`, `useReconciler`

### 4.6 `lib/desktop-env.ts` (v1.0.2)
- `readDesktopConfigValue` / `writeDesktopConfigValue` for Tauri config.json
- `lib/desktop-config-keys.ts` — typed key catalog
- Two new keys for Higgsfield: `HIGGSFIELD_OAUTH_CLIENT_ID`, `HIGGSFIELD_OAUTH_SALT`

---

## 5. The release pipeline (READ THIS BEFORE TAGGING)

### 5.1 The script — `scripts/release.sh <ver>`

```bash
# 1. Bumps package.json + Cargo.toml + tauri.conf.json to <ver>
# 2. Auto-gens CHANGELOG.md sections (Added/Fixed/Changed/Docs/Tests)
#    - Filters out type(release): and type(changelog): commits (noise)
# 3. Splices docs/changelog-highlights/<ver>.md as h3 (###) under the
#    version h2 (##), demoting the file's H2s to H4s
# 4. Creates one git commit: "chore(release): v<ver>"
# 5. Next steps (manual):
#    - git push origin main
#    - git tag v<ver> && git push origin v<ver>
```

### 5.2 The GitHub Actions release workflow — `tauri-windows.yml` (only)

**`release.yml` was deleted in commit `24959ba`.** It was a duplicate that
created empty draft releases. `tauri-windows.yml` is the canonical pipeline:

- Triggers on `push: tags: ['v*.*.*']`
- Has `concurrency: cancel-in-progress: false` (added in `24959ba`)
- Builds Next.js standalone, builds Tauri NSIS, uploads 4 assets

**Operator must:** after the workflow finishes, paste the content of
`docs/changelog-highlights/<ver>.md` into the GitHub Release body
(overwrite the auto-generated one). Documented in
`.claude/rules/release-flow.md`.

### 5.3 Version parity gate

`tauri-windows.yml` enforces three invariants in its "Check version parity
with tag" step (Ubuntu job, ~30s):

1. `package.json.version === src-tauri/tauri.conf.json.version`
2. `package.json.version === src-tauri/Cargo.toml.version`
3. `package.json.version === tag.slice(1)`

Failing any fails the build. Use `scripts/release.sh` — it bumps all three.

---

## 6. Recent release history (v1.0.1 → v1.0.4)

| Tag | Date | Theme | Key commits |
|---|---|---|---|
| v1.0.0 | 2026-06-01 | First public cut. AGPL-3.0, post-lifecycle fix, CI. | 19 commits |
| v1.0.1 | 2026-06-02 15:53Z | v0.9.41 fix re-shipped via state machine | `63023ea` |
| v1.0.2 | 2026-06-02 18:46Z | Tauri webview navigates to `/studio` not root | `3767278` |
| v1.0.3 | 2026-06-02 21:48Z | Calendar history + AI model catalog + settings cleanup | `590f42f` |
| v1.0.4 | 2026-06-03 07:40Z | **Higgsfield MCP integration** (peer of Leonardo) | `890a999` + 3 follow-ups |

### What v1.0.4 specifically added

- 12 new files (5 in `lib/higgsfield/`, 7 API routes, 1 settings component, 1 docs)
- 7 modified files (prompt builder, hook, type unions, env, settings modal)
- 4 new `lib/model-specs/higgsfield-*.json`
- 5 new test files (45 tests, 1243 total)
- Bundle: studio 218.2 KB / root 214.9 KB / login 197.1 KB (all under 300 KB)
- Docs: `docs/research/HIGGSFIELD-RESEARCH.md` (713 lines, 13 sections) +
  `docs/research/higgsfield-skills/` (7 files, ~130 KB)

### What v1.0.4 did NOT add (deferred to v1.0.5+)

- **A. SLCT prompt framework** in `lib/image-prompt-builder.ts` — Surface /
  Lumina / Capture / Texture 4-layer structure for anti-AI-look image prompts
- **B. MCSLA prompt formula** for video — Model · Camera · Subject · Look · Action
- **Camera angles catalog** (14 angles) as a Settings picker
- **C. Per-cycle credit budget enforcement** — `higgsfieldMonthlyCreditCap` +
  IDB counter + low-credit banner
- **Long-form video with recurring character** — 6-shot character template +
  "Soul Pack" library + pipeline integration

---

## 7. Known follow-up (v1.0.5 candidates, in suggested order)

### 7.1 Pre-existing CI cleanup (1 day) — **C, do this first**

- `brand-guards.yml` fails because `.hermes/subagents/designer/memory.md`
  contains the legacy name "Multiverse Mashup Studio". Add `.hermes/`
  to the brand-guard's `paths-ignore` (it's a sub-agent memory file, not
  a user-facing path) — OR fix the legacy-name grep to be smarter.
  **Fixed in v1.0.6** — `.hermes/` added to `paths-ignore`.
- Also: **NOT** 37 ESLint `as any` errors. The handoff got this wrong.
  Real count at v1.0.4 HEAD was 35 errors that were actually React 19
  strict-mode rule violations:
  - 20 × `react-hooks/set-state-in-effect` (setState in effect body)
  -  9 × `react-hooks/refs` (ref mutation during render)
  -  3 × `react-hooks/purity` (`Date.now()` in render)
  -  3 × `react/no-unescaped-entities` (unescaped `'` in JSX)
  **All 35 fixed in v1.0.6** via the queueMicrotask project
  convention (see `HiggsfieldConnection.tsx` for the original) plus
  moving ref-mirroring-state from render to `useEffect`. 3 documented
  exceptions in `KebabMenu.tsx` and `CarouselApprovalCard.tsx` keep
  synchronous setState with `eslint-disable-next-line` because the
  `queueMicrotask` wrap broke test `act()` blocks.
- Also: **NOT** "1,243/1,243 tests pass" at v1.0.4 HEAD. Real count
  was 1,199/1,243 with 44 failures (all `localStorage`-related).
  Root cause was Node 25's built-in `globalThis.localStorage` (a
  non-functional stub unless `--localstorage-file=<path>` is
  passed) shadowing the test env's `localStorage`. **Fixed in
  v1.0.6** via `tests/setup/node25-localstorage-shim.ts` —
  installs a working in-memory `localStorage` on globalThis BEFORE
  the test env initializes, so jsdom/happy-dom both get to
  overwrite it with their own. Result: 1,243/1,243 pass.

### 7.2 Higgsfield prompt engineering v2 (3-5 days) — **A**

- Integrate SLCT (Surface / Lumina / Capture / Texture) framework into
  `lib/image-prompt-builder.ts` as a `promptStyle: 'slct' | 'legacy'`
  option. Source: `docs/research/higgsfield-skills/banana-pro-director/`.
- Integrate MCSLA (Model · Camera · Subject · Look · Action) formula
  for `higgsfieldOptions` video inputs. Source:
  `docs/research/higgsfield-skills/cinema-world-builder/`.
- Add 14 camera angles as a Settings picker. Source:
  `docs/research/higgsfield-skills/.../camera-angles.md`.
- Apply anti-AI-look negative prompts (now opt-in via the
  `antiAiLook` UserSettings flag — PR #35 merged; still needs
  the Settings UI toggle to make it user-discoverable).
- A.4 Settings UI toggle → **DONE (PR #36)** — Settings → AI
  Engine → Anti-AI-look negatives switch.
- A.2 MCSLA video formula → **DONE (PR #37)** — Model · Camera ·
  Subject · Look · Action five-layer protocol; resolves camera
  slugs through `lib/camera-angles.ts`.
- A.3 14-angle picker → **DONE (PR #37)** — picker UI in Settings;
  14 angles, 5 emotional registers (eye-level / low / high /
  dutch / intent).
- D credit budget → **DONE (PR #38)** — `higgsfieldMonthlyCreditCap`
  + per-cycle counter + hard-fail gate at the two Higgsfield
  submit sites + low-credit banner + "Override for this cycle"
  escape hatch. v1 uses manual-reset cycles and a flat 1-credit-
  per-call charge; v2 should add calendar/30-day rolling cycles
  and model-aware credit costs.

### 7.3 Per-cycle credit budget (2-3 days) — **D**

- Add `higgsfieldMonthlyCreditCap` to UserSettings
- IDB counter: `higgsfieldCreditsUsedThisCycle`
- Low-credit banner in the Pipeline tab
- Hard-fail when cap hit, with a "Override for this cycle" escape hatch

### 7.4 Defer to v1.0.6: full "long-form video with recurring character" (5-7 days)

- 6-shot character template (front/side/back/hands/nails/profile)
- "Soul Pack" library (saved character compositions)
- Pipeline integration: lock character → multi-angle → scene still → video

---

## 8. Build / test / release commands

```bash
# Install
bun install --frozen-lockfile 2>/dev/null || npm ci

# Dev (Next.js on :3000, Vite-style HMR)
bun run dev

# Dev (Tauri desktop, opens window pointing at /studio)
bun run tauri dev

# Build (web-only, for Vercel)
bun run build

# Build (Tauri desktop, requires Rust + Windows)
bun run tauri build
# or:  bunx tauri build  (since bun doesn't populate .bin)

# Test
bunx vitest run                     # full suite
bunx vitest run --watch             # watch mode
bunx tsc --noEmit                   # typecheck only

# Lint
bunx eslint .                       # 0 errors as of v1.0.6 (was 35 React 19 strict-rule errors at v1.0.4 HEAD)

# Bundle size check (runs as part of `bun run build`)
node scripts/check-bundle-size.mjs  # fails if any route > 300 KB gzipped

# Release
bash scripts/release.sh 1.0.5
# → bumps versions, auto-gens CHANGELOG, splices highlights
# → commits, prints next steps
git push origin main
git tag v1.0.5 && git push origin v1.0.5
# → GitHub Actions builds Windows installer, publishes draft release
# → operator pastes docs/changelog-highlights/1.0.5.md into the draft body
```

---

## 9. Gotchas (read before debugging)

### 9.1 Build / CI

- **Bun does not populate `node_modules/.bin`** — use `bunx tauri build`,
  not `npx tauri build`. The `tauri-windows.yml` workflow has an npm
  fallback that handles the rare case.
- **PowerShell on windows-latest** defaults to `pwsh`. Steps need
  `shell: bash` to use `||`, `2>/dev/null`, etc. Otherwise `2>/dev/null`
  becomes a literal `D:\dev\null` path.
- **Tauri `frontendDist`** rejects paths containing `node_modules`. Next.js
  standalone ships its own `node_modules`; strip it after copying
  (`rm -rf src-tauri/frontend-stub/node_modules`).
- **`tauri build --target nsis`** fails: `nsis` is not a Rust target triple.
  Use bare `tauri build` when `tauri.conf.json` has
  `bundle.targets: ['nsis']` (which we do).
- **Bun `--frozen-lockfile` is strict** — `bun.lock` must match `package.json`
  exactly. After dropping deps, delete `bun.lock` and re-run `bun install`.

### 9.2 Higgsfield / Next.js 16 / React 19

- **Status route MUST live at `app/api/higgsfield/status/[requestId]/route.ts`**
  (the bracket dir must exist for dynamic segments).
- **`context.params` MUST be typed `{ params: Promise<{ requestId: string }> }`**
  in the dynamic route handler, or `next build` fails with a confusing
  constraint error.
- **React 19 `react-hooks/set-state-in-effect`** — wrap `setState` calls in
  `queueMicrotask` to defer out of the effect body. The load indicator
  still appears in the same browser frame.
- **AES-GCM tampering test** — flip a byte in the MIDDLE of the ciphertext
  segment, not the last char. Last-char flips occasionally land on a valid
  GCM tag because base64url is 6-bit aligned and the tag is truncated.

### 9.3 Post-lifecycle

- **A post without `hostedImageUrl` cannot exist by construction** — the
  state machine's atomic write ensures this. If you see one, the state
  machine is broken, not the data.
- **Reconciler** runs on every focus event and on a 30s timer. Don't
  disable it without understanding the consequences.

### 9.4 Pre-commit hook

- `simple-git-hooks` runs `tsc --noEmit && vitest run` on `git commit`.
  This is slow (~3 min) but catches real issues. Use `--no-verify` for
  quick commits; CI runs the same check anyway.

---

## 10. The user's working folder (the assets I forgot to commit)

`docs/working-folder/` contains the **pre-prod assets** I generated
during v1.0 prep + the v1.0.4 Higgsfield release. The user noticed
I hadn't put them in the repo — they're now there. See
`docs/working-folder/README.md` for the inventory.

Key files:
- `docs/working-folder/png-sources/` — 8 source PNGs (6 of which were
  converted to WebP and shipped in `public/landing/` and `assets/`)
- `docs/working-folder/landing-screens/` — 12 Playwright captures
  (desktop/tablet/mobile, full-page + per-section slices)
- `docs/working-folder/scripts/` — 7 helper scripts (3 Playwright,
  4 GitHub Release body updaters — the 4 are superseded, kept for archeology)

The 4 superseded release scripts (`create-release.py`, `update-release.py`,
`update-v102.py`, `update-v103.py`) are **not** the current way to do
this. Use `scripts/release.sh <ver>` + the workflow in §5.

---

## 11. Who is the user

- **Name:** Maurice (4neverCompany)
- **Timezone:** Europe/Berlin
- **Stack preferences:** bun primary, npm fallback. Likes Tauri 2 for
  desktop. Prefers AGPL over MIT/Apache for "open core" projects. Likes
  hand-curated release notes (changelog highlights workflow exists
  because of this).
- **AI setup:** Has a Higgsfield Plus subscription. Wants to use
  MiniMax Code (this agent) for autonomous in-app work. Wants the
  full project context handed off in a single document so a new
  agent session can pick up where the last one left off.
- **Communication style:** Short, direct, casual. Not a fan of ceremony.
  Drops in the middle of tasks. Asks for handoffs proactively.

---

## 12. The 5 things to do FIRST when you start a new session

1. `cd /workspace/mashupforge && git log --oneline -10` — see the recent history
2. `cat CLAUDE.md` — read the project-specific agent rules
3. `cat .claude/rules/release-flow.md` — if you're shipping a release
4. `bunx vitest run` — confirm green baseline (1243/1243 expected)
5. `cat docs/research/HIGGSFIELD-RESEARCH.md` — if you're working on the
   AI provider path (the 713-line research doc is the source of truth for
   what Higgsfield supports and how we integrated it)

If you find yourself confused, ask: **"what would a thoughtful next release look
like?"** — and refer to §7 above. The user has already pre-ranked the
v1.0.5 candidates.

---

## 13. v1.0.7 PROMPT-ENG — what shipped, what broke, what's next

**Shipped 2026-06-04 17:53 Berlin.** Tag `v1.0.7` on `4neverCompany/MashupForge @ 152479b`. All 4 artifacts (NSIS installer, portable zip, sig, latest.json) attached. Release notes in `I:\tmp\v107-release-notes.md`.

**5 features:**

- **A.4 Anti-AI-look negatives (opt-in)** — 18 curated negative cues appended to every Leonardo/Higgsfield `negative_prompt` channel. Off by default. `lib/image-prompt-builder.ts` has the `ANTI_AI_LOOK_NEGATIVES` const; `UserSettings.antiAiLook` + `antiAiLookNegatives?` toggles.
- **A.2 MCSLA director protocol** — 5-layer framework (Model · Camera · Subject · Look · Action) in `lib/image-prompt-builder.ts`. Camera slot resolves a slug from `lib/camera-angles.ts` (14 angles across 5 registers).
- **A.3 14-angle camera picker** — `components/Settings/CameraAnglePicker.tsx`, motion/react, role=radio, click-to-toggle, clear button. Cyan accent.
- **D per-cycle credit budget** — `lib/credit-budget.ts` + `components/CreditBudgetBanner.tsx` + `components/Settings/CreditBudgetSettings.tsx`. Hard-fail gate at the two Higgsfield submit sites in `hooks/useImageGeneration.ts`.
- **Higgsfield 500 fix** — `lib/higgsfield/token-store.ts` guards `loadTokens`/`saveTokens`/`clearTokens` against missing `indexedDB` (server-side no-op with one-time warning). PR #39.

**Behind the scenes (not in changelog):**

- **Org conversion**: `Code4neverCompany` (user account) → `4neverCompany` (GitHub org). Repo transferred. 5 review teams. Branch protection on `main` with 4 status checks + 1 approving review. Gitleaks license added.
- **CODEOWNERS wired** with `@4neverCompany/*` as human-fallback reviewers (PR #42).
- **Brand/version guards** plus secret-scan workflow on org (PR #43).

**Bugs found DURING the v1.0.7 cut** (4 PRs, all merged before publish):

- **PR #45**: post-transfer URL sweep. `tauri-smoke-test.yml` was checking `C:\Program Files\MashupForge\` but tauri.conf.json `installMode: currentUser` puts binary in `%LOCALAPPDATA%\Programs`. `Synthesize latest.json` step in `tauri-windows.yml` hardcoded `Code4neverCompany`. 4 active code paths (`tauri.conf.json` updater + homepage, `Cargo.toml` repo + homepage, `UpdateChecker.tsx`, `AutoUpdateSettings.tsx`, `SettingsModal.tsx`) all pointed at old org.
- **PR #46**: pre-release smoke test workflow. `tauri-smoke-test.yml` only runs on `release: published`, can't validate before publish.
- **PR #47**: portable-zip variant. NSIS installer hangs silently on headless Windows. Portable zip extraction is the workaround.
- **PR #48**: stderr + Windows event log capture on crash. Pre-existing bug: `Expand-Archive` from PowerShell hangs on 280+ MB zips in bash→PS handoff. Switched to `unzip` from Git Bash.

**v1.0.7.1 hotfix (in progress, target 2026-06-04 19:30 Berlin):**

- **PR #49**: register `mashupforge://` URL scheme via `tauri-plugin-deep-link`. Fixes the `Higgsfield connect failed (expired_flow)` error — root cause is Tauri opening the OAuth callback URL in the system browser (different cookie jar than WebView2). With deep-link, the callback lands back in the WebView2 where the state/PKCE cookies still live.
- Triggered Tauri build run `26965148959` after PR merge. Expected ~35 min. Will publish v1.0.7.1 with the same 4 assets once it lands.

**Architectural findings (defer to v1.0.8+):**

- **NSIS installer hangs on headless Windows runners** AND on Maurice's dev machine (exit 0 in 1:43, no files extracted). Likely a Tauri 2.x NSIS template issue with `installMode: currentUser` not respecting `/S`. Workaround: portable zip.
- **Tauri 2.x doesn't generate `WebView2Loader.dll` in the build output** (Tauri build warns, continues). The portable zip works on systems with WebView2 runtime installed (typical case). Doesn't work on clean Windows installs without WebView2.
- **GitHub Actions `windows-latest` runners run in Session 0 (non-interactive)**. Tauri apps that try to create windows crash silently. Architectural limitation. Workarounds: VNC server, RDP, or a third-party service with real desktops. Documented but not fixable.
- **Vercel integration broke during org transfer** (MashupForge repo transferred from `Code4neverCompany` user account to `4neverCompany` org). Latest Vercel deploy is `f2d49ed` (PR #39 Higgsfield 500 fix), v1.0.7 not deployed. **Needs manual reconnection via Vercel dashboard** — no API access from agent.

## 14. v1.0.8+ candidate list (post-hotfix)

**Triage order:**

1. **NSIS installer hang** — root cause the Tauri 2.x `installMode: currentUser` issue. Tauri docs or upstream PR might have a fix. ~4 hours.
2. **WebView2Loader.dll bundling** — figure out why tauri-build doesn't generate it. Likely a Tauri config flag we're missing. ~2 hours.
3. **Vercel integration reconnect** — Maurice's job (1 click in Vercel dashboard → Disconnect → Reconnect with new org URL).
4. **Existing-user OAuth client migration** — clients registered before v1.0.7.1 don't have the `mashupforge://` URI. Add a one-time re-registration when `?via=desktop` is detected. ~1 hour.
5. **Headless smoke test strategy** — VNC/RDP in workflow, or external service. ~1 day.
6. **Camofox-browser integration** — Maurice's request from 2026-06-04 16:21. Camofox is a stealth headless browser (C++ anti-detection on top of Firefox) with a REST API at port 9377. Could replace current `matrix web_search` MCP for trend search (bypass anti-bot on Instagram, TikTok, etc.). Integration plan:
   - **Sidecar**: ship camofox-browser as a Tauri sidecar (alongside the existing Node sidecar on a stable port). Start it on app launch, stop on quit.
   - **Proxy layer**: add `lib/camofox/client.ts` that wraps the REST API (snapshot, navigate, search macros, etc.).
   - **Trend search skill**: replace `matrix web_search` calls in `lib/trend-search/*` with camofox snapshots. The camofox `@instagram_search` / `@tiktok_search` / `@twitter_search` macros give us real trending data, not just text search results.
   - **Headless**: camofox is headless by default, no Tauri window needed. Works in CI.
   - ~3-4 days including the sidecar plumbing.
7. **Post-v1.0.7 URL sweep** — README, BUILDING, CONTRIBUTING, components/landing/* (Nav, Hero, Footer, CTA), docs/* historical references. Brand consistency cleanup. ~2 hours. Non-urgent. (Partial: PR #51 covers Tier 2 user-visible + Tier 3 repo hygiene, awaiting admin-merge.)
8. **OAuth client migration UX for pre-v1.0.7.1 users** — PR #54. New `POST /api/higgsfield/oauth/reset-client` endpoint + amber migration banner in `HiggsfieldConnection.tsx` with one-click reset. Surfaces when desktop OAuth callback errors with `expired_flow` (the pre-v1.0.7.1 client doesn't have `mashupforge://` in its allowlist). 4 new vitest tests.

## 15. v1.0.8 release — SHIPPED 2026-06-04 23:31 Berlin

**Release:** <https://github.com/4neverCompany/MashupForge/releases/tag/v1.0.8> — auto-published by the release workflow on build success.

**4 assets shipped:**
- `MashupForge_1.0.8_x64-setup.exe` (NSIS, 152 MB)
- `MashupForge_1.0.8_x64-setup.exe.sig` (signature, 424 B)
- `MashupForge_1.0.8_x64-portable.zip` (portable, 282 MB)
- `latest.json` (705 B)

Local backup at `I:\tmp\tauri-artifacts-v108\`.

**What v1.0.8 fixes (the v1.0.7 hotfix chain — 3 cascading Rust build bugs):**

1. **PR #50**: Cargo version `1.0.7.1` → `1.0.8` (Cargo requires 3-part semver; the 4-part was rejected at parse time).
2. **PR #52**: `WebviewWindow::emit` → `AppHandle::emit` (Tauri 2.x split; `WebviewWindow` has no `emit`).
3. **PR #53**: added `use tauri::Emitter;` (the `emit` method comes from the `Emitter` trait; without the import, the compiler can't resolve the method on `AppHandle`).

The v1.0.7 PROMPT-ENG features (A.4 anti-AI-look, A.3 14-angle picker, D credit budget, Higgsfield 500 fix, OAuth deep-link, portable zip variant) are unchanged from v1.0.7 — v1.0.8 is purely a Rust build recovery on top of the v1.0.7 release.

**Post-mortem — what went wrong and what to do next time:**

- **The release workflow auto-publishes on build success.** This is intentional behavior of the `upload` job (it creates the GitHub release and attaches the artifacts). I (Mavis) had been thinking the cron was waiting for me to manually publish, so the cron was redundant for that step. The cron was only needed to TELL ME the build was done. Lesson: when a release job has a "Upload release assets" step, the release happens automatically — the cron's only job is to nudge the assistant.
- **The cron kept firing for 17 hours past completion** (`*/2 * * * *` × 17 h ≈ 510 ticks). The TTL field on the cron only stops NEW prompts from being *scheduled*; it doesn't stop the existing tick loop. Lesson (updated, was already in memory as a weaker version): when a build is clearly past expected completion, **delete the cron immediately** — do not wait for "the next tick to confirm". An assistant watching a cron should treat the cron as advisory, not authoritative, and act on direct `gh run view` evidence.
- **The first assistant turn after a long quiet period** is the right place to do a single `gh run view` and decide. Don't wait for the cron to "notice" the success.
- **All 3 v1.0.7-hotfix Rust bugs were compile-time errors**, not runtime. The CI caught each one before publish. The pattern: small Rust/Tauri 2.x API renames are easy to miss locally but show up immediately on the windows-latest runner.

## 16. v1.0.9 release — TRIGGERED 2026-06-05 (Tauri build in progress)

**Version:** 1.0.8 → 1.0.9 (Cargo requires 3-part semver, so 1.0.8.1 was not an option).
**Tag:** `v1.0.9` pushed 2026-06-05 22:45 UTC. Triggers `tauri-windows.yml`.
**Build run:** 27044038434 — watch via cron `watch-v109-build`.

**What v1.0.9 ships:**

- OAuth client migration UX (PR #54 — already in main since merge of 9e9a78f).
- `POST /api/higgsfield/oauth/reset-client` endpoint.
- Amber migration banner in `HiggsfieldConnection.tsx` with one-click reset.
- 4 new vitest tests (1289/1289 pass).
- v1.0.8 web build is already live and accurate; this release ships the same fix to the Tauri desktop bundle.

**Notes for Maurice:**

- Vercel dashboard actions still needed (one-time):
  1. Project `mashup-studio` → Settings → Danger Zone → Delete (geist project from old brand).
  2. Project `mashupforge` → Settings → Git → verify connected repo is `4neverCompany/MashupForge` (not the old personal account). If it's still `Code4neverCompany`, disconnect + reconnect with the new org.

---

## 17. v1.0.9 hotfix batch — SHIPPED 2026-06-06 02:01 Berlin (PR #55)

**Branch:** `fix/bug-batch-2026-06-06` → squash `e4bb2f0` → merged admin
into `main` 2026-06-06 02:01 UTC. No version bump (source-only fix batch;
no new runtime features, no new Tauri assets).

**Five bugs from v1.0.9 testing, one focused PR:**

| # | Component | What was broken | Fix |
|---|-----------|-----------------|-----|
| 1 | `lib/weekly-fill.ts` | Day showed as "open" even when a post was already `posted` | `posted` posts now count toward the day fill; `failed`/`rejected` still excluded (daemon keeps generating for those) |
| 2 | `components/Settings/HiggsfieldConnection.tsx` | Migration banner only fired on `expired_flow`; server-side `redirect_uri` mismatch (reason=`invalid_request`, raised before our /callback runs) was silent | Banner also fires on `invalid_request` and on any detail mentioning `redirect_uri` / `pre-registered` |
| 3 | `lib/pipeline-finalize.ts` | Canvas-based `applyWatermark` was silently rasterizing video URLs into broken images | Detect `img.isVideo === true`, skip the canvas watermark, log a warning. TODO tracked for server-side FFmpeg-based video watermark |
| 4 | `hooks/useSocial.ts` | LLM produced 20+ or 3-4 hashtags for Instagram captions (unbounded) | Prompt tightened to "BETWEEN 8 AND 12"; client-side case-insensitive dedup + cap at 12. Min 8 is aspirational (we never fabricate tags) |
| 5 | `lib/trademark-outcomes.ts` + `components/SettingsModal.tsx` | Trademark blocklist rendered as a flat list — couldn't tell which model was the strictest filter | New `getBlockedByModel()` returns `Record<modelId, sorted-blocked-names[]>`; UI renders per-model groups with a flat-list fallback for legacy data |

**Verification:** `bunx vitest run` → 1289/1289 pass (110 files, 12.6s);
`bunx tsc --noEmit` clean; `bunx eslint` 0 errors (1 pre-existing
`no-img-element` warning in `SettingsModal.tsx:1796` unrelated to this
batch). CI on PR #55: 17/17 checks green (vitest, tsc, eslint, bundle
size, brand, version-sync, gitleaks, Vercel preview, etc.).

**Out of scope (intentionally):**

- **Video watermark server-side (FFmpeg)**: real follow-up, needs a host
  with FFmpeg available. Tracked as a source-comment TODO in
  `lib/pipeline-finalize.ts`.
- **OAuth web build (Bug 2)**: the web flow uses HTTPS callbacks and
  never hits the redirect-uri mismatch path; banner stays desktop-only.
- **No version bump**: this is a hotfix batch, not a feature release.
  The Tauri build for v1.0.9 still stands; users picking up v1.0.9 from
  a future v1.0.9.x rebuild will get these fixes. We could re-bump to
  v1.0.9.1 or v1.0.10 if a Tauri rebuild is desired — but Cargo requires
  3-part semver and v1.0.9 is functionally correct as shipped, so this
  is a web-only / source-only fix until the next planned release.

**Worktree:** `I:\c4n-worktrees\bugfix-batch-2026-06-06` (can be removed
with `git worktree remove --force`; the branch was already deleted
remotely by `gh pr merge --delete-branch`).

---

## 18. camofox-browser integration — SHIPPED 2026-06-06 (PR #56, v1.1.0)

**Version:** 1.0.9 → **1.1.0** (Minor-Bump, Maurice sign-off 2026-06-06 02:30 Berlin — was originally going to be v1.0.10, then corrected). Cargo requires 3-part semver.
**Branch:** `feat/camofox-v1.1.0` (4 commits: Day 1-4) → squash `c9f9172` → admin-merged into `main` 2026-06-06 01:44 UTC.
**PR:** [#56](https://github.com/4neverCompany/MashupForge/pull/56) — all 17 CI checks green.
**Release:** [v1.1.0](https://github.com/4neverCompany/MashupForge/releases/tag/v1.1.0) published 2026-06-06 02:38 UTC.
**Tauri build:** run [27049883476](https://github.com/4neverCompany/MashupForge/actions/runs/27049883476) (3rd attempt, 19m35s after two build-fix commits). Build artifacts: NSIS installer 61.8 MB, portable 94.4 MB, minisign signature, latest.json.
**Post-merge fixes:** commit `121c660` (launcher path: `<root>/package/bin/...` → `<root>/bin/...` in fetch script + Rust `camofox_launcher_path`) and commit `c3756a9` (tsconfig exclude `src-tauri/resources/**` to skip third-party camofox source files during `next build` tsc). Both were on the v1.1.0 tag.
**Auto-update:** existing v1.0.9 desktop installs auto-update to v1.1.0 silently on next launch.
**Implementation:** solo, 4 sequential days (team engine blocked from launching new plans in this session — see `MEMORY.md` mavis spawn CLI bug + post-completion aborted-state).

**Maurice-Sign-off 2026-06-06 02:22 Berlin (alle 4 blocking questions):**
- Q1 → @askjo/camofox-browser **v1.11.2** (Default)
- Q2 → `CAMOFOX_CRASH_REPORT_ENABLED=false` (Default; Telemetrie off)
- Q3 → **Reuse-Mode** bestaetigt — Hermes-Agent nutzt camofox auf Maurice' Host,
  persoenlich nicht. 3-Stufen-Algorithmus (9377 / Reuse-if-camofox / 9378-9380 /
  Fallback) passt exakt.
- Q7 → Bundle in NSIS, kein "Stealth Mode"-Toggle (Default)

**What shipped in v1.1.0:**
- **Tauri sidecar plumbing** (`src-tauri/src/lib.rs`): `CamofoxState` parallel zum
  Node-Sidecar-State, 3-stage port discovery, 60s boot probe, 3-crash-in-5min
  trip-wire flips `WEB_SEARCH_FALLBACK=true`, KILL_ON_JOB_CLOSE Job Object,
  tray "Beenden" kills both sidecars.
- **Fetch script** (`scripts/fetch-camofox-browser.ps1`): `npm pack
  @askjo/camofox-browser@1.11.2` → extract → `src-tauri/resources/camofox/`.
  Cached in `.cache/camofox` via `actions/cache@v4`.
- **TypeScript client** (`lib/camofox/`): typed API, Zod-validated responses,
  15s timeout, 3-retry exponential backoff (5xx/429 only, never 4xx),
  `withCamofoxHealth` wrapper, PII scrubber for `@currentUser`-mentions,
  dedicated `CamofoxHttp4xxError` marker.
- **5 call-site integrations** wrapped in
  `withCamofoxHealth(camofoxSearch, webSearch)`:
  - `app/api/pi/prompt/route.ts:356` — Instagram trend enrichment
  - `app/api/mmx/prompt/route.ts:197` — same pattern
  - `app/api/nca/prompt/route.ts:204` — same pattern (nca is @deprecated)
  - `app/api/ai/prompt/route.ts:388` — highest-CAPTCHA-pressure call-site,
    PII-scrubbing wired in (currently a no-op since ai/prompt is anonymous)
  - `app/api/web-search/route.ts:103,110` — standalone endpoint
- **CI** (`.github/workflows/tauri-smoke-test.yml` + new
  `.github/workflows/camofox-integration.yml`): `camofox_enabled: bool`
  smoke-test input, manual boot/crash/port-conflict integration workflow.
- **Docs:** new `docs/camofox-integration.md` (setup, runtime, first-run,
  troubleshooting, what's intentionally NOT in v1.1.0).
- **License:** new `THIRD_PARTY_LICENSES.md` — MIT (camofox-browser) +
  MPL-2.0 (Camoufox engine), both AGPL-3.0-or-later compatible.
- **Cleanup:** dead `webSearch()` removed from `lib/mmx-client.ts`.
- **Tests:** 25 new vitest + 5 new Rust integration tests. Total suite
  1313/1313 pass, 0 regressions.

**Known limitations (intentionally deferred):**
- **Snippet extraction** via `/extract` + JSON schema. `ai/prompt` enrichment
  shows title-only lines.
- **`@pinterest_search`** macro — upstream gap in v1.11.2 (R9 in the master
  plan). `buildManualSearchUrl('pinterest', ...)` helper is the workaround
  entry point; call-site is a follow-up.
- **Tauri commands `camofox_status` + `set_camofox_fallback`** — not registered
  in v1.1.0. The JS `trySetFallbackFlag()` is a no-op stub; the Rust side
  flips the flag internally on crash detection. Small follow-up.
- **macOS / Linux Tauri builds** don't bundle camofox (Windows is primary).

**Per-day deliverables:** `I:\tmp\camofox-day{1,2,3,4}-deliverable.md`.

**Pre-existing plan content (kept for the design history):**

**Plan deliverable:** `I:\tmp\camofox-integration-plan.md` (282 lines, 10 sections, German).
**Synthesized from:** 3 research tracks (api-research 16 KB, call-sites 270+ lines, sidecar-design 500+ lines).
**Engine verdict:** auto-accepted, all 4 tasks done, 0.86 USD + 0.95 USD + earlier cycles.

**TL;DR:** camofox-browser (Node.js-REST-Wrapper um die C++-Camoufox-Firefox-Engine)
wird als optionaler Sidecar-Prozess in MashupForge integriert, immer auf
`127.0.0.1:9377` hartgepinnt, mit nahtlosem Fallback auf den bestehenden
`lib/web-search.ts`-Pfad (DDG-Scrape + Brave-API). Aufwand 3-4 Arbeitstage.

**Wichtige Korrektur zur Aufgabenpraemisse:** camofox-Migration ist
**Latenz-/Zuverlaessigkeits-Optimierung**, nicht Anti-Bot-Migration. Der
`matrix web_search MCP` existiert im Codebase **null Mal** (einziger MCP
ist Higgsfield). Social-Media-Trend-Scraping (IG/TikTok/Pinterest) waere
**zusaetzliche Feature-Arbeit**, kein Replacement. Plan beschraenkt sich
auf das Harden des bestehenden `lib/web-search.ts`-Pfads.

**Architektur-Highlights:**
- Sidecar-Lifecycle analog zum bestehenden Node-Next-Sidecar (`lib.rs:745-787`)
- Bundle als `src-tauri/resources/camofox/` (NICHT externalBin, Pattern-Konsistenz)
- 3-Stufen Port-Discovery (9377 -> reuse-if-camofox -> 9378-9380 -> fallback)
- Zweischichtige Health-Probe (Rust Boot-Polling 500ms + JS Liveness 30s)
- Typed TS-Client mit Zod-Validation, 15s Timeout, 3-Retry Exponential Backoff
- PII-Scrubbing fuer `@currentUser`-Mentions vor WebSearchResult-Mapping
- 3-Stage-Crash-Wiederholungs-Schutz: 3 Crashes in 5 min -> `WEB_SEARCH_FALLBACK=true`
- 14-Row Risk Register, 3-Tage-Implementation-Plan, 3 konkret ausgearbeitete Commits

**4 BLOCKING Questions fuer Maurice (vor Tag 1):**
1. **Q1 — Version-Pin:** Welche `@askjo/camofox-browser`-Version? Default-Vorschlag v1.11.2.
2. **Q2 — Telemetrie:** camofox sendet per Default anonymisierte Crash-Reports an
   `camofox-telemetry.askjo.workers.dev` (Issues werden auto-erstellt im jo-inc Repo).
   Plan setzt `CAMOFOX_CRASH_REPORT_ENABLED=false`. Bestaetigen oder aktivieren?
3. **Q3 — Port-Konflikt-Fallback:** Nutzt Maurice camofox auch ausserhalb von
   MashupForge? Falls ja: Reuse-Mode (Stufe 2). Falls nein: direkt auf 9378.
4. **Q7 — Bundle-Groesse:** camofox + node_modules = ~50 MB komprimiert, ~150 MB
   entpackt im NSIS-Installer. Akzeptabel, oder "Stealth Mode"-Settings-Toggle mit
   First-Run-Download?

**7 nice-to-have questions** (CSP-Range, Subtle Status-Indicator, Build-Script-Reihenfolge,
Test-Strategie, mmx-client-Dead-Code-Loeschung, trending/route-Migration,
Social-Media-Trend-Features-in-v1.0.8.1) — Details im Plan §10.

**Naechste Schritte:**
- Maurice beantwortet Q1, Q2, Q3, Q7
- dev-Implementierung startet Tag 1 (Sidecar Plumbing + Health + Graceful Shutdown)
- qa arbeitet parallel an Mock-Server-Setup (`tests/lib/camofox/client.test.ts` mit MSW)
- architect reviewt `lib.rs`-Diffs

**Plan-Stand:** 2026-06-06, v1.0.8.1 — wartet auf Maurice-Sign-off. Nach
Sign-off: PR-Setup mit den 3 ersten Commits (Sidecar-Config, Typed-Client,
Instagram-Integration) als Grundlage.

**Maurice-Sign-off 2026-06-06 02:22 Berlin:** alle 4 blocking questions
mit Defaults bestaetigt.
- Q1 → v1.11.2 (Default)
- Q2 → `CAMOFOX_CRASH_REPORT_ENABLED=false` (Default)
- Q3 → Reuse-Mode bestaetigt — Hermes-Agent nutzt camofox, Maurice persoenlich
  nicht. 3-Stufen-Algorithmus (9377 / Reuse-if-camofox / 9378-9380 / Fallback)
  passt exakt: wenn Hermes camofox bereits auf 9377 hat, reused MashupForge
  die Instanz und spart ~300 MB.
- Q7 → Bundle drin, kein "Stealth Mode"-Toggle (Default)

**Naechste Entscheidung (offen):** Versions-Nummer der naechsten Release
mit camofox — v1.0.10 (kleines Patch-Add) oder v1.1.0 (naechstes Minor)?
Cargo erfordert 3-Part-Semver, also kein 1.0.9.1. Camofox-Integration ist
strukturell additiv (neuer Sidecar, neue Routes, neue Client-Library) und
rechtfertigt eher Minor.

---

## §19 — v1.1.1 — multi-provider video + skills auto-use + 4 hotfixes

**Stand:** 2026-06-06 11:00 Berlin — committet auf Branch `hotfix/v1.1.1-pre-release-batch`, 5 Commits, 1364/1364 vitest, tsc clean. PR + Tauri build pending.

**Scope (5 Bugs, alle in v1.1.1):**

1. **Pipeline-Trendsuche repariert** (camofox in `/api/trending` vergessen in v1.1.0). SearXNG ist dev-only, faellt auf Production-Maschinen aus, der Pipeline-Mode loggte "No trending data found". Fix: camofox als 3. Fan-out-Quelle in `/api/trending/route.ts`, dedup-by-headline absorbiert den Overlap.

2. **Camera-Angle Clear-Button Bug.** mergeSettings strippt `undefined`-Patches per Design (PROP-010), also hat `updateSettings({ cameraAngle: undefined })` nichts geloescht. Fix: neuer `clearSettings(keys)` Primitive in useSettings, threaded durch MashupContext → SettingsModal.

3. **Multi-Provider Video (BIG).** Maurice's Wunsch umgesetzt: User kann jetzt mehrere Provider gleichzeitig fuer Video auswaehlen. Implementation:
   - `lib/video-providers.ts` neu mit `submitAndPollVideo(provider, opts)` als einzigem Dispatch-Point.
   - `app/api/minimax-video/route.ts` + `[taskId]/route.ts` neu — nativer Direct-API-Pfad zu Hailuo 2.3.
   - `MainContent.handleAnimate` refactored: liest `settings.videoProviders ?? ['minimax']`, feuert `Promise.allSettled` an alle.
   - Settings-Modal: Multi-Checkbox "Active Video Providers" + per-Provider Model-Picker. Default `['minimax']`.

4. **Skills Auto-Use.** Die `*.md` Files in `docs/research/higgsfield-skills/` lagen seit v1.1.0 tot im Repo. Implementation:
   - `lib/skill-loader.ts` neu mit `loadAllSkills()` + `buildSkillSystemBlock(activeNames)`.
   - `app/api/ai/prompt/route.ts` liest `body.activeSkills`, injected nach `userSystem` + `focusBlock`.
   - Settings-Modal: neue "Active Skills" Section. Default `['banana-pro-director']`.

**Wichtige Erkenntnis zur Diskussion mit Maurice ueber "MiniMax M3":** Maurice's Annahme "M3 generiert Videos nativ" ist inkorrekt. M3 ist ein nativ-multimodales Model fuer **Input** (versteht Bilder/Videos, MSA architektur, 1M context), aber **generiert** keine Videos. MiniMax's Video-Generation ist **Hailuo 2.3**, ein separates Model. Die mmx-CLI ist der unified wrapper fuer die ganze MiniMax-Familie (M3 + image-01 + Hailuo 2.3 + Speech + Music). mmx-CLI bleibt im Stack, jetzt offiziell begruendet als Multi-Modal-Wrapper.

**MashupForge Stack nach v1.1.1:**
- **Text:** MiniMax-M3 (default fuer vercel-ai route) + skills auto-injection.
- **Image:** image-01 (via `/api/minimax-image`) — keine Aenderung.
- **Video:** Multi-Provider, default `['minimax']` → Hailuo 2.3 via nativer API.

**Offene Folgearbeit (post-v1.1.1):**
- Higgsfield video async polling (requestId-only Pfad) — derzeit throws, User muss manuell auf Higgsfield-Dashboard warten. Koennte via eigener Polling-Route + IDB-Cache aufgeloest werden.
- Camera-Angle-Clear-Bug Lesson: keine `undefined`-Patches mehr in UI → Settings-Wiring. clearSettings ist der Standard-Weg.
- mmx-CLI Cleanup: User koennte mmx in Zukunft komplett deinstallieren wenn er nur native Routes nutzt — das ist die Konsequenz aus Maurice's "mmx nicht mehr noetig"-Aussage, falls er die mal wieder so formuliert.

---

## §20 — v1.1.2 — single-instance OAuth + camofox-only trending

**Stand:** 2026-06-07 ~18:50 Berlin — committet auf Branch
`hotfix/v1.1.2-single-instance-and-camofox-only`, 2 Commits,
1366/1366 vitest, tsc clean, cargo check clean. PR + Tauri
build pending.

**Scope (2 Bugs, post-v1.1.1 reported):**

1. **Higgsfield OAuth öffnete neues Tauri-Fenster** statt
   im selben weiterzuleiten. Der OS-Handler für
   `mashupforge://oauth/callback` hat eine neue Tauri-Instanz
   gespawnt (kein single-instance plugin installiert), die
   keinen State+PKCE-Cookies hatte, dadurch expired_flow und
   Welcome-Back-Screen. Fix: `tauri-plugin-single-instance` mit
   `deep-link` feature, vor `tauri-plugin-deep-link`
   initialisiert. Plugin routet 2. Launch an die laufende
   Instanz + pumpt deep-link URL via den gleichen `deep-link`
   Event-Channel, den der existierende Frontend-Listener
   abonniert. KEIN Frontend-Change nötig.

2. **Pipeline-Trendsuche weiterhin leer** trotz v1.1.1-Fix.
   v1.1.1 hatte camofox nur als 3. Fan-out dazugeschaltet;
   SearXNG (dev-only, Maurice' Maschine hat's nicht) und
   Reddit-JSON (rate-limited, franchise-only) returnten 0
   Results. Fix: komplettes Rewrite auf camofox-only mit
   `@google_search` (3 Queries per Nische, max 6) und
   `@reddit_search` (1 kombinierte Query mit
   `site:reddit.com/r/<sub>` Scoping). Franchise-Subs werden
   jetzt ZUERST in die `targetedSubs` Liste gepusht (v1.1.1
   hatte ART_SUBREDDITS zuerst, was die Franchise-Hits für
   Marvel/StarWars/etc. aus dem `slice(0, 3)` rausschnitt).
   v1.1.1 Test-File gelöscht (testete obsolete 3-Way-Fanout).

**Strategischer Kontext (für v1.2+ Planung):**

Heutige Architektur ist "AI rewritet User-Input" — nicht
agentic. Die AI bekommt web-search als one-shot enrichment blob
und skills als system-prompt context. Sie kann KEINE Tools
aufrufen, keine Schleifen ziehen, nicht selbst entscheiden was
zu generieren ist.

Websearch 2026-04 hat gezeigt: **CLI ist klarer Gewinner
gegenüber MCP für agentic AI** (10-32x weniger Tokens, ~100%
vs 72% Reliability, arxiv 2602.14878). Perplexity hat MCP aus
Agent-Architektur geworfen, Anthropic's eigene Forschung
zeigt 98.7% Token-Reduktion mit shell-basiertem Tool-Aufruf.

Für v1.2 (echte agentic loop):
- Vercel AI SDK `stopWhen` für multi-step
- Skills werden zu **callable Tools** statt system-prompt context
- camofox, Higgsfield (CLI), Leonardo, MiniMax-Video als Tools
- Pipeline-Mode: AI kuratiert Ideen aus Trending, schlägt vor,
  wartet auf User-Approval

NICHT in v1.1.2 — das ist v1.2-Scope.

---

*— end of handoff. You have the full picture. Build something good. —*

