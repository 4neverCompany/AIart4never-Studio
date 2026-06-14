---
stepsCompleted: [1, 2, 3, 4]
inputDocuments:
  - _bmad-output/planning-artifacts/prds/prd-aiart4never-studio-2026-06-14/prd.md
  - _bmad-output/planning-artifacts/architecture.md
  - _bmad-output/planning-artifacts/prds/prd-aiart4never-studio-2026-06-14/addendum.md
project_name: 'AIart4never Studio'
user_name: 'Maurice'
date: '2026-06-14'
status: draft
---

# AIart4never Studio - Epic Breakdown

## Overview

Complete epic/story breakdown decomposing the PRD (FR-1…FR-22) and Architecture decisions (AD-1…AD-10)
into implementable, independently-completable stories with Given/When/Then acceptance criteria.
Epics align with the Linear milestones M0–M4; existing Linear issue IDs are cross-referenced.
_Produced headless from PRD + Architecture; review before dev._

## Requirements Inventory

### Functional Requirements
FR-1 weekly plan · FR-2 reuse-first · FR-3 select reality/variant · FR-4 Element-anchored gen ·
FR-5 canon locks · FR-6 platform-correct post-processing · FR-7 public hosting · FR-8 IG publish ·
FR-9 Pinterest publish · FR-10 Approval Gate · FR-11 autonomy loop on cadence · FR-12 headless+CLI ·
FR-13 safe queue/no-dup · FR-14 weekly report · FR-15 compliant niche research · FR-16 plan self-tuning ·
FR-17 manage MCP connectors · FR-18 manage skills · FR-19 per-connector health-check ·
FR-20 MiniMax-M3 sole LLM · FR-21 spend/quota visibility+guardrail · FR-22 agentic connector install.

### NonFunctional Requirements
NFR-Reliability (resumable runs, no partial/dup — FR-13) · NFR-Transparency (tools/skills visible+managed) ·
NFR-Observability (per-run logs + spend surfaced) · NFR-Identity-determinism (canon locks enforced) ·
NFR-Security (Approval Gate; connector trust: confirm-before-activate, pin, scope, sandbox, no-observed-install) ·
NFR-Privacy (public-web research only, no scraping) · NFR-Cost (flat subscription, reuse-first) ·
NFR-Distribution (Windows NSIS `.exe` + signed minisign auto-update, public channel).

### Additional Requirements
Repo Strategy B (fresh hardened repo from MashupForge libs) · canon source of truth in `w40k-master4never/` ·
no third-party automated engagement (compliant growth only).

### FR Coverage Map
| Epic | Milestone | FRs covered |
|---|---|---|
| Epic 1 — Foundation, Distribution & Model | M0 | base reuse, NFR-Distribution, **FR-20, FR-21** |
| Epic 2 — Canon-anchored generation | M1 | **FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, FR-7** |
| Epic 3 — Autonomous loop & publishing | M2 | **FR-8, FR-9, FR-10, FR-11, FR-12, FR-13** |
| Epic 4 — Connectors & Skills | M2 | **FR-17, FR-18, FR-19, FR-22** |
| Epic 5 — Growth brain | M3 | **FR-14, FR-15, FR-16** |
| Epic 6 — Scale *(deferred)* | M4 | post-MVP |

## Epic List
1. **Foundation, Distribution & Model** — hardened repo, signed auto-updating `.exe`, MiniMax-M3 wired.
2. **Canon-anchored generation** — plan from canon + one on-canon beat end-to-end through the locked pipeline.
3. **Autonomous loop & publishing** — approval-gated IG+Pinterest, the Sense→Think→Act→Learn cadence, CLI, crash-safe.
4. **Connectors & Skills** — operator-managed MCP + skills, incl. agentic install with the trust model.
5. **Growth brain** — weekly report, compliant niche research, plan self-tuning.
6. **Scale** *(deferred, M4)* — multi-account, video/Reels, TikTok/YouTube.

---

## Epic 1: Foundation, Distribution & Model

Stand up the hardened fresh repo from the MashupForge engine, strip the mashup-specific brain, ship a
signed auto-updating Windows `.exe`, and wire MiniMax-M3 as the sole LLM with spend visibility. (M0; Linear 4NE-5/6/7/20.)

### Story 1.1: Fresh hardened repo + rebrand
As the operator, I want a fresh AIart4never Studio repo that imports/adapts the proven MashupForge libraries, So that I build on a working engine without carrying mashup-specific baggage.
**Acceptance Criteria:**
**Given** the MashupForge libraries, **When** the new repo is initialised, **Then** the engine libs (providers, agent-loop, MCP client, post-lifecycle, watermark, settings-schema, errors) are present and the app boots, **And** branding/app-id/updater endpoints are renamed to AIart4never Studio.

### Story 1.2: Strip the mashup content brain
As the operator, I want the random-IP mashup prompt logic removed, So that the content brain seam is clean for the canon engine.
**Acceptance Criteria:**
**Given** the imported base, **When** mashup-specific generation/UI is removed, **Then** the reusable engine still builds and runs, **And** a clearly-marked seam exists where the canon engine (Epic 2) plugs in.

### Story 1.3: Green CI + signed `.exe` + auto-update
As the operator, I want a signed Windows `.exe` that auto-updates, So that I can install and stay current effortlessly.
**Acceptance Criteria:**
**Given** the repo, **When** CI runs, **Then** tauri-windows/ci/smoke/secret-scan are green and produce a signed NSIS `.exe` + updater artifact, **And** a v0.0.1→v0.0.2 bump auto-updates end-to-end, **And** the signing key is a CI secret (only the public key ships).

### Story 1.4: Wire MiniMax-M3 as the sole LLM
As the operator, I want the agent to run on my MiniMax subscription, So that I have a capable LLM with predictable flat cost.
**Acceptance Criteria:**
**Given** my `sk-cp-` subscription key configured, **When** the agent makes its first model call, **Then** it uses MiniMax-M3 via the OpenAI-compatible **Chat Completions** endpoint (NOT the Responses API) and succeeds without any pay-as-you-go key, **And** tool-calling works in the loop, **And** `<think>…</think>` is stripped before parsing.

### Story 1.5: Spend/quota visibility + budget guardrail
As the operator, I want each run to show spend/quota and respect a budget ceiling, So that nothing runs away.
**Acceptance Criteria:**
**Given** a run, **When** it completes, **Then** remaining subscription quota is reported (or noted unavailable), **And** a configured budget ceiling halts further spend-incurring steps.

---

## Epic 2: Canon-anchored generation

The agent plans a week from canon and produces one on-canon beat end-to-end through the locked pipeline. (M1; Linear 4NE-8/9.)

### Story 2.1: Canon engine — persona + Elements + plan
As the operator, I want the agent to plan a week from the pillars/template anchored to the locked canon, So that content stays on-brand and serialized.
**Acceptance Criteria:**
**Given** the canon (persona, Elements, content-factory), **When** I request a week for a chosen reality/variant, **Then** a plan lists one entry per slot (day, pillar, format, characters by Element, caption draft, hashtags, platforms), **And** only registered Element-backed characters are selectable.

### Story 2.2: Reuse-first plan + credit estimate
As the operator, I want the plan to prefer existing assets, So that I spend almost nothing on a reuse week.
**Acceptance Criteria:**
**Given** the asset library, **When** a week is planned, **Then** each slot is marked `reuse` (names the asset) or `new-gen`, **And** a credit/quota estimate is shown, **And** I can force-reuse or force-regenerate any slot.

### Story 2.3: Element-anchored generation + canon locks
As the operator, I want generation anchored to locked Elements with canon rules enforced, So that the character is never off-model.
**Acceptance Criteria:**
**Given** a `new-gen` slot, **When** the agent generates, **Then** the request references the character's Element, **And** a generation of a locked character without an anchor is rejected, **And** PRIME carries the AIART4NEVER tag while variants carry the watermark (no cyberdeck on variants).

### Story 2.4: Locked pipeline — watermark → crop → host
As the operator, I want every publish-bound asset correctly watermarked, sized, and hosted, So that it's platform-ready.
**Acceptance Criteria:**
**Given** a generated beat, **When** the pipeline runs, **Then** variants get the 75% watermark (PRIME does not), **And** outputs are produced at 4:5 (IG) / 2:3 (Pinterest) / 9:16 (story), **And** each asset resolves to a reachable public URL.

### Story 2.5: One on-canon beat end-to-end
As the operator, I want to produce one full beat through the whole chain, So that the canon engine + pipeline are proven before autonomy.
**Acceptance Criteria:**
**Given** the canon engine + pipeline, **When** I run one beat, **Then** it generates via the media MCP, passes the pipeline, and previews correctly with canon locks satisfied, **And** the run is credit-light (reuse-first).

---

## Epic 3: Autonomous loop & publishing

Approval-gated publishing to IG + Pinterest, the cadence loop, and a CLI — all crash-safe. (M2; Linear 4NE-10/11/13.)

### Story 3.1: Post-lifecycle state machine + queue + reconciler
As the operator, I want posts to move through a crash-safe state machine, So that nothing is half-posted or duplicated.
**Acceptance Criteria:**
**Given** a post in the queue, **When** the app crashes mid-publish, **Then** on restart the reconciler restores a safe state and never double-posts, **And** each post has an auditable state history.

### Story 3.2: Approval Gate chokepoint
As the operator, I want a single approval checkpoint for public/spend/irreversible actions, So that I stay in control.
**Acceptance Criteria:**
**Given** any publish/spend/irreversible/connector-activate action, **When** it is attempted without approval or pre-authorisation, **Then** it waits and does not execute, **And** the approval shows the exact content/action before it proceeds.

### Story 3.3: Instagram publishing (carousel/story)
As the operator, I want approval-gated IG publishing, So that beats go live correctly.
**Acceptance Criteria:**
**Given** an approved beat, **When** it publishes via the IG connector, **Then** a multi-image carousel or 9:16 story is created and the media id/permalink is recorded, **And** a "still processing" response is handled by waiting/retrying.

### Story 3.4: Pinterest adapter (fresh)
As the operator, I want approval-gated Pinterest publishing, So that pins post reliably.
**Acceptance Criteria:**
**Given** an approved 2:3 asset, **When** it publishes via the Pinterest adapter, **Then** a pin is created with title + description, **And** no destination-link requirement blocks the post.

### Story 3.5: Autonomy loop on a cadence
As the operator, I want the Sense→Think→Act→Learn loop to run on a schedule, So that the channel runs itself between my check-ins.
**Acceptance Criteria:**
**Given** a schedule, **When** a run fires, **Then** the loop senses (analytics+library+calendar), decides, ACTs behind the gate, learns (tunes plan), and schedules the next wake, **And** a run log is recorded.

### Story 3.6: CLI surface
As the operator, I want a CLI over the same engine, So that I can run/automate headless.
**Acceptance Criteria:**
**Given** the CLI, **When** I run `run-week` / `run-beat` / `status` / `connectors`, **Then** it drives the same engine non-interactively, **And** public/spend steps still pass the Approval Gate.

---

## Epic 4: Connectors & Skills

Operator-managed MCP connectors + skills, including agentic install, with the security trust model. (M2; Linear 4NE-12.)

### Story 4.1: MCP Connector registry + manager UI
As the operator, I want to add/enable/edit/remove MCP connectors in-app, So that the agent's tools are mine to control, not hardcoded.
**Acceptance Criteria:**
**Given** the Customize panel, **When** I add a connector (remote URL/stdio + auth), **Then** it becomes available to the agent without a rebuild, **And** I can enable/disable/edit/remove it, **And** it is visible in the registry.

### Story 4.2: Skills management
As the operator, I want to add/enable/remove skills in-app, So that I can extend/optimize the agent's playbook.
**Acceptance Criteria:**
**Given** a drop-in `SKILL.md`, **When** I add it via the panel, **Then** the agent can load it on the next run, **And** I can enable/disable/remove it.

### Story 4.3: Per-connector health-check
As the operator, I want each connector's status surfaced, So that a misconfig is obvious, not silent.
**Acceptance Criteria:**
**Given** a configured connector, **When** I run its health-check, **Then** reachability/auth status is reported, **And** an unreachable/misauthed connector shows failed rather than failing silently mid-run.

### Story 4.4: Agentic connector install from a link/command
As the operator, I want to install an MCP by handing the agent a link or command, So that adding tools is as easy as it is for a coding agent — safely.
**Acceptance Criteria:**
**Given** an operator-provided remote URL / `npx -y <server>` command / NL "install this MCP: <url>", **When** the agent processes it, **Then** it parses it into one `mcpServers` entry and **requires my confirmation showing the exact url/command before activation**, **And** after I confirm it registers + health-checks + pins the tool-definitions (re-confirm on change), **And** it never installs from a link found in observed/scraped content.

---

## Epic 5: Growth brain

Measure, research compliantly, self-tune. (M3; Linear 4NE-14/15/16.)

### Story 5.1: Weekly "what landed" report
As the operator, I want a weekly performance report, So that I see what's working without opening analytics.
**Acceptance Criteria:**
**Given** the channel's own analytics, **When** the week closes, **Then** a report lists per-post engagement attributed by pillar/hook/reality, the best/worst slot, and a proposed next-week tweak.

### Story 5.2: Analytics attribution → plan feedback
As the operator, I want the plan to self-tune from results, So that the channel improves over time.
**Acceptance Criteria:**
**Given** measured engagement, **When** the agent updates the weekly template/posting times, **Then** an under-performing slot/hook is flagged with a concrete change, **And** the change is applied only after my approval (default boundary).

### Story 5.3: Compliant niche research via Exa
As the operator, I want compliant niche suggestions, So that the agent stays current without ToS risk.
**Acceptance Criteria:**
**Given** the Exa web-research connector, **When** the agent researches the niche, **Then** it uses public-web discovery + page extraction (no IG/TikTok/Pinterest scraping) and returns advisory suggestions only, **And** it never auto-acts on third-party accounts.

---

## Epic 6: Scale *(deferred — M4)*

Post-MVP expansion. (Linear 4NE-18/19.) Stories sketched, not yet ready for dev.

### Story 6.1: Multi-account (accountId)
As the operator, I want multiple channels from one app, So that I can run more than one identity. *(deferred)*
**Acceptance Criteria:** **Given** an `accountId` dimension across settings/post-lifecycle/publishing, **When** I switch account, **Then** plans/queues/analytics scope to that account.

### Story 6.2: Reels/video beats + TikTok/YouTube adapters
As the operator, I want video beats and more platforms, So that I reach more surfaces. *(deferred)*
**Acceptance Criteria:** **Given** a video beat via the media MCP, **When** it publishes via a TikTok/YouTube adapter behind the gate, **Then** it posts correctly through the same pipeline+gate.
