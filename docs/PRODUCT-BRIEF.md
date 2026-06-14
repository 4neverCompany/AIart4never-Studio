# Master4never Agent — Product Brief & Blueprint

> **Product name:** *AIart4never Studio* (settled).
> **Status:** Blueprint / pre-build. Draft 1 — 2026-06-14.
> **Author of record:** Maurice (Code4never) · drafted with Claude.

A standalone **Windows desktop product** (`.exe` + signed auto-update) that runs an
**autonomous AI "influencer agent"** which embodies the original character **Master4never (Kael)**,
produces and publishes his multiverse art to **Instagram + Pinterest**, measures how it lands,
and **adjusts its own plan to grow the channel** — with the human in the loop only where it matters.

---

## 1. One-liner

> An autonomous, model-agnostic AI agent — packaged as a Windows app — that grows the
> **AIart4never** channel by generating on-canon Master4never art, planning a weekly schedule,
> publishing it, analysing performance, and improving itself over time. MCP is the tool layer.

## 2. Why this exists (problem)

- The **AIart4never** Instagram channel was audited (see `w40k-master4never/CHANNEL-STRATEGY.md`):
  **76 followers / 219 posts / ~1 like/post.** Old content = random IP-crossover mashups → no
  recurring identity → no reason to follow.
- The fix already proven manually this project: a **recurring protagonist (Master4never/Kael)** who
  travels a multiverse and meets variants of himself (Kaelus Vorne / W40K, etc.). Original IP, no
  third-party trademark risk, ownable, serializable.
- Doing this **by hand every week is the bottleneck.** The agent removes the bottleneck: it runs
  the proven pipeline on a schedule, learns what works, and scales the cadence sustainably.

## 3. Locked decisions (decision record)

These were settled during planning and frame everything below. Change only deliberately.

| # | Decision | Rationale |
|---|---|---|
| D1 | **Standalone product**, NOT a module of `c4n-4neverCompanyOS`. | The OS is still an *idea*, not a running program. Building a finished product on an unbuilt platform would be fatal. |
| D2 | **Windows desktop, `.exe` + signed auto-update** (Tauri/NSIS + minisign updater). | User requirement; and it already exists & is battle-tested in MashupForge (9+ releases). |
| D3 | **LLM = MiniMax only** (MiniMax-M3), on the user's MiniMax **subscription** (flat / on-the-go, not pay-as-you-go). Registry stays pluggable, but MiniMax is the only configured LLM; image/video providers remain multi (Higgsfield etc.). | Flat subscription = predictable cost, no pay-as-you-go anxiety (a product selling point). The one residual risk — M3's unverified multi-turn tool discipline — is bounded by the human approval gate on every spend/publish (§5.3, §10). |
| D4 | **MCP is mandatory** as the tool layer. | Higgsfield (official hosted MCP), Composio (hosted MCP for IG/social), and future tools all attach via MCP — the same way Claude Code uses tools. |
| D5 | **Reuse MashupForge by concept, adapt + improve — no blind copy-paste.** | MashupForge already implements ~80 % of the spine in the exact shape we want. Don't reinvent; don't naïvely clone either. |
| D6 | **Compliant growth only** — no automated like/comment/follow on third-party accounts. | Instagram ToS prohibits automated engagement → shadowban/ban risk. The agent *suggests* outreach; the human acts. (See §10 Guardrails.) |
| D7 | **MCP servers AND skills are user-managed in-app** via a first-class "Connectors / Customize" surface (Claude-Code-style) — never hardcoded or invisible. | The user must add, enable, test, edit and remove MCP connections + skills from the UI. Extends MashupForge's data-driven settings-schema (`lib/desktop-config-keys.ts`). This is the visible face of D4. |
| D8 | **Ships a CLI alongside the GUI.** | The agent loop is a library; a headless CLI (`run-beat`, `run-week`, `status`, `connectors`) exposes it for scripting, automation, CI, and unattended scheduled runs. |
| D9 | **No bespoke competitor scraper.** Competitor/niche signal comes from existing compliant research + our own IG analytics — suggestions only. | MashupForge already has `trending-search` + `web-search` + `niche-coverage`; a scraper (InstaForge `instagrapi` / `camofox` stealth-browser) is redundant and ToS-risky → off by default. |
| D10 | **Project management = Linear** (team "4nevercompany"), MCP-managed. | Full-scale build needs real PM; Linear is connected and fits milestones/epics/stories. Epics/stories generated via BMAD. |

## 4. The big reuse insight (from the MashupForge triage)

`4neverCompany/MashupForge` (v1.9.1, public, Tauri 2.11 + Next.js 16 + React 19 + Vercel AI SDK 6 +
`@modelcontextprotocol/sdk`) is **not** "a watermark + scheduler we can borrow." It already contains
the entire autonomous-content **spine**, in the model-agnostic + MCP + agent-loop form this product
needs — including the proven Windows `.exe` + auto-update distribution.

**The build is therefore mostly: re-theme the engine to Master4never + add the growth brain — not a
greenfield app.**

### Reuse map (triage verdicts)

| Verdict | Systems (MashupForge paths) | Note for this product |
|---|---|---|
| **ADOPT-AS-IS** (the engine) | Model-agnostic **provider registry** `lib/providers/registry.ts` (Leonardo · **Higgsfield via MCP** `lib/higgsfield/mcp-client.ts` · **MiniMax**) · **agent-loop** `lib/agent-loop/` (Vercel `ToolLoopAgent` + USD budget + `stopWhen`) · **post-lifecycle state-machine** `lib/post-lifecycle/` · **watermark** `lib/watermark.ts` · **settings schema** `lib/desktop-config-keys.ts` · **asset hosting** `app/api/upload` · **error hierarchy** `lib/agent-tools/errors.ts` · **pipeline daemon** `lib/pipeline-processor.ts` · **credit budget** `lib/credit-budget.ts` · **Windows NSIS + minisign auto-update** `src-tauri/tauri.conf.json` (`bundle.targets:["nsis"]`, `createUpdaterArtifacts:true`, `updater.endpoints`+`pubkey`) + `.github/workflows/tauri-windows.yml` | Take the proven implementations; rebrand keys/endpoints/signing. The distribution + updater + CI is a wholesale win. |
| **ADAPT** (improve) | **Smart scheduler** `lib/smartScheduler.ts` (keep the time-scoring algo; add Pinterest/TikTok analytics adapters) · **Captioning** (add Master4never voice + platform templates) · **Instagram publishing** `app/api/social/post/route.ts` (keep the create→poll→publish pattern; extract to a clean platform-adapter) | Concept stays; tighten + extend per platform. |
| **BUILD NEW** (the "plus") | **Master4never persona + canon engine** (replaces the random-mashup content brain) · **Growth-brain** (own-performance analytics + competitor analysis + plan self-adjustment) · **autonomy orchestrator** (the weekly Sense→Think→Act→Learn loop) · **multi-account** · **Pinterest adapter** (current MashupForge one is a stub) | This is where the new value lives. |
| **ALREADY COVERED** (no new build) | Compliant niche research is **already in MashupForge**: `lib/agent-tools/trending-search.ts` · `lib/web-search.ts` · `lib/trending-client.ts` · `lib/agent-eval/niche-coverage.ts` | This + our own IG analytics IS the competitor/niche signal — **suggestions only**. **No bespoke scraper** (D9): InstaForge `instagrapi` / the `camofox` stealth-browser are redundant + ToS-risky → off by default. |

## 5. Target architecture (7 layers)

The product = the MashupForge **engine** re-themed, plus an autonomy + growth brain on top.

```
┌────────────────────────────────────────────────────────────────────┐
│ 7. DISTRIBUTION / SHELL   Tauri Windows .exe · NSIS installer ·      │
│                           minisign signed auto-update · CI release   │  ← ADOPT (MashupForge)
├────────────────────────────────────────────────────────────────────┤
│ 6. GROWTH BRAIN           own analytics · competitor analysis ·      │
│                           plan self-tuning · A/B of hooks/times      │  ← BUILD NEW
├────────────────────────────────────────────────────────────────────┤
│ 5. AUTONOMY ORCHESTRATOR  Sense → Think → Act → Learn loop ·         │
│                           weekly/daily cadence · approval gates      │  ← BUILD NEW (on MashupForge daemon)
├────────────────────────────────────────────────────────────────────┤
│ 4. AGENT LOOP + STATE     ToolLoopAgent · USD budget · post-state    │  ← ADOPT (MashupForge)
│                           machine · queue · reconciler               │
├────────────────────────────────────────────────────────────────────┤
│ 3. TOOLS / MCP            Higgsfield MCP · Composio MCP (IG/social) · │  ← ADOPT pattern, add servers
│                           Pinterest · web-search · (future) analytics│
├────────────────────────────────────────────────────────────────────┤
│ 2. CAPABILITY / SKILLS    banana-pro-director · cinema-worldbuilder ·│  ← ADAPT (our skills)
│                           master4never-content-factory · skill-loader│
├────────────────────────────────────────────────────────────────────┤
│ 1. IDENTITY / CANON       Master4never persona · locked Elements ·   │  ← BUILD NEW (from w40k-master4never)
│                           pillars · weekly template · brand voice    │
└────────────────────────────────────────────────────────────────────┘
```

### 5.1 The autonomy loop (heart of the product)

```
SENSE   → pull IG analytics (likes/comments/follower delta) · check asset library + calendar
  ↓
THINK   → goal vs. actual: which pillar/hook/reality is landing? what to generate/post/adjust?
  ↓
ACT*    → generate on-canon art → pipeline (watermark → crop → host) → publish/schedule
  ↓        (*public/irreversible steps pass an approval gate — see Guardrails)
LEARN   → log outcomes · tune CHANNEL-STRATEGY weekly template + posting times · write to memory
  ↓
LOOP    → schedule next wake (weekly = plan · daily = post/measure)
```

This is exactly the manual cycle we ran while building the channel — automated, with the human
approving public actions.

### 5.2 Identity / Canon (layer 1) — what makes it "Master4never", not "MashupForge"

Pulled from the existing canon (single source of truth stays in `w40k-master4never/`):
- **Persona / system-prompt:** the agent operates *as* Kael's channel-keeper; brand voice = the
  hooks & tone in `CHANNEL-STRATEGY.md` (no emoji walls, one real question, scroll-stopper line 1).
- **Locked visual identity:** Higgsfield **Elements** — Kael `9349dc19`, Kaelus `812c9a78`,
  watermark `6c36180d` — and the **never-regenerate-a-locked-character** rule (`MASTER4NEVER-CANON.md`).
- **Content engine:** the `master4never-content-factory` skill (4 pillars + weekly template +
  locked watermark→crop→host→publish pipeline) becomes the agent's planning brain.
- **PRIME-only `AIART4NEVER` tag** vs. variant watermark — enforced at generation/publish.

### 5.3 Model strategy — MiniMax only, on subscription (D3)

- **LLM = MiniMax-M3, the only configured model.** The provider registry stays pluggable
  (future-proof), but the product ships and runs **MiniMax-M3** for everything — planning,
  decisions, captions, routing. Authentication is the user's **MiniMax Token Plan subscription**
  ("Coding Plan" developer tier — flat monthly, NOT pay-as-you-go), which — unlike Anthropic/OpenAI
  consumer plans — *does* grant programmatic API/agent access via a dedicated per-team
  **Subscription Key** (prefix `sk-cp-`). [verified: platform.minimax.io/docs/token-plan/intro]
- **Auth + endpoint.** The Subscription Key hits the same OpenAI-compatible endpoint as PAYG —
  `https://api.minimax.io/v1` (global; `api.minimaxi.com/v1` for China) via `Authorization: Bearer`;
  the key must match the host region. **Wiring:** force Chat Completions (the `@ai-sdk/openai`
  default targets the Responses API, which MiniMax does NOT implement → 404 on first call). Use
  `@ai-sdk/openai-compatible` `createOpenAICompatible(...)`, or `@ai-sdk/openai` `openai.chat(id)`
  (the path MashupForge already proves). [verified: MiniMax-AI/MiniMax-M2 #112; ai-sdk.dev]
- **Quota reality (not "unlimited").** Token Plan tiers: Plus $20 / Max $50 / Ultra $120 per month,
  sized by parallel-agent capacity (3-4 / 4-5 / 6-7). **M3 explicitly included by name** (live
  account spec: M3 / M2.7 / image / speech / music share ONE quota; **Ultra ≈ 12.5B M3 tokens/mo**;
  MiniMax video capped at 5 clips/day — non-issue at our weekly cadence). Usage
  metered in a 5-hour rolling + weekly window, no carry-over, throttled (~1-min reset) when exceeded.
  Agents are explicitly supported; only ultra-high-concurrency batch is rate-limited (never banned),
  which a single-user desktop agent never approaches. [verified: platform.minimax.io/docs/token-plan/faq]
- **Why this is safe here, not reckless.** M3's multi-turn tool discipline is not independently
  verified and it can over-think. Two things bound that risk for THIS product: (1) **a human approval
  gate on every spend-or-publish step** (§10) — a stray/looping tool call cannot spend credits or post
  without a human yes; (2) the **flat subscription** removes the token-cost / runaway-loop concern
  entirely (token-burn ≠ extra money). Drive structure through tool-calls (Zod), not JSON mode
  (silently ignored on M3), and strip `<think>…</think>` before parsing.
- **Selling point.** "No pay-as-you-go — runs on a flat subscription" is exactly what most users
  want; treat it as first-class product positioning, not just an implementation detail.
- **Media:** Higgsfield (via MCP) primary; the **MiniMax Hailuo (video) / image-01 (text-to-image)**
  line and Leonardo as alternates — the MiniMax MEDIA family, distinct from the M-series text model.
  **Credit discipline** — reuse the growing asset library first, generate only the one new "Friday beat".
- **Open item (4NE-20):** programmatic quota-check (`/v1/token_plan/remains`) is in-flux — reportedly
  cookie/session-gated despite Bearer docs; affects only quota lookup, not chat completions. Don't
  hard-depend on it. [MiniMax-AI/MiniMax-M2 #88]

### 5.4 User-managed MCP + Skills (Connectors / Customize) and CLI

- **Connectors & Skills manager (first-class UI) — D7.** MCP servers and skills are NOT hardcoded.
  The app ships a Claude-Code-style **"Customize"** category where the user adds, enables, tests,
  edits and removes **MCP connections** (remote URL / stdio + auth) and **skills** (drop-in
  `SKILL.md`). Built by extending MashupForge's data-driven settings-schema
  (`lib/desktop-config-keys.ts`) into an MCP + skill registry with per-connection health-check.
  This is the user-facing face of the MCP layer (D4) — the agent's tools are transparent and
  user-controlled, not buried in code.
- **CLI surface — D8.** The agent loop is a library; a headless CLI (`run-beat`, `run-week`,
  `status`, `connectors`) exposes the *same engine the GUI drives* for scripting, automation, CI,
  and unattended scheduled runs.

## 6. What's genuinely new (the build backlog at a glance)

1. **Canon engine** — wire the persona + locked Elements + `master4never-content-factory` logic into
   the agent's planning step (replace MashupForge's mashup-prompt brain).
2. **Growth-brain** —
   - *Own analytics:* pull IG insights (already partially in `smartScheduler`), attribute by
     pillar/hook/reality, feed back into the weekly plan.
   - *Niche research (no scraper):* the homegrown `web-search`/`trending-client` proved unreliable →
     **replace with the Exa MCP** (official remote MCP `https://mcp.exa.ai/mcp?exaApiKey=KEY` —
     semantic search + page-content fetch + domain/date filters; **20,000 req/mo free** — confirmed
     live), **Tavily MCP** fallback (`https://mcp.tavily.com/mcp/`, 1k free
     credits/mo; Nebius-acquired Feb 2026). Discovery-search + clean extraction over PUBLIC pages only
     (blogs, ArtStation, Reddit, roundups) → compliant suggestions only (D9). **No direct
     IG/TikTok/Pinterest scraping** (ToS + technically blocked — Firecrawl is out for this reason).
     Apify = opt-in specialist add-on only (4NE-16).
3. **Autonomy orchestrator** — promote MashupForge's 30s daemon into the full weekly/daily
   Sense→Think→Act→Learn cadence with approval gates.
4. **Multi-account** — MashupForge is single-account; add an `accountId` dimension.
5. **Pinterest adapter** — fresh, from the current Pinterest API (MashupForge's is a stub).
6. **Connectors & Skills manager (in-app)** — a first-class "Customize" surface to add / enable /
   test / remove **MCP servers** and **skills** from the UI (Claude-Code-style); nothing hardcoded.
   Extends `lib/desktop-config-keys.ts` into an MCP + skill registry with health-check.
7. **CLI surface** — wrap the agent loop in a headless CLI (`run-beat`, `run-week`, `status`,
   `connectors`) for scripting, automation, CI, and unattended scheduled runs.

## 7. MVP scope (v0.1) vs. later

**v0.1 (prove the autonomous loop on ONE account, credit-light):**
- Re-themed app boots as "Master4never Agent" (Windows `.exe` + auto-update inherited).
- Canon engine plans a week from the 4 pillars + weekly template (reuse-first, ≤1 new gen).
- Generate via Higgsfield MCP, run the locked watermark→crop→host pipeline.
- Publish IG (carousel/story) + Pinterest with **per-public-action approval gate**.
- Pull basic IG analytics; show a weekly "what landed" report; propose next week.

**Later (v0.2+):** competitor-analysis suggestions · posting-time A/B · Reels/video beats ·
multi-account · TikTok/YouTube adapters · fuller self-tuning.

## 8. Tech stack (confirmed from MashupForge — reuse)

- **Shell:** Tauri 2.11 (Rust) → Windows **NSIS `.exe`**, signed **minisign auto-update**.
- **App:** Next.js 16 + React 19 + TypeScript; runs the Node backend inside the desktop shell.
- **Agent:** Vercel **AI SDK 6** `ToolLoopAgent` (model-agnostic) + USD budget guard.
- **Tools:** `@modelcontextprotocol/sdk` MCP client (Higgsfield + Composio + …).
- **State:** post-lifecycle state-machine over pluggable storage (Tauri SQLite / better-sqlite3).
- **CI/Release:** existing GitHub Actions (`tauri-windows.yml`, `ci.yml`, smoke tests, secret-scan).

## 9. Roadmap / milestones (suggested)

| Milestone | Goal | Mostly |
|---|---|---|
| **M0 — Fork & strip** | Stand up the repo from MashupForge's proven base; rebrand (name/keys/endpoints); remove mashup-specific content brain; green CI + a signed test `.exe`. | reuse + delete |
| **M1 — Canon engine** | Wire persona + locked Elements + content-factory planning; generate one on-canon beat end-to-end with the locked pipeline. | build new + adapt |
| **M2 — Autonomous single-account loop** | Sense→Think→Act→Learn on a schedule; approval-gated publish to IG + Pinterest; weekly report. | build new + adopt daemon |
| **M3 — Growth-brain** | Own-analytics attribution + competitor-analysis suggestions + posting-time/hook self-tuning. | build new |
| **M4 — Scale** | Multi-account; Reels/video; TikTok/YouTube adapters. | adapt |

## 10. Risks & guardrails

- **⚠️ Platform ToS / automation ban risk (highest).** Instagram prohibits automated
  like/comment/follow on third-party accounts. The agent must be **autonomous on internal steps
  (plan/generate/size/draft/analyse)** and **autonomous-with-approval-gate on public/irreversible
  steps (publish, schedule, any outreach)**. Growth via **compliant levers only**: replying to
  comments/DMs on *own* posts, hashtag/Pinterest discovery, posting-time optimisation, and a
  **suggestion list** for human-performed outreach. No gray-area engagement bots.
- **Cost / credits.** Hard USD budget per run (MashupForge already has this); reuse-first content
  policy; cheap LLM tier for non-critical steps. Surface spend in every run.
- **Account safety.** App must be open (or auto-launch) at scheduled post time; queue + reconciler
  prevent partial/duplicate posts.
- **Secret hygiene.** Updater **signing key** stays a CI secret (never in repo); only the public
  minisign key ships in the app. Rotate any exposed tokens.
- **Single point of identity.** Locked Elements are the brand — back them up; never regenerate a
  locked character from scratch.

## 11. What we already have in hand (assets, not to rebuild)

- Channel strategy, 4 pillars, hooks, hashtag sets, weekly template — `w40k-master4never/CHANNEL-STRATEGY.md`.
- Canon + locked Elements + publish recipe — `w40k-master4never/MULTIVERSE.md`, `MASTER4NEVER-CANON.md`.
- The content engine skill — `/master4never-content-factory` + the two director skills.
- Working publish pipeline (proven): watermark 75 % → 4:5/2:3/9:16 → GitHub Pages → Composio IG + Zapier Pinterest.
- Composio IG connection (active, allow-listed) + a working Monday scheduled-post routine.
- The entire MashupForge engine + Windows `.exe`/auto-update/CI.

## 12. Decisions (settled at planning)

1. **Product name** — **SETTLED: AIart4never Studio.**
2. **Repo strategy** — **SETTLED: (b) fresh, hardened repo** that imports/adapts MashupForge's
   libraries. Cleaner base for the new MCP/Skills manager, CLI, and MiniMax-only wiring (4NE-5).
3. **LLM** — **SETTLED (supersedes the earlier frontier decision): MiniMax-M3 only**, on the user's
   MiniMax subscription (flat, not pay-as-you-go). Safety = human approval gate on spend/publish +
   flat billing neutralises token-cost (§5.3, D3). Wiring tracked in 4NE-20.
4. **Distribution** — **SETTLED: public.** Private `.exe`/release distribution on GitHub is
   rate-limited and storage-capped; public-repo releases avoid both (brand/landing like MashupForge).
5. **Project management** — **SETTLED (D10):** Linear (team "4nevercompany"), project "Master4never
   Agent" with milestones M0–M4, MCP-managed. Full epics/stories to be generated via BMAD.

---

### Appendix A — provenance of this brief

Decisions D1–D6 and the reuse map were derived from: the channel audit, the MCP/Agent-SDK/Composio/
MiniMax research, a thorough read-only triage of `I:\c4n-MashupForge` (v1.9.1), an architecture map of
`c4n-4neverCompanyOS` + `c4n-InstaForge`, and inspection of the public `4neverCompany/MashupForge`
repo (releases v1.5.2→v1.9.1, NSIS+minisign auto-update confirmed).
