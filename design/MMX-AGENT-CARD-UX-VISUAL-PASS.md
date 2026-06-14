# MMX AI Agent Card — UX Visual Pass

**Brief:** [`docs/bmad/briefs/MMX-AGENT-CARD-UX-VISUAL-PASS.md`](../docs/bmad/briefs/MMX-AGENT-CARD-UX-VISUAL-PASS.md)
**Story:** DESIGN-MMX-001
**Status:** Shipped (2026-04-30)
**Implementation commit:** see `git log --grep="visual pass"` on `main`
**Files touched:** `components/SettingsModal.tsx`, `docs/design/patterns/api-key-paste-form.md`

---

## Summary

The MMX AI Agent card surface had grown organically through five commits
(`5e8dc4a`, `1564c1a`, `75e0c85`, `96d271e`, `b2a2311`). Each landed
correct functionality but the *visual layer* drifted: button labels
mismatched between panels, success was silent, and "needs setup" UI was
duplicated logically across the hoisted CTA and the active-agent panel
even though only one rendered at a time. This pass reconciles the
surface without touching flow, endpoints, or auto-install logic.

## Decisions

### 1. Hoisted CTA vs active-agent panel — single source of truth

**Before.** Two panels each rendered their own "needs setup" UI:

- Hoisted CTA (`activeAiAgent !== 'mmx' && needs-setup`): rich form with
  API-key input + OAuth fallback link + caption.
- Active-agent panel (`activeAiAgent === 'mmx'`): three near-identical
  branches (Loading / Not Installed / Not Authenticated) each with just
  a `Launch MMX Setup` button. No API-key input.

The two were never on screen simultaneously — the `activeAiAgent` axis
made them mutually exclusive — but the *logic* was duplicated and the
*experience* was inconsistent. A user with MMX as active agent who
needed to authenticate saw a degraded UI compared to a user on Pi.dev
clicking the MMX card.

**After.** A single inline `mmxSetupBlock` JSX value defined in the
render scope of `SettingsModal.tsx`. Both panels reuse it for any
needs-setup state. Pixel-identical UX regardless of active agent.

### 2. Authenticated state — compact + reconfigure path

**Before.** Active-agent panel rendered a single line:
`MMX authenticated and ready.` Reconfiguration required either
deselecting MMX, clicking the card to re-trigger setup, or running mmx
commands manually in a separate terminal.

**After.**

```
✓ MMX is authenticated and ready (mmx 1.2.3).
Open MMX CLI to change provider/model
```

- Green checkmark + version (when known) gives a definite "good" state.
- Underlined text link below opens the same tmux flow used by the
  needs-setup OAuth fallback. No new endpoint or handler — `handleMmxSetup`
  is idempotent (server-side `mmx auth status` short-circuits the login,
  bash drops into an interactive shell).

### 3. CTA hierarchy — paste-key primary, OAuth fallback secondary

**Decision:** the gold `Save` button on the API-key input is the
primary action. The OAuth-via-terminal path is a smaller underlined
text button below, rendered as a sentence (`or sign in via terminal
(OAuth)`).

**Rationale.** Users with an API key in hand finish setup in one
roundtrip — no terminal, no tmux session. The MiniMax docs themselves
present `mmx auth login --api-key sk-…` as the canonical path
(`platform.minimax.io/docs/token-plan/minimax-cli`). The OAuth flow is
genuinely useful for users without an API key but represents the
slower path; rendering it as equal-weight gold competed visually for
no UX win.

The Pi.dev panel's existing `Launch Pi.dev Setup` button stays gold —
no API-key alternative exists for Pi, so the gold button is the only
action.

### 4. Success/error feedback — visible and bounded

**Before.** Successful API-key save → form silently disappears as the
card flips Not Authenticated → Available. No confirmation. Failure →
inline red text persisting until next attempt.

**After.**

- New transient state `mmxJustAuthed` flips true after `/api/mmx/setup`
  returns 200 *and* `/api/mmx/status` confirms `authenticated:true`.
  Auto-clears after 3.5s via a `useEffect` cleanup. Renders inline:
  ```
  ✓ MMX authenticated. Open the terminal anytime to pick a provider/model.
  ```
- Errors keep the inline red-text pattern but gain `role="alert"` for
  screen-reader parity with the rest of the app's destructive-state
  messages.

The 3.5s window is intentional: long enough to read, short enough that
returning users a minute later don't see ghost confirmations.

### 5. Microcopy harmonization

| Before | After | Why |
|---|---|---|
| `Checking MMX CLI status…` (CTA) / `Checking MMX status…` (panel) | `Checking MMX status…` everywhere | The section heading is already "MMX CLI" — repeating "CLI" in body copy is noise. |
| `MMX CLI is not installed yet.` | `MMX is not installed yet.` | Same — "CLI" is implicit in this section. |
| `Launch MMX Setup` (every state) / `Install + Set Up MMX` (CTA, sometimes) | `Sign in via terminal (OAuth)` / `Install + sign in via terminal (OAuth)` | "Setup" was the dev's working word, not the user's. The user's mental model is "sign in" (OAuth) — which is what the tmux flow actually does. |
| `MMX authenticated and ready.` | `✓ MMX is authenticated and ready (mmx <version>).` | Adds the version when known + a glyph the eye catches in the steady state. |

### 6. API-key paste pattern → reusable spec

This is the first instance of "paste secret → server stores it
locally → status flips" in the project. Documented as a pattern at
[`docs/design/patterns/api-key-paste-form.md`](../docs/design/patterns/api-key-paste-form.md)
so the next service that needs the same treatment (Pi.dev key,
Leonardo key, etc.) doesn't re-invent the layout, microcopy, or
feedback rules.

## Out of scope — held for future briefs

- **Pi.dev card parity.** Pi has its own status fields and an
  install-check that's structurally different (the auto-install message
  text was kept generic for now). A follow-up brief should align the
  two cards once Pi gets an analogous API-key flow.
- **Toast system.** Inline confirmation/error works at this density of
  feedback. If Settings grows more concurrent state changes, a toast
  surface (top-right, dismissable) becomes the right answer.
- **Provider/model selectors in-card.** The user still has to drop into
  the tmux shell to run `mmx config set provider …`. Surfacing those as
  in-card dropdowns requires knowing the valid options for each, which
  isn't exposed by `mmx-cli` today.

## Acceptance criteria — verification

- [x] Hoisted CTA + active-agent panel never both render needs-setup
      UI. Verified by inspection of mutual-exclusion conditions
      (`activeAiAgent !== 'mmx'` vs `=== 'mmx'`).
- [x] Visible consistent feedback on success (`✓ Authenticated` badge
      + 3.5s auto-clear) and error (inline red text + `role="alert"`).
- [x] CTA hierarchy: API-key Save = gold; OAuth = underlined text link.
- [x] Microcopy normalized — see table above.
- [x] API-key paste pattern documented at
      `docs/design/patterns/api-key-paste-form.md`.
- [ ] QA visual + functional sign-off (pending QA dispatch).
