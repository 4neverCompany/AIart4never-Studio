---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
inputDocuments:
  - _bmad-output/planning-artifacts/prds/prd-aiart4never-studio-2026-06-14/prd.md
  - _bmad-output/planning-artifacts/prds/prd-aiart4never-studio-2026-06-14/addendum.md
  - docs/PRODUCT-BRIEF.md
workflowType: 'architecture'
project_name: 'AIart4never Studio'
user_name: 'Maurice'
date: '2026-06-14'
status: draft
---

# Architecture Decision Document — AIart4never Studio

_Produced headless from the PRD + addendum + product brief (the architecture skill is interactive;
the decisions here are derived from those inputs, not re-elicited). Capability ↔ decision mapping
uses the PRD's FR-N IDs. **Review before implementation.** Technology versions are inherited from
the proven MashupForge v1.9.1 base — **pin/verify at M0** rather than re-deriving._

## 1. Project Context

**What:** A single-operator **Windows desktop application** running an autonomous AI agent that
plans, generates, publishes, measures, and self-tunes content for the AIart4never channel
(Master4never multiverse art → Instagram + Pinterest). See PRD §1.

**Project type:** Brownfield-adapted desktop app. It is **not greenfield** — it stands on the proven
MashupForge engine (Tauri + Next.js + Vercel AI SDK + MCP) and re-themes/extends it. The build is
"adapt + harden + add the canon/growth brain," not "invent a stack."

**Hard constraints shaping the architecture:**
- LLM = **MiniMax-M3 only**, on the operator's MiniMax Token Plan subscription (FR-20).
- **MCP is the tool layer** (FR-... / D4); tools are operator-managed, including agentic install (FR-22).
- Every public / irreversible / spend action passes the **Approval Gate** (FR-10).
- **Canon locks** are enforced, not advisory (FR-4, FR-5).
- Single user, local-first, offline-tolerant; public distribution (signed `.exe` + auto-update).

## 2. Reuse Base & Technical Preferences (the "starter")

The "starter template" is **MashupForge** (Repo Strategy B: fresh hardened repo importing/adapting
its libraries). Decisions already made by the base — do not re-decide, only harden:

| Already provided by the base | Source |
|---|---|
| Desktop shell — **Tauri 2.11** (Rust) → Windows NSIS `.exe`, signed **minisign** auto-update | `src-tauri/`, CI `tauri-windows.yml` |
| App framework — **Next.js 16 + React 19 + TypeScript** in the Tauri webview, Node backend inside the shell | repo root |
| Agent loop — **Vercel AI SDK 6** `ToolLoopAgent` + USD/budget guard + `stopWhen` | `lib/agent-loop/` |
| MCP client — **`@modelcontextprotocol/sdk`** | `lib/higgsfield/mcp-client.ts` |
| Provider registry (pluggable media/LLM) | `lib/providers/registry.ts` |
| Post-lifecycle **state machine** over pluggable storage (Tauri SQLite / better-sqlite3) + reconciler | `lib/post-lifecycle/` |
| Watermark / crop / host **pipeline** | `lib/watermark.ts`, `app/api/upload` |
| Settings-schema system (→ extend into Connectors/Skills registry) | `lib/desktop-config-keys.ts` |
| Typed **error hierarchy** (retryable vs terminal) | `lib/agent-tools/errors.ts` |
| Pipeline **daemon** (poll + checkpoint recovery) | `lib/pipeline-processor.ts` |
| Credit/budget tracking | `lib/credit-budget.ts` |

**Dropped from the base:** the mashup content brain; the homegrown `web-search`/`trending-client`
(unreliable → replaced, FR-15).

## 3. Core Architectural Decisions

### Decision Priority Analysis

**Critical (block implementation):**
- AD-1 Reuse MashupForge engine in a fresh hardened repo (Repo B).
- AD-2 MiniMax-M3 as sole LLM via the **OpenAI-compatible Chat Completions** path (force chat, not Responses API).
- AD-3 MCP as the tool layer + an operator-managed Connectors registry (incl. agentic install).
- AD-4 Approval Gate as the single chokepoint for public/spend/irreversible actions.
- AD-5 Canon enforcement (Element-anchored generation; PRIME-tag vs variant-watermark).
- AD-6 Post-lifecycle state machine + queue + reconciler (no partial/duplicate posts).

**Important (shape the architecture):**
- AD-7 Exa as the default web-research Connector (Tavily fallback).
- AD-8 Fresh Pinterest adapter; IG via Composio MCP.
- AD-9 Connectors & Skills "Customize" UI (extend the settings-schema).
- AD-10 CLI surface over the same engine; local scheduler for autonomy runs.

**Deferred (post-MVP):** multi-account (`accountId`); Reels/video Beats; TikTok/YouTube adapters;
full posting-time/hook A/B self-tuning; deep competitor analysis. (PRD §6.2.)

### Data Architecture
- **Decision:** Local-first persistence — the post-lifecycle **state machine over SQLite** (Tauri
  SQLite in the app; better-sqlite3 for CLI/CI) holds posts, plan slots, run logs; the **content
  queue + reconciler** guarantee no partial/duplicate publishing. Asset library on disk; settings in
  the Tauri store + config files. **No server DB** (single-user desktop). · Version: inherited
  (better-sqlite3 / Tauri SQLite plugin — pin at M0). · Rationale: reuse a proven, crash-safe model;
  local-first suits a single operator. · Affects: FR-1, FR-2, FR-13, FR-14.
- **Decision:** **Zod** for all structured data — tool-call schemas, config, connector specs. ·
  Rationale: M3 ignores JSON mode (addendum) → structure must come from typed tool-calls. · Affects:
  FR-12, FR-17, FR-20, FR-22.

### Authentication & Security
- **Decision:** **MiniMax Subscription Key (`sk-cp-`)** stored locally (OS keystore / encrypted
  config), never in the repo; sent as `Authorization: Bearer` to `api.minimax.io/v1`. · Affects: FR-20.
- **Decision:** Platform auth — **Instagram via Composio MCP** (managed OAuth); **Pinterest** token;
  both stored locally. · Affects: FR-8, FR-9.
- **Decision:** **Connector trust model** (FR-22, grounded in OWASP MCP / Invariant / Trail of Bits):
  connector tool-defs are untrusted (tool-poisoning); layered controls — confirm-showing-exact-
  command before activate, **trust-on-first-use pinning** of tool-defs (re-confirm on change),
  least-privilege OAuth 2.1 scope, **sandbox stdio**, never install from observed content. · Affects:
  FR-17, FR-19, FR-22.
- **Decision:** **Approval Gate** (FR-10) is the security boundary: nothing public/spend/irreversible
  executes without operator approval or a pre-authorised scheduled slot. · Affects: FR-8–10, FR-22, FR-21.
- **Decision:** Secret hygiene — updater **signing key = CI secret only**; only the public minisign
  key ships. · Affects: distribution NFR.

### API & Communication Patterns
- **Decision:** **Tool layer = MCP** via `@modelcontextprotocol/sdk` — media (Higgsfield MCP), social
  (Composio IG; Pinterest adapter), web-research (Exa MCP). Remote = streamable-HTTP + OAuth 2.1;
  local = stdio (sandboxed). · Affects: FR-4, FR-8, FR-9, FR-15, FR-17, FR-22.
- **Decision (the load-bearing one):** **LLM via `@ai-sdk/openai-compatible` `createOpenAICompatible`
  forcing Chat Completions** — the `@ai-sdk/openai` default targets the Responses API which MiniMax
  does NOT implement (404 on first call). Strip `<think>…</think>`; prefer tool-calls over JSON mode.
  · Version: `@ai-sdk/openai-compatible` pinned to a v3-spec build for AI SDK 6.x (addendum). · Affects: FR-20.
- **Decision:** **Agent loop = Vercel `ToolLoopAgent`** + budget guard + `stopWhen` (step cap +
  budget). · Affects: FR-11, FR-12, FR-21.
- **Decision:** Internal "API" = **Next.js route handlers inside the Tauri shell** (reused); the CLI
  calls the same engine library directly. · Affects: FR-12.
- **Decision:** **Typed error hierarchy** (retryable → agent retries; terminal → surfaced) reused +
  extended (`PlatformRateLimitError`, `ConnectorAuthError`). · Affects: FR-13, FR-19.

### Frontend Architecture
- **Decision:** **Next.js 16 / React 19 / TS** in the Tauri webview (reused). State via the existing
  MashupForge pattern (post-lifecycle store + settings); no new global-state framework. · Affects: all UI FRs.
- **Decision (new surfaces):** (a) **Connectors & Skills "Customize" panel** — built by extending the
  data-driven settings-schema into an MCP+skill registry with health-check + the agentic-install
  confirm dialog (FR-17–19, FR-22); (b) **weekly-plan review + Approval-Gate modal** (FR-1, FR-10);
  (c) **weekly "what landed" report view** (FR-14). · Affects: FR-1, FR-10, FR-14, FR-17–19, FR-22.

### Infrastructure & Deployment
- **Decision:** **Tauri 2 → Windows NSIS `.exe` + signed minisign auto-update**, GitHub Actions CI
  (reused: `tauri-windows.yml`, `ci.yml`, smoke, secret-scan). **Public** repo/releases (private =
  rate-limited + storage-capped, D12). · Affects: distribution NFR, FR (auto-update).
- **Decision:** **Local scheduler** drives autonomy runs (the promoted pipeline daemon: weekly plan /
  daily post-measure); app must be open at fire time (or runs on next launch). CLI (`run-beat`,
  `run-week`, `status`, `connectors`) over the same engine. · Affects: FR-11, FR-12.
- **Decision:** **No cloud infra** beyond (a) public asset hosting for platform ingestion (GitHub
  Pages-style), (b) the updater endpoint. Single-user desktop. · Affects: FR-7, distribution.
- **Decision:** **Observability** = per-run logs + spend/quota surfacing each run. · Affects: FR-21.

### Decision Impact Analysis
**Implementation sequence (maps to milestones):** AD-1 (M0) → AD-2 + AD-3 (M0/M1, the engine seam) →
AD-5 canon (M1) → AD-6 + AD-4 (M2 loop+gate) → AD-7/AD-8/AD-9/AD-10 (M2) → growth/self-tune (M3) →
deferred (M4).
**Cross-component dependencies:** AD-2 (LLM chat-completions) underpins the whole agent loop (AD-...);
AD-3 (MCP registry) underpins media/social/research connectors + AD-9 UI + FR-22; AD-4 gate wraps
AD-8 publishing + AD-2 spend; AD-6 state machine is the substrate FR-13/14 read.

## 4. Implementation Patterns (for AI-agent / dev consistency)

These are binding patterns so any implementer (human or dev-agent) builds consistently:

- **Autonomy-loop pattern.** One loop: SENSE (analytics+library+calendar) → THINK (plan/gen/post/adjust)
  → ACT* (gated) → LEARN (tune) → schedule next. `*` public/spend steps call the Approval Gate.
- **MCP-connector pattern.** All external capability is a Connector behind the registry; the agent
  never hard-codes a vendor SDK in business logic. Add/install via the manager or FR-22 (parse →
  confirm → register → health-check → pin tool-defs).
- **Approval-Gate pattern.** A single `requestApproval(action)` chokepoint guards publish/spend/
  irreversible/connector-activate; no code path bypasses it.
- **Canon-enforcement pattern.** Generation MUST anchor to an Element; a guard rejects locked-character
  generation without an anchor; PRIME gets the in-image tag, variants get the watermark.
- **State-machine pattern.** Every post moves draft→…→posted via `applyTransition`; the reconciler
  owns crash recovery; nothing posts twice.
- **Model-call pattern.** Always Chat Completions (never Responses API); strip `<think>`; structure via
  Zod tool-calls (not JSON mode); every spend-incurring call respects the budget guard.
- **Secret-handling pattern.** Subscription key + connector creds local-only (keystore/encrypted);
  signing key CI-only; never logged, never in repo, never in prompts.
- **Error pattern.** Throw typed errors; retryable → loop retries with backoff; terminal → surface to
  operator with context.

## 5. Project / Module Structure (target)

Fresh hardened repo (Repo B), adapting MashupForge's layout:

```
/ (Tauri + Next.js app)
├─ src-tauri/                 # Rust shell, NSIS bundle, minisign updater config
├─ app/                       # Next.js routes (UI + internal API route handlers)
│  └─ api/{upload, social/*, media/*, ai/*}
├─ lib/
│  ├─ agent-loop/             # ToolLoopAgent loop, budget, stopWhen   (ADOPT)
│  ├─ providers/              # pluggable media/LLM registry           (ADOPT)
│  ├─ llm/minimax/            # MiniMax-M3 chat-completions wiring      (NEW, FR-20)
│  ├─ connectors/             # MCP registry + agentic install + trust (NEW, FR-17/19/22)
│  ├─ canon/                  # persona + Elements + content-factory    (NEW, FR-1/4/5)
│  ├─ pipeline/               # watermark → crop → host                (ADOPT)
│  ├─ post-lifecycle/         # state machine + reconciler              (ADOPT)
│  ├─ platforms/{instagram,pinterest}/  # publish adapters             (ADAPT/NEW, FR-8/9)
│  ├─ research/               # Exa web-research connector usage        (NEW, FR-15)
│  ├─ growth/                 # analytics attribution + tuning          (NEW, FR-14/16)
│  ├─ scheduler/              # local cadence runner                    (ADAPT, FR-11)
│  ├─ settings/               # data-driven schema → Connectors/Skills UI (ADAPT, FR-17/18)
│  └─ errors/                 # typed hierarchy                         (ADOPT)
├─ cli/                       # run-beat / run-week / status / connectors (NEW, FR-12)
├─ .github/workflows/         # tauri-windows, ci, smoke, secret-scan   (ADOPT)
├─ _bmad-output/ , docs/      # planning artifacts + brief/canon
```
*(Canon source of truth stays in `w40k-master4never/`; the app references it.)*

## 6. Validation / Readiness

- ✅ Every FR (FR-1…FR-22) has an architectural home (decisions §3 + patterns §4 + structure §5).
- ✅ Canon locks (FR-4/5) enforced by the canon-enforcement pattern, not advisory.
- ✅ Approval Gate (FR-10) wraps every publish/spend/irreversible/connector-activate path.
- ✅ MCP security controls present (FR-22): confirm-before-activate, pinning, scope, sandbox, no-observed-install.
- ✅ MiniMax wiring decided with the Responses-API gotcha captured (AD-2).
- ✅ Distribution: signed NSIS `.exe` + minisign auto-update + CI inherited; public channel.
- ⚠️ **Open items to resolve at build (from PRD §8):** Pinterest API surface/auth (AD-8); Pinterest
  posting-time signal; self-tuning autonomy boundary (default = always operator-approve); MiniMax tier
  (Plus likely); final repo name. Technology versions to be **pinned/verified at M0** (not re-derived here).

## Next workflow
`bmad-create-epics-and-stories` → break FR-1…FR-22 into epics/stories (mirror to Linear "AIart4never
Studio", under the existing M0–M4 milestones). Then `bmad-dev-story` at build time.
