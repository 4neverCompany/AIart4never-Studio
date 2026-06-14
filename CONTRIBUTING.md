# Contributing to MashupForge

Thanks for your interest in MashupForge. This guide covers what you need to get a dev loop going and what we expect from a contribution.

> **Note:** MashupForge is licensed under AGPL-3.0-or-later. If you
> are planning a derivative work, a hosted service, or a commercial
> fork, please read the license terms carefully — AGPL §5 (network use
> clause) requires source disclosure for modified versions run as a
> network service. If you have questions, open a discussion thread
> before sending a PR.

## Prerequisites

- **Node.js 18+** (20 LTS recommended)
- **npm** (ships with Node)
- **tmux** — required by the pi.dev setup flow (hosts pi's interactive login)
- **Rust toolchain** — only if you plan to build the Tauri desktop app

## Setup

```bash
# Clone
git clone https://github.com/4neverCompany/MashupForge.git
cd MashupForge

# Install
npm install

# Env
cp .env.example .env.local
# → add your LEONARDO_API_KEY

# Run
npm run dev
# → http://localhost:3000
```

Then open **Settings → Setup Pi.dev** inside the app to install pi, pick an LLM provider, and authenticate. Pi credentials live at `~/.pi/agent/auth.json`.

## Workflow

1. Create a branch off `main`: `git checkout -b feat/<short-topic>` or `fix/<short-topic>`.
2. Make your change. Keep the diff scoped — one concern per branch.
3. Run the quality gates (below).
4. Open a PR against `main` with a clear description of *what* and *why*.

### Quality Gates (must pass before PR)

```bash
npx tsc --noEmit   # no type errors
npx vitest run     # no test failures
npm run lint       # no new lint warnings
```

These also run via `npm run precommit`, wired in through `simple-git-hooks`.

## Code Style

- **TypeScript strict.** No `any` — use `unknown` and narrow.
- **Tailwind for styling.** No ad-hoc CSS unless the utility doesn't exist. Use brand tokens (see below) instead of random hex values.
- **React 19 patterns.** Server components where they fit; client components only when needed (`"use client"` at the top).
- **Hooks live in `hooks/`.** Keep them focused — one hook, one concern.
- **Tests live in `tests/`** mirroring the source tree (`tests/api`, `tests/hooks`, `tests/lib`, `tests/components`, `tests/integration`).
- **Filenames:** `PascalCase.tsx` for components, `camelCase.ts` for utilities/hooks.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org):

```
feat: add compare-mode split view
fix(pipeline): guard against empty idea queue
docs: rewrite README
refactor(lib): simplify pi-client retry loop
test(hooks): cover useComparison edge cases
chore(deps): bump next to 16.2.3
```

One commit per logical change. Rebase to clean up WIP before opening the PR.

## Pull Requests

A PR should include:

- A one-line title (Conventional Commits format is ideal here too).
- A short description of *what* changed and *why*.
- Screenshots / recordings for any UI change.
- A note if migrations, env vars, or setup steps change.

PRs are reviewed by the team. Expect iteration — review feedback is the point of the process, not a blocker.

## Brand Kit

UI work must respect the 4neverCompany brand kit. Do not improvise colors
or fonts — the canonical tokens (Agency Black `#050505`, Metallic Gold
`#C5A062`, Electric Blue `#00E6FF`; AETHER SANS / NEXUS MONO type
families) are consolidated in [`BRAND.md`](./BRAND.md) at the repo root.
Read that file first; treat it as the single source of truth.

For any deeper design questions, tag a Designer reviewer on your PR.

## Reporting Issues

Use the templates in `.github/ISSUE_TEMPLATE/`:

- **Bug report** — something is broken.
- **Feature request** — something should exist.

## License

MashupForge is open source, licensed under the **GNU Affero General
Public License v3.0 or later** (AGPL-3.0-or-later). See [`LICENSE`](./LICENSE)
for the full text, or https://www.gnu.org/licenses/agpl-3.0.html for a
human-readable summary.

By contributing to this repository, you agree that your contributions
will be licensed under the same AGPL-3.0-or-later license. You also
confirm that you have the right to submit the contribution under those
terms (e.g. it is your original work, or you have explicit permission
from the original copyright holder).
