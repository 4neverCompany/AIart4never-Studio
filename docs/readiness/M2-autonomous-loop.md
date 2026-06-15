# M2 — Autonomous single-account loop · Readiness check (BMAD gate)

_Date: 2026-06-15 · Verdict: **GO** (code-complete & green; live channel execution gated on operator OAuth — see Blockers)._

M2 turns the canon engine (M1) into a self-running, human-gated content loop:
the agent plans the week, produces/reuses the day's beat, and drops it into an
approval queue — and **cannot** publish or spend or activate a connector without
passing one unified approval chokepoint.

## Story status

| Story | Title | Status | Where |
|------|-------|--------|-------|
| 4NE-10 | Autonomy orchestrator (Sense→Think→Act→Learn) | ✅ ACT loop + gates | `lib/autonomy/` |
| 4NE-11 | Approval-gated IG publish + fresh Pinterest adapter | ✅ | `lib/publish/` |
| 4NE-12 | Connectors & Skills manager + FR-22 agentic install | ✅ service + UI | `lib/connectors/`, `components/Settings/CustomizePanel.tsx` |
| 4NE-13 | CLI surface (run-beat / run-week / status / connectors) | ✅ | `lib/cli/`, `bin/aiart4never.ts` |
| 4NE-14 | Weekly "what landed" analytics report | ✅ compute + mapper | `lib/analytics/` |
| 4NE-25 | Post-lifecycle state machine + reconciler | ✅ inherited + reconciler crash fixed | `lib/post-lifecycle/`, `hooks/useReconciler.ts` |
| 4NE-26 | Approval Gate — single no-bypass chokepoint | ✅ keystone | `lib/approval/` |
| 4NE-27 | Skills management (add/enable/remove) | ✅ | `lib/connectors/skills.ts` + Customize UI |
| 4NE-28 | Per-connector health-check | ✅ | `lib/connectors/health.ts` |

## Oracles (at gate)

- `bun run typecheck` → 0 errors.
- `bun run test` → **2147 passed / 0 failed** (177 files; M2 added ~330 tests over the M1 baseline).
- `bun run build` → PASS (routes within the 300 KB budget).
- Security: the no-bypass property of 4NE-26 was **adversarially verified** — no
  IG/Pinterest tool-slug caller and no publish-plan-builder caller outside
  `lib/publish`; no `markTrusted`/`setEnabled` caller outside the registry/install;
  both irreversible paths verify a hash-bound approval token *before* the side effect.

## Design check (per-epic, this gate)

A live preview surfaced two real defects that unit tests + tsc had missed; both fixed:
1. **Copy still MashupForge** despite the color re-skin — header "Mashup Studio",
   CTA "Generate Mashup", empty state "crossover images from famous fantasy
   universes using Leonardo.AI". The brand-guard only matches the literal token
   "MashupForge", so it passed. → rebranded to **AIart4never Studio** / **Generate
   Beat** in the Master4never canon voice (`8d9de96`).
2. **StartupReconciler crash** on every launch (`this.driver` undefined) — the
   reconciler hook built storage via `new IdbPostLifecycleStorage()` instead of the
   async `.open()` factory; `require()`'s `any` hid it from tsc. → fixed (`dce3619`).

> Note on the preview: the session's preview server is rooted at the sibling repo
> `I:\c4n-MashupForge` (the upstream fork parent), not at this repo, and it caches
> its launch configs at startup — so a *live* screenshot of this repo could not be
> taken this session. The design (Ashen Cyberforge orange tokens) and rebrand are
> verified by source + a green `bun run build`; a live screenshot should be taken
> once the preview is pointed at this repo (or from the desktop build).

## Deferred (by design) / follow-ups

- **Spend approval** still flows through the existing `lib/agent-loop/hil.ts` gate;
  the unified gate reserves the `'spend'` kind for a later consolidation onto one
  chokepoint. Not a gap — two correct gates today, one tomorrow.
- **Autonomy SENSE/LEARN** (live analytics → self-tuning weekly template) is M3
  (4NE-15/16/17); 4NE-14's report is the LEARN-step input scaffold.
- **Idempotency receipt store** for publish (avoid double-post on retry) — `4NE-11`
  marker in `lib/publish/dispatch.ts`; the post-lifecycle reconciler is the
  crash-safe backstop until then.
- **Autonomy config UI** (cadence / active character / budget) — the CLI + bin read
  `aiart4never_autonomy_config` with a safe disabled default; a Customize-panel
  toggle is a thin follow-up.

## Blockers (operator action — cannot be done by the agent)

- **Live publishing + analytics need the operator's OAuth connections**: Composio
  Instagram + Pinterest, and the Higgsfield MCP for character-anchored generation.
  All M2 code is built and gated; flipping it live requires the operator to connect
  these via `/mcp` (or the Customize panel). Until then the loop produces into the
  approval queue and the CLI/UI report connectors as unreachable — by design, not a bug.

## Verdict

**GO to M3.** M2 is code-complete, green on all oracles, and the security chokepoint
is verified. The only thing standing between "produces into the approval queue" and
"posts live" is the operator's channel connections — a deliberate, documented gate.
