/**
 * Director chat-path prompt builders (M1 CANON-NATIVE).
 *
 * MASHUPFORGE-RIP: the legacy one-shot pipeline scaffold
 * (`buildDirectorPlan` / `buildDirectorSystemPrompt` / `buildUserPrompt` /
 * `buildInitialPlanStep`) has been removed. The Director loop now ALWAYS runs
 * the AGENT.md-driven conversational path, so the only prompt builders left
 * here are the live-chat ones:
 *   - `buildDirectorChatSystemPrompt(context, agentInstructions)` — the chat
 *     system stack: AGENT.md contents + the structured canon block + the
 *     character/Element identity lock.
 *   - `buildChatUserTurn(context)` — the operator's raw message, verbatim.
 *   - `PlanContext` — the shared context type both builders read.
 *
 * IMPORTANT (M1): the Director is the AIart4never Studio Director for the
 * ORIGINAL Master4never multiverse — it produces ON-CANON beats featuring the
 * operator's locked characters (Kael PRIME and his variants like Kaelus Vorne)
 * across canon realities. It does NOT trawl franchise/crossover trends,
 * cosplay, or fan-art niches. There is NO trending-search step: the agent's
 * "context" is the canon system block + the locked character Element, not the
 * web.
 *
 * The builders are pure (no IO, no time — the AGENT.md text is passed in) so
 * the unit test can snapshot the assembly and catch regressions when the
 * wording is edited.
 */
import type { SkillRef } from '@/lib/agent-tools/schemas';
// M1 CANON-WIRING: the Director is the AIart4never Studio Director generating
// on-canon Master4never multiverse art. The canon block (full persona + locked
// look + hard rules + reality hallmarks + persistence mandate) is injected into
// the chat system prompt so every drafted prompt stays on-model.
import {
  buildCanonSystemBlock,
  buildCharacterLockBlock,
  type CharacterId,
} from '@/lib/canon';

export interface PlanContext {
  /**
   * M1 CANON-NATIVE: the active CONTENT PILLARS for this beat (e.g.
   * Story-Beat, Variant Reveal, Same Soul, Lore / Poll). Carried under the
   * legacy `niches` key for settings back-compat, but they are canon pillars
   * — NOT franchise/crossover niches.
   */
  niches: string[];
  /**
   * M1 CANON-NATIVE: the canon STYLES for this beat (e.g. cinematic,
   * grimdark, character-study, neo-noir). Carried under the legacy `genres`
   * key for back-compat.
   */
  genres: string[];
  ideaConcept: string;
  skillContext?: SkillRef[];
  /**
   * M1 CANON-WIRING: the active Master4never canon character whose persona +
   * locked look + hard rules shape the director's drafts. Defaults to 'kael'
   * (the protagonist / narrator) when the caller omits it.
   */
  characterId?: CharacterId;
}

// ---------------------------------------------------------------------------
// CHAT-PATH builders (live AgentConsole STREAM path).
//
// AGENT.md REWIRE: the chat path is now a GENUINE intelligent agent driven by
// the single AGENT.md instruction file + the STRUCTURED canon — NOT the rigid
// 6-step director scaffold. The system prompt = AGENT.md contents (who he is +
// how he behaves, loaded server-side) + buildCanonSystemBlock (the structured
// canon data) + buildCharacterLockBlock (the Element/identity lock). There is
// NO buildDirectorPlan scaffold here: the agent decides converse-vs-generate
// from AGENT.md + the operator's raw message, the way Claude Code decides what
// to do from its instructions + the user's turn.
//
// These builders are used ONLY by `handleDirectorStream` →
// `runDirectorLoop({ conversational: true })`; the one-shot pipeline path keeps
// `buildDirectorSystemPrompt` + `buildUserPrompt` (the rigid scaffold) unchanged
// for `handleDirectorMode`, which is being ripped in a later step.
// ---------------------------------------------------------------------------

/**
 * The CHAT system prompt for the AGENT.md-driven agent.
 *
 * Assembles the agent's whole system stack for the live stream path:
 *   1. `agentInstructions` — the AGENT.md file contents (IDENTITY + behavior +
 *      tools + workflow), loaded server-side by `loadAgentInstructions`.
 *   2. `buildCanonSystemBlock(characterId)` — the STRUCTURED canon (persona,
 *      locked look, hard rules, reality hallmarks, persistence mandate) for the
 *      active character. AGENT.md REFERENCES this block; it doesn't duplicate
 *      the data.
 *   3. `buildCharacterLockBlock(characterId)` — the compact identity-lock
 *      fragment with the Higgsfield Element anchor token (`<<<id>>>`), so any
 *      drafted image prompt carries the SAME-man lock + Element verbatim.
 *
 * Deliberately CONTAINS NO `buildDirectorPlan` text — no "Director plan
 * (executed in this order)", no "Beat:", no numbered 6-step scaffold. The agent
 * fills in the workflow with its own intelligence from AGENT.md. Pure function
 * (the AGENT.md text is passed in) so the test suite can pin the assembly.
 */
export function buildDirectorChatSystemPrompt(
  context: PlanContext,
  agentInstructions: string,
): string {
  const characterId: CharacterId = context.characterId ?? 'kael';
  const canonBlock = buildCanonSystemBlock(characterId);
  const lockBlock = buildCharacterLockBlock(characterId);

  return [
    // 1. AGENT.md — who he is + how he behaves + his tools + his workflow.
    agentInstructions.trim(),
    '',
    '---',
    '',
    // 2. The structured canon for the active character (AGENT.md references it).
    '# Canon (structured, authoritative — do not restate to the operator)',
    '',
    canonBlock,
    '',
    // 3. The image-prompt identity lock + Element anchor token. When the agent
    //    drafts an image prompt for this character, it embeds this verbatim so
    //    the look never drifts.
    'When you draft an image prompt for the active canon character, embed this identity lock verbatim — keep the SAME man (face + bone structure + features), carry the Anchor element token so the look never drifts:',
    lockBlock,
  ].join('\n');
}

/**
 * The CHAT user turn. The operator's RAW message, verbatim — NOT wrapped in
 * "Beat: … Execute the director plan". The model reads the system prompt's
 * GATE and decides converse-vs-generate for itself, so a greeting stays a
 * greeting and a real brief triggers the generate flow.
 */
export function buildChatUserTurn(context: PlanContext): string {
  return context.ideaConcept;
}
