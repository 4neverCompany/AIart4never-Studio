# Session Log & Handoff — AIart4never Studio (2026-06-14)

> A faithful record of the planning session that created this project. A future (cold) session can
> read this to pick up where we left off. Authoritative detail lives in the linked artifacts; this
> is the map + decisions + state + next steps.

## TL;DR
In one session we turned "I want an autonomous AI influencer agent" into a fully-planned product —
**AIart4never Studio**: a standalone Windows desktop AI agent that embodies Master4never (Kael),
generates on-canon multiverse art, publishes to Instagram + Pinterest, measures, and self-tunes —
on a flat **MiniMax** subscription, with **MCP** as the tool layer, reusing the proven **MashupForge**
engine. We produced the full BMAD planning chain (Brief → PRD → Architecture → Epics/Stories) and a
Linear backlog (24 issues / 5 milestones). **Next phase = build (M0).**

## How we got here (arc)
1. Channel audit of @aiart4never (76 followers / 219 posts / ~1 like) → pivot to a recurring
   character (Master4never) + serialized multiverse story. (Strategy in `w40k-master4never/`.)
2. Vision: an autonomous "influencer agent." Resolved the tech feasibility questions (Agent SDK auth,
   Composio = tools-not-brain, Higgsfield official MCP, model choice).
3. Triaged **MashupForge** (`4neverCompany/MashupForge`, v1.9.1) → it already is ~80% of the spine
   (model-agnostic registry, MCP client, agent-loop, state-machine, watermark, scheduler, Windows
   `.exe`+auto-update). Reuse, don't reinvent.
4. Locked the product as **standalone** (NOT the still-vaporware c4n-4neverCompanyOS), wrote the
   Product Brief, then ran the BMAD workflow autonomously.

## Locked decisions (see PRODUCT-BRIEF.md §3, D1–D12)
- **D1** Standalone product (not the OS). **D2** Windows `.exe` + signed auto-update (Tauri/NSIS/minisign).
- **D3** **LLM = MiniMax-M3 only**, on the MiniMax **Token Plan subscription** (flat, not PAYG).
- **D4** MCP = tool layer. **D5** Reuse MashupForge (adapt, not copy). **D6** Compliant growth only.
- **D7** MCP + Skills **user-managed in-app** ("Customize"). **D8** Ships a **CLI**. **D9** No competitor scraper.
- **D10** PM = Linear. **Repo Strategy B** (fresh hardened repo). **Distribution = public**.
- **Product name = AIart4never Studio.** **FR-22** = agentic MCP install from a link/command (with trust gate).

## Verified research (adversarial workflows; primary-sourced)
- **MiniMax-M3** is the current flagship (≈June 1 2026); the **Token Plan** subscription **covers
  programmatic API/agent use** via a `sk-cp-` Subscription Key on the OpenAI-compatible endpoint
  `api.minimax.io/v1` — unlike Claude/OpenAI consumer plans. Tiers Plus $20 / Max $50 / Ultra $120
  (Ultra ≈ 12.5B M3 tok/mo, per the operator's live account). **Plus likely sufficient for one channel.**
- **Wiring gotcha:** AI SDK v6 must force **Chat Completions** (`@ai-sdk/openai-compatible`), NOT the
  Responses API (404 on first call). Strip `<think>…</think>`; tool-calls over JSON mode.
- **Web research:** **Exa** (primary, 20k req/mo free) + **Tavily** (fallback). Firecrawl is out
  (blocks IG/TikTok/YouTube). No direct social scraping — public-web discovery only.
- **Agentic MCP install (FR-22) security:** connector tool-defs are untrusted (tool-poisoning) →
  layered controls: confirm-showing-exact-command before activate, trust-on-first-use pinning,
  least-privilege OAuth scope, sandbox stdio, never install from observed content.

## Artifacts produced (this repo)
- `docs/PRODUCT-BRIEF.md` — brief (D1–D12, reuse map, research).
- `_bmad-output/planning-artifacts/prds/prd-aiart4never-studio-2026-06-14/` — `prd.md` (22 FRs) + `addendum.md` (tech) + `.decision-log.md`.
- `_bmad-output/planning-artifacts/architecture.md` — AD-1…AD-10 + patterns + module structure + validation.
- `_bmad-output/planning-artifacts/epics.md` — 6 epics, ~25 stories, Given/When/Then ACs.

## Linear — [AIart4never Studio](https://linear.app/4nevercompany/project/aiart4never-studio-059a084dcc63)
Team **4nevercompany**, project id `be6e421e-4465-48ba-a05b-c18da8edab3a`. **24 issues / 5 milestones**:
- **M0 Fork & strip:** 4NE-5 (fresh repo), 4NE-6 (strip), 4NE-7 (CI+.exe), 4NE-20 (MiniMax wiring), 4NE-21 (spend/quota).
- **M1 Canon engine:** 4NE-8 (canon engine), 4NE-9 (one beat e2e), 4NE-22 (reuse-first plan), 4NE-23 (anchored gen+locks), 4NE-24 (pipeline).
- **M2 Autonomous loop:** 4NE-10 (loop), 4NE-11 (gated IG+Pinterest), 4NE-12 (Connectors&Skills + FR-22), 4NE-13 (CLI), 4NE-14 (weekly report), 4NE-25 (state machine), 4NE-26 (Approval Gate, P1), 4NE-27 (skills mgmt), 4NE-28 (health-check).
- **M3 Growth-brain:** 4NE-15 (attribution), 4NE-16 (Exa niche research), 4NE-17 (self-tune A/B).
- **M4 Scale (deferred):** 4NE-18 (multi-account), 4NE-19 (Reels/TikTok/YouTube).
`epics.md` is the acceptance-criteria source of truth.

## BMAD setup (how to continue)
- BMAD **v6.7.1** installed here: `_bmad/` (core + bmm) + `_bmad-output/`. 44 skills in `.claude/skills/`.
- The bmad planning skills are interactive step-workflows (no headless) — this session ran them
  autonomously by reading the step/template files and producing the artifacts directly.
- Continue with: `bmad-check-implementation-readiness` (recommended before build), then
  `bmad-dev-story` per story at build time.

## Open items + defaults I set (changeable)
- Self-tuning autonomy boundary → **default: always operator-approve** plan changes.
- MiniMax tier → **Plus ($20)** assumed sufficient for one channel.
- Final repo name/remote → still `c4n-Master4neverAgent` locally (public repo TBD).
- Pinterest adapter API surface/auth + posting-time signal → resolve at M2.
- Tech versions (Tauri/Next/AI SDK) → **pin/verify at M0** (inherited from MashupForge).

## Next step
**Build phase.** Recommended order: `bmad-check-implementation-readiness` → M0 Story 1.1
(4NE-5: fresh hardened repo + import/adapt MashupForge libs). Needs access to the MashupForge
source (`I:\c4n-MashupForge`) to adapt.

## Key pointers
- Canon source of truth: `I:\w40k-master4never\` (MULTIVERSE.md, CHANNEL-STRATEGY.md, MASTER4NEVER-CANON.md).
- Reuse base: `I:\c4n-MashupForge\` (v1.9.1; GitHub `4neverCompany/MashupForge`).
- Content engine skill: `/master4never-content-factory` + director skills (`banana-pro-director-20`, `cinema-worldbuilder-pro-20`).
