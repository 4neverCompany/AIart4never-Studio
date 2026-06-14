---
title: AIart4never Studio
status: draft
created: 2026-06-14
updated: 2026-06-14
---

# PRD: AIart4never Studio

## 0. Document Purpose

For **Maurice** (builder/operator) and the downstream BMAD workflows (`bmad-create-architecture`,
`bmad-create-epics-and-stories`). This PRD is built **on** `docs/PRODUCT-BRIEF.md` (decisions
D1–D10, the MashupForge reuse map, the architecture sketch, and the verified MiniMax/Exa research)
— it references that brief, it does not duplicate it. **Capabilities live here; implementation/tech
choices (MiniMax-M3 wiring, Exa MCP, Tauri/NSIS) live in `addendum.md`.** Vocabulary is
Glossary-anchored (§3); features are grouped with Functional Requirements (FR-N) nested and globally
numbered; inferred values are tagged `[ASSUMPTION]` inline and indexed in §9. Produced headless
(no interactive elicitation) from the brief — review before downstream use.

## 1. Vision

AIart4never Studio is a **Windows desktop application that runs an autonomous AI agent** embodying
**Master4never (Kael)**, an original multiverse character. The agent plans a weekly content
schedule, generates on-canon art, publishes it to Instagram and Pinterest, measures what lands, and
self-tunes the plan to grow the channel — with the operator approving only the steps that are public,
irreversible, or spend money.

It exists to remove the bottleneck that throttles a one-person creative channel: **the weekly manual
grind** of generating, sizing, captioning, scheduling, posting, and analysing. A recurring
character + serialized story is what earns followers; doing that by hand every week is unsustainable.
The Studio automates the proven pipeline while keeping the brand's identity **locked** (canonical
character references that are never regenerated from scratch) and the operator **in control** of
anything that matters.

Crucially, it runs on a **flat MiniMax subscription** (not pay-as-you-go), so operating cost is
predictable and bounded — "no per-token anxiety" is both an operator relief and a product selling
point.

## 2. Target User

### 2.1 Primary Persona

**Maurice — solo creator/operator** of the AIart4never channel. Runs a Windows PC; cost-conscious;
wants the channel to grow without it becoming a full-time manual job. Comfortable reviewing and
approving content, uninterested in babysitting token meters or hand-writing every caption. Already
has the locked Master4never canon, a working publish pipeline, and a MiniMax subscription.

*(Secondary, post-MVP: other solo AI-art creators who want a flat-subscription, self-running channel
agent — the "no pay-as-you-go" model is the wedge.)*

### 2.2 Jobs To Be Done

- Keep a recurring, character-driven channel alive on a **sustainable cadence** without weekly grind.
- Produce **on-canon, brand-consistent** art and captions automatically.
- Know **what's working** and adjust — without doing analytics by hand.
- Stay **in control** of anything public, irreversible, or money-spending.
- Keep cost **predictable** (flat subscription).

### 2.3 Non-Users (v1)

- Agencies / multi-client teams — v1 is single-operator, single-channel.
- Non-Windows users — v1 is Windows-only.
- Anyone wanting automated third-party engagement (mass like/comment/follow) — explicitly not built.

### 2.4 Key User Journeys

- **UJ-1. Maurice plans the week without touching a calendar.** He opens the Studio, picks (or
  accepts the suggested) reality/variant for the week, and the agent lays out the weekly slots from
  the pillars + template, marking which posts reuse existing assets and which need one new beat.
  Climax: a reviewable week plan appears with a near-zero credit estimate. Resolution: he approves it.

- **UJ-2. Maurice approves and the post goes live.** When a slot is due, the agent has already
  generated the on-canon beat, watermarked and sized it per platform, and hosted it. It surfaces a
  one-screen approval: image(s) + caption + target platforms. He taps approve; it publishes to
  Instagram and Pinterest. Edge case: if a publish fails mid-way, the post returns to a safe state
  and is retried — never half-posted or duplicated.

- **UJ-3. Maurice sees what landed.** End of week, the agent shows a short report: engagement per
  post attributed by pillar/hook/reality, the best/worst slot, and a proposed tweak to next week's
  plan. He doesn't open Instagram's analytics himself.

- **UJ-4. Maurice adds a connector.** He opens the Customize panel, pastes a web-research MCP URL +
  key, the Studio health-checks it green, and it's now available to the agent — no code, no rebuild.
  Same flow for dropping in a new Skill.

- **UJ-5. The Studio runs while Maurice is away.** A scheduled (or CLI `run-week` / `run-beat`) run
  fires; the agent plans, generates, and *queues* posts behind the approval gate (or posts
  pre-approved slots), then waits. He reviews when he's back.

## 3. Glossary

*Downstream workflows and readers use these terms verbatim. No synonyms elsewhere in the PRD.*

- **Channel** — the public AIart4never account on a platform (Instagram or Pinterest). One channel per platform in v1.
- **Canon** — the locked, authoritative definition of the Master4never world: characters, look, rules. Source of truth lives in `w40k-master4never/`.
- **Element** — a locked canonical reference for a recurring character (e.g. Kael, Kaelus). The agent **anchors** generation to an Element and never regenerates the character from scratch.
- **Variant** — a version of the protagonist in another reality (e.g. Kaelus Vorne / W40K). Variants carry the watermark, not the in-image channel tag.
- **Pillar** — one of the four recurring content types (Story-Beat, Variant Reveal, Same-Soul, Lore/Poll).
- **Weekly Template** — the recurring weekly slot skeleton (which pillar/format on which day).
- **Beat** — a single produced content unit (one post's worth of art) for a slot.
- **Pipeline** — the locked post-processing chain: watermark → crop-per-platform → host.
- **Connector** — an MCP server the agent uses as a tool (media generation, social publishing, web research).
- **Skill** — a drop-in instruction module (`SKILL.md`) the agent can load and use.
- **Approval Gate** — the mandatory human checkpoint before any public, irreversible, or spend action.
- **Run** — one execution of the autonomy loop (Sense→Think→Act→Learn), interactive or headless/scheduled.
- **Operator** — the single human who owns the channel and answers approval gates (Maurice in v1).

## 4. Features

### 4.1 Canon-anchored weekly planning

**Description:** The agent builds a reviewable weekly plan from the four Pillars and the Weekly
Template, choosing the week's reality/Variant and mapping each slot to a pillar, format, characters
(by Element), and platform targets. It is **reuse-first**: it prefers existing library assets and
flags only the genuinely new generation needed (credit discipline). Realizes UJ-1.

**Functional Requirements:**

#### FR-1: Generate a weekly plan
The agent can produce a weekly content plan from the Pillars + Weekly Template for a chosen
reality/Variant.
**Consequences (testable):**
- Output lists one entry per template slot with: day, pillar, format, characters (Element IDs), caption draft, hashtag set, target platforms.
- Every slot is marked `reuse` (names the existing asset) or `new-gen` (names the generation needed).

#### FR-2: Reuse-first credit discipline
The plan prefers existing assets and minimises new generation.
**Consequences:**
- A generated week shows a credit/quota estimate; a "reuse week" estimate is ≈ the cost of at most one new Beat.
- The operator can force-reuse or force-regenerate any slot.

#### FR-3: Select the week's reality/Variant
The operator (or the agent, with approval) selects which reality/Variant the week features, from the character registry.
**Consequences:**
- Only registered, Element-backed characters are selectable; a new Variant requires locking an Element first (§4.2).

### 4.2 On-canon generation & processing pipeline

**Description:** For each `new-gen` slot, the agent generates a Beat **anchored to a locked Element**
via a media Connector, enforces the canon rules, then runs the locked Pipeline. `[ASSUMPTION:
media generation is via the Higgsfield MCP as the primary media Connector; alternates pluggable.]`
Realizes UJ-2 (production half).

**Functional Requirements:**

#### FR-4: Element-anchored generation
The agent generates a Beat anchored to a locked Element; it never regenerates a locked character from scratch.
**Consequences:**
- Every generation request references an Element (reference image / element id).
- A request that would generate a locked character without an anchor is rejected.

#### FR-5: Enforce canon locks
The agent enforces canon rules at generation and publish time.
**Consequences:**
- PRIME (Kael) carries the legible AIART4NEVER in-image tag; Variants do NOT (they receive the watermark instead).
- Variants never show the PRIME-only cyberdeck.

#### FR-6: Platform-correct post-processing
The agent applies the locked Pipeline to every publish-bound asset.
**Consequences:**
- Variant assets receive the 75%-opacity watermark; PRIME assets do not.
- Each asset is produced in the correct ratio per destination: 4:5 (IG feed), 2:3 (Pinterest), 9:16 (story).

#### FR-7: Public hosting for platform ingestion
The agent hosts finished assets at a public URL the platforms can fetch.
**Consequences:**
- Each finished asset resolves to a reachable public URL before a publish is attempted (verified, e.g. HTTP 200).

### 4.3 Approval-gated publishing

**Description:** The agent publishes Beats to Instagram (carousel/story) and Pinterest, but **only**
through the Approval Gate. Realizes UJ-2 (publish half).

**Functional Requirements:**

#### FR-8: Instagram publishing
The agent can publish a carousel or story to the Instagram Channel.
**Consequences:**
- Supports a multi-image carousel and a 9:16 story; the published media id/permalink is recorded.

#### FR-9: Pinterest publishing
The agent can publish a pin to the Pinterest Channel.
**Consequences:**
- A pin is created from the 2:3 asset with title + description; no destination-link requirement blocks the post.

#### FR-10: Mandatory Approval Gate on public/spend/irreversible actions
No public, irreversible, or money-spending action executes without explicit operator approval (or a pre-authorised scheduled slot the operator set up).
**Consequences:**
- A publish/spend attempt with no approval and no pre-authorisation does not execute; it waits.
- Approval shows the exact content (image(s) + caption + targets) before it goes live.

### 4.4 Autonomy loop & scheduling

**Description:** The agent runs the Sense→Think→Act→Learn loop on a cadence (weekly = plan, daily =
post/measure), interactively or headless/scheduled, and exposes the same engine via a CLI. Realizes
UJ-5. `[ASSUMPTION: scheduling is local — the app/CLI runs on the operator's machine on a timer;
when closed, it runs on next launch.]`

**Functional Requirements:**

#### FR-11: Run the autonomy loop on a cadence
The agent runs the loop on a schedule: SENSE (analytics + library + calendar) → THINK (what to gen/post/adjust) → ACT (gated) → LEARN (tune plan) → LOOP.
**Consequences:**
- A scheduled run produces/queues the due slot and records a run log; the next wake is scheduled.

#### FR-12: Headless + CLI operation
The same engine the GUI drives is available headless via a CLI (`run-beat`, `run-week`, `status`, `connectors`).
**Consequences:**
- `run-week` produces the week plan non-interactively; `status` reports queue + spend; public steps still pass the gate.

#### FR-13: Safe queue, no partial/duplicate posts
A post moves through a state machine; a queue + reconciler prevent partial or duplicate publishing and resume after restart.
**Consequences:**
- A crash mid-publish leaves the post in a recoverable state and never double-posts on restart.

### 4.5 Growth analytics & self-tuning

**Description:** The agent measures the channel's own performance, surfaces a weekly report, runs
compliant niche research, and feeds the signal back into the plan. Realizes UJ-3.

**Functional Requirements:**

#### FR-14: Weekly "what landed" report
The agent pulls the Channel's own analytics and produces a weekly report attributed by pillar/hook/reality.
**Consequences:**
- Report lists per-post engagement, best/worst slot, and a proposed next-week tweak.

#### FR-15: Compliant niche research (suggestions only)
The agent researches the niche via a web-research Connector and produces suggestions only.
**Consequences:**
- Research uses public-web discovery + page extraction (no direct scraping of Instagram/TikTok/Pinterest).
- Output is advisory; it never auto-acts on third-party accounts.

#### FR-16: Plan self-tuning
The agent feeds analytics back into the Weekly Template and posting times.
**Consequences:**
- A measured under-performing slot/hook is flagged and a concrete plan change is proposed for operator approval.

### 4.6 Connectors & Skills manager

**Description:** A first-class in-app "Customize" surface where the operator manages the agent's
tools (MCP Connectors) and Skills directly — via a form **or** by handing the agent a link/command
(agentic install, FR-22) — nothing hardcoded or invisible. Realizes UJ-4.

**Functional Requirements:**

#### FR-17: Manage MCP Connectors in-app
The operator can add, enable, test, edit, and remove MCP Connectors from the UI (remote URL / stdio + auth).
**Consequences:**
- A newly added Connector becomes available to the agent without a code change or rebuild.

#### FR-18: Manage Skills in-app
The operator can add, enable, and remove Skills (drop-in `SKILL.md`) from the UI.
**Consequences:**
- A newly added Skill is loadable by the agent on the next run.

#### FR-19: Per-connector health-check
The manager reports each Connector's reachability/auth status.
**Consequences:**
- A misconfigured/unreachable Connector shows a failed health-check rather than failing silently mid-run.

#### FR-22: Agentic Connector install from a link or command
The operator can install an MCP Connector by handing the agent a **link or a command** (or natural
language — e.g. "install this MCP: `<url>`", a remote MCP URL, or a `npx -y <server>` stdio command).
The agent parses it into a Connector spec, prepares it, registers it **after explicit operator
confirmation**, then health-checks it (FR-19). Mirrors how a coding agent adds an MCP server.
**Consequences (testable):**
- A pasted remote MCP URL or stdio command is parsed and registered without the operator hand-filling the form.
- Registration **requires operator confirmation before the Connector becomes active** — granting the agent a new tool is a trust/security action, never a silent change.
- The agent installs Connectors only from **operator-provided** links/commands — never from a link/command found in observed/scraped/third-party content (prompt-injection guard).
**Feature-specific NFRs (security — grounded in MCP-security consensus: OWASP MCP, Invariant Labs, Trail of Bits, MCP spec):**
- **Connector metadata is untrusted input.** A server's tool names/descriptions reach the model *before* any tool runs (tool-poisoning / "line-jumping"), so a new Connector's definitions are untrusted, not trusted config.
- **Layered controls — no single gate suffices:** (1) human confirm **showing the exact URL/command** before activation; (2) **trust-on-first-use pinning** of tool definitions → re-confirm on change (rug-pull / silent-redefinition guard); (3) **least-privilege OAuth 2.1 scoping** for remote servers; (4) **sandbox** stdio subprocesses; (5) **never** install from observed/scraped content — operator-provided links/commands only.
- The Connector stays **visible + revocable** in the manager (FR-17, FR-19).
**Mechanism:** parse a remote URL / `npx -y <server>` stdio command / deep-link payload / NL request into one `mcpServers` entry — stdio (`command/args/env`) or remote (`type: streamable-http, url, headers`; OAuth 2.1 on 401 via RFC 9728/8414 + PKCE). Same model as `claude mcp add` / `claude mcp add-json`.

### 4.7 Model & cost control

**Description:** The LLM is **MiniMax only**, authenticated by the operator's MiniMax subscription;
spend/quota is surfaced and guarded. Tech detail in `addendum.md`.

**Functional Requirements:**

#### FR-20: MiniMax as the sole configured LLM
The agent runs on MiniMax (MiniMax-M3) as the only configured LLM, authenticated by the operator's subscription credential.
**Consequences:**
- With a valid subscription credential configured, an agent run completes without any pay-as-you-go API key.
- The provider registry remains pluggable, but no other LLM is configured/required in v1.

#### FR-21: Spend/quota visibility + guardrail
Each run surfaces spend/quota status; a budget guardrail can stop the loop.
**Consequences:**
- A run reports remaining subscription quota (where available) or notes it's unavailable.
- A configured budget ceiling halts further spend-incurring steps.

## 5. Non-Goals (Explicit)

- **No automated engagement** on third-party accounts (no auto like/comment/follow). The agent
  *suggests*; the operator acts. (Platform ToS + ban risk.)
- **No direct scraping** of Instagram/TikTok/Pinterest. Niche research is public-web only.
- **Not a general image editor / not a manual design tool** — it's an autonomous channel agent.
- **Not multi-tenant SaaS** in v1 — single operator, local desktop.
- **No pay-as-you-go billing path** as the default — flat subscription is the model.
- **Not coupled to `c4n-4neverCompanyOS`** — standalone product (D1).

## 6. MVP Scope

### 6.1 In Scope
- Single Channel set (one IG + one Pinterest), single operator.
- Canon-anchored weekly planning (§4.1), reuse-first.
- On-canon generation of one Beat end-to-end through the locked Pipeline (§4.2).
- Approval-gated publishing to IG (carousel/story) + Pinterest (§4.3).
- Autonomy loop on a local schedule + CLI (§4.4).
- Weekly "what landed" report + compliant niche research via a web-research Connector (§4.5, basic).
- Connectors & Skills manager — add/enable/test MCP + Skills (§4.6).
- MiniMax-M3 as sole LLM on subscription; spend/quota surfaced (§4.7).
- Windows `.exe` with signed auto-update.

### 6.2 Out of Scope for MVP
- Multi-account / multi-channel. *(v2 — `accountId` dimension.)*
- Reels / video Beats; TikTok / YouTube adapters. *(v2.)*
- Full posting-time / hook A/B self-tuning. *(v2 — MVP ships the report + manual-approve tweak.)* `[NOTE FOR PM]` self-tuning is the emotionally load-bearing "it improves itself" promise — revisit early in v2.
- Deep competitor analysis. *(v2 — MVP ships suggestions-only niche research.)*

## 7. Success Metrics

**Primary**
- **SM-1**: Channel growth — follower count and engagement rate rise versus the audit baseline (76 followers, ~1 like/post, 0 comments). Validates FR-1, FR-8, FR-9, FR-14, FR-16.
- **SM-2**: Operator time — weekly hands-on time to keep the channel running drops materially versus the manual process. Validates FR-11, FR-12.

**Secondary**
- **SM-3**: Cost predictability — operating cost stays within the flat subscription (no surprise pay-as-you-go). Validates FR-20, FR-21.

**Counter-metrics (do not optimize)**
- **SM-C1**: Post volume — do NOT maximise raw posts/day; quality + on-canon identity beat spam. Counterbalances SM-1.
- **SM-C2**: Platform safety — zero account bans/shadowbans; never trade compliance for reach. Counterbalances SM-1/SM-2.

## 8. Open Questions

1. Pinterest adapter scope — which current Pinterest API surface, and what auth, for the fresh adapter? (MashupForge's is a stub.)
2. Posting-time model per platform — reuse the IG-insights scorer; what's the equivalent signal for Pinterest?
3. Self-tuning autonomy boundary — how much plan change may the agent apply automatically vs. always operator-approved?
4. Which web-research Connector ships as the default — **Exa** (primary) vs **Tavily** (fallback)? (Recommendation: Exa; see addendum.)
5. MiniMax subscription tier for one channel — Plus ($20) is likely sufficient; confirm against real run volume.
6. Repo home — `I:\c4n-Master4neverAgent\` is the fresh hardened repo (Repo Strategy B); confirm final repo name/remote.

## 9. Assumptions Index

- §2 — Single-operator, single-channel for MVP `[ASSUMPTION from project context]`.
- §4.2 — Primary media generation via the Higgsfield MCP; alternates pluggable `[ASSUMPTION]`.
- §4.4 — Scheduling is local (app/CLI on a timer; runs on next launch if closed) `[ASSUMPTION, per brief §10]`.
- §4.7 — MiniMax Token Plan subscription covers MiniMax-M3 for programmatic use `[VERIFIED — addendum]`.
- §4.5 — Default web-research Connector is Exa `[ASSUMPTION pending confirm — Open Question 4]`.
- §6 — Distribution is public (rate-limit/storage reasons) `[SETTLED — brief §12.4]`.

---

## Constraints & Guardrails *(Adapt-In)*

- **Safety / Compliance.** Compliant growth only (Non-Goals). Approval Gate (FR-10) is the hard
  guardrail on anything public/irreversible/spend. No scraping; no automated third-party engagement.
- **Tool trust (Connector install).** Adding/installing a Connector or Skill — including agentic
  install from a link/command (FR-22) — requires explicit operator confirmation before it becomes
  active; the agent only installs from operator-provided links, never from observed/scraped content.
- **Privacy.** No compiling of personal data on third parties; research is public-web aggregate only.
- **Cost.** Flat MiniMax subscription; spend/quota surfaced (FR-21); reuse-first (FR-2). Token-burn
  does not translate to extra money under the subscription.
- **Secret hygiene.** The updater signing key stays a CI secret; only the public key ships. The
  MiniMax subscription key and Connector credentials are stored locally, never in the repo.

## Aesthetic & Tone *(Adapt-In)*

- **Visual identity is the Canon** — locked Elements; never regenerate a locked character. PRIME
  carries the AIART4NEVER tag; Variants carry the watermark.
- **Voice** (for agent-generated captions): scroll-stopper line 1, then short; exactly one real
  question; no emoji walls, no "tag a brother" bait. Every post lives in the Master4never universe —
  no random IP mashups. (Source: `w40k-master4never/CHANNEL-STRATEGY.md`.)

## Platform *(Adapt-In)*

- **Windows desktop**, distributed as a signed `.exe` with auto-update. v1 Windows-only. (Tech:
  Tauri/NSIS/minisign — see `addendum.md`.)

## Cross-Cutting NFRs *(Adapt-In)*

- **Reliability of the loop** — a Run must be resumable; no partial/duplicate posts (FR-13).
- **Transparency** — the agent's tools (Connectors) and Skills are visible and operator-managed
  (FR-17–19), never hidden in code.
- **Observability** — every Run logs what it did; spend/quota is surfaced (FR-21).
- **Determinism of identity** — canon locks (FR-4, FR-5) are enforced, not advisory.
