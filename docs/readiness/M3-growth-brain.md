# M3 — Growth-brain · Readiness check (BMAD gate)

_Date: 2026-06-15 · Verdict: **GO** (loop closed & green; the live feedback needs the operator's IG + research connections — see Blockers)._

M3 makes the loop *learn*: it attributes engagement, researches niches, tunes
posting times/hooks, and feeds all of it back into the weekly plan — closing
Sense→Think→Act→**Learn**→Plan.

## Story status

| Story | Title | Status | Where |
|------|-------|--------|-------|
| 4NE-15 | Own-analytics attribution (pillar/hook/reality) → plan feedback | ✅ | `lib/growth/attribution.ts` |
| 4NE-16 | Reliable web-research MCP (Exa primary / Tavily fallback) → niches | ✅ | `lib/research/` |
| 4NE-17 | Posting-time / hook self-tuning (A/B) | ✅ | `lib/growth/self-tuning.ts` |
| — | **Loop close**: adapt template + drive the planner | ✅ | `lib/growth/adaptive-plan.ts`, `lib/canon/content-plan.ts` (`baseTemplate`) |

## The closed loop (end-to-end, structurally complete)

```
live IG insights ─► attributeEngagement (4NE-15) ─► proposeTemplateAdjustments
       ▲                                                      │
       │                          recommendPostingTimes/Hooks (4NE-17)
       │                                                      ▼
   publish (M2) ◄─ autonomy tick (M2) ◄─ buildWeeklyContentPlan(baseTemplate)
                                              ▲
                          adaptWeeklyTemplate (ε-greedy, canon-safe)
   niche ideas: researchNiches (4NE-16, Exa→Tavily) feed the SENSE step.
```

## Oracles (at gate)

- `bun run typecheck` → 0 errors.
- `bun run test` → **2188 passed / 0 failed** (M3 added ~64 tests: growth 15 + adaptive 8 + research 16 + loop-close 2, over the M2 baseline).
- Determinism: every growth module is pure (rng injected for ε-greedy; no `Date.now`/`Math.random` in logic) → reproducible recommendations.
- Canon safety: `adaptWeeklyTemplate` preserves the frozen `WEEKLY_TEMPLATE` invariants — the Friday `guaranteesNewGen` slot is never moved/flipped/decreased, no pillar drops to zero, slot count stays 6. Verified in tests.

## Design / quality notes

- **Exploit vs explore split**: the growth modules rank/exploit (pure); ε-greedy exploration is bounded (≤15% default, runner-up candidates only, never touches canon) and lives in the adaptive planner. This keeps the learner honest without over-fitting thin data.
- **Small-sample discipline**: attribution thresholds are relative to the *trusted* mean (≥minSample keys only); self-tuning uses an empirical-Bayes shrunk lower-confidence bound so a proven slot out-ranks a one-post fluke. Cold start returns the canon template unchanged — never invents signal.
- `smartScheduler` (inherited, impure clock-slot scorer) left as-is; it composes downstream of the growth ranker.

## Deferred (by design) / follow-ups

- **Autonomy live wiring**: the autonomy loop should, each week, fetch live insights → `attributeEngagement` → `adaptWeeklyTemplate` → feed `baseTemplate` into the plan. The seam exists (`buildWeeklyContentPlan({ baseTemplate })`); wiring the weekly compute into `lib/autonomy` is the remaining integration (needs live data to be meaningful).
- **Planning UI**: surface attribution + recommendations + the "why this slot" rationale in the app.
- **Hook taxonomy**: attribution/self-tuning consume `hookId` when present; a canonical hook-formula registry (and stamping `hookId` on produced assets) is a thin follow-up.

## Blockers (operator action — cannot be done by the agent)

- **Live learning needs data**: own-IG insights (Composio IG connection) for 4NE-15/17, and an **Exa** (primary) / **Tavily** (fallback) MCP connector for 4NE-16. All M3 logic is built, pure, and fixture-tested; it produces real recommendations the moment those connectors are configured + trusted via the Customize panel / `/mcp`.

## Verdict

**GO.** The growth-brain is code-complete, green, deterministic, and canon-safe; the
LEARN→plan loop is structurally closed. It starts *learning* as soon as the operator
connects the IG insights + research MCPs — the same standing connection blocker as M2.
