/**
 * v1.2 — Director Route 2.0 plan step (M1 CANON-NATIVE rewrite).
 *
 * The very first entry in the run log. Captures the model's
 * (or our pre-baked) plan for the loop — "I will pick the
 * beat, write the scene, critique for canon compliance,
 * refine, generate, persist" — so the Replay UI can show
 * *why* the agent took the actions it did, not just *what*.
 *
 * IMPORTANT (M1): the Director is the AIart4never Studio Director
 * for the ORIGINAL Master4never multiverse — it produces ON-CANON
 * beats featuring the operator's locked characters (Kael PRIME and
 * his variants like Kaelus Vorne) across canon realities. It does
 * NOT trawl franchise/crossover trends, cosplay, or fan-art niches.
 * There is NO trending-search step: the agent's "context" is the
 * canon system block + the locked character Element, not the web.
 *
 * Two exports:
 *   - `buildDirectorPlan(context)` returns the plan text.
 *   - `buildDirectorSystemPrompt(context)` returns the full
 *     system prompt the model sees; it embeds the plan, the
 *     canon block, and the beat orientation. The same context
 *     is also passed to the user prompt (`buildUserPrompt`).
 *
 * The system prompt deliberately calls out the canon beat loop
 * shape (`plan-beat → draft-scene → critique → refine →
 * generate → persist`) so a model that's not familiar with the
 * director pattern still produces a predictable tool-call
 * sequence. The model is free to skip steps (e.g. if the beat
 * is already obvious, it can go straight to `generate_prompt`),
 * but the upper bound is enforced by Vercel AI SDK's
 * `stopWhen: stepCountIs(8)`.
 *
 * The plan is pure (no IO, no time) so the unit test can
 * snapshot the output and catch regressions when the
 * system prompt is edited.
 */
import type { SkillRef } from '@/lib/agent-tools/schemas';
// M1 CANON-WIRING: the Director is the AIart4never Studio Director generating
// on-canon Master4never multiverse art. The canon block (full persona + locked
// look + hard rules + reality hallmarks + persistence mandate) is injected into
// the director system prompt so every drafted prompt stays on-model.
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

/**
 * The canon beat plan the model is told to follow. Returned as a
 * single string so it can be embedded in the system prompt and also
 * stored as the first step's `reasoning` field.
 *
 * M1 CANON-NATIVE: there is NO trending-search step. The agent produces
 * an ON-CANON Master4never beat — it picks the featured character + reality
 * + content pillar, writes a canon-anchored SCENE prompt (the canon system
 * block keeps it on-model; the locked Element placeholder `<<<…>>>` carries
 * the character identity — the agent writes the WHAT/WHERE, the Element
 * carries the WHO), critiques it for CANON COMPLIANCE + quality, generates
 * via the Element-anchored generate_image tool, and persists to the approval
 * queue (the locked watermark → crop → host pipeline runs downstream).
 */
export function buildDirectorPlan(context: PlanContext): string {
  const pillarsLine =
    context.niches.length > 0
      ? `Content pillars in play for this beat: ${context.niches.join(', ')}.`
      : 'No pillars supplied — I will infer the beat (character + reality + pillar) from the request alone.';

  const skillsLine =
    context.skillContext && context.skillContext.length > 0
      ? `Active skills to fold into the draft: ${context.skillContext.map((s) => s.name).join(', ')}.`
      : 'No skills active — the draft will use the base canon persona only.';

  return [
    'Director plan (executed in this order, stop early if budget is exhausted):',
    `1. Determine the beat — the featured character + reality + content pillar (from the request / weekly template). Stay on-canon; never reach for franchises, crossovers, cosplay, or merch.`,
    `2. generate_prompt({niches, genres, angle, skillContext}) — write a canon-anchored SCENE prompt: the WHAT (action/pose/wardrobe) and WHERE (the reality's hallmark setting). The canon system block keeps it on-model; the locked character Element carries the WHO — embed the Anchor element token verbatim.`,
    `3. critique_prompt({prompt, requirements}) — score 0..1 for CANON COMPLIANCE (right reality, no off-canon traits — e.g. no cyberdeck on a W40K variant) AND quality. If score < 0.7, refine.`,
    `4. (Optional, max 2 refine passes) generate_prompt again with the critique's issues as extra context.`,
    `5. generate_image({model, prompt, settings}) — render the beat via Higgsfield, Element-anchored (NOT a crossover prompt). Persist to the approval queue; the locked watermark → crop → host pipeline runs downstream.`,
    `6. Finalize: output the final prompt as the assistant text (no tool call). Stop — the route layer captures the result.`,
    '',
    pillarsLine,
    skillsLine,
    `Beat (the on-canon Master4never concept to realise): "${context.ideaConcept}".`,
    '(Optional SENSE: if — and only if — a research connector is configured, the agent may pull canon-relevant reference via lib/research; this is NOT a default step and is never crossover trend-trawling.)',
  ].join('\n');
}

/**
 * The full system prompt. Pre-baked (not generated by the
 * model) so the Replay UI can render the same string the
 * model saw, and so the test suite can pin the wording.
 */
export function buildDirectorSystemPrompt(context: PlanContext): string {
  const plan = buildDirectorPlan(context);
  const characterId: CharacterId = context.characterId ?? 'kael';
  // M1 CANON-WIRING: the director now generates on-canon Master4never
  // multiverse art (NOT third-party crossovers). The canon block carries the
  // active character's persona, locked look, hard rules, reality hallmarks,
  // and the persistence/Element mandate so every drafted prompt stays on-model.
  const canonBlock = buildCanonSystemBlock(characterId);
  // M1 CANON-WIRING (#4): the compact identity-lock fragment for the active
  // character — the SAME-man lock + the Higgsfield Element anchor token
  // (`<<<id>>>`). We append it to the IMAGE-PROMPT instructions (rather than
  // threading it through the model-filled generate_prompt tool input, which
  // would be unreliable) so every drafted image prompt carries the Element
  // token + lock verbatim. See the report for the rationale on this path.
  const lockBlock = buildCharacterLockBlock(characterId);

  return [
    'You are the AIart4never Studio Director — the agent that plans and writes on-canon image prompts for the Master4never multiverse. Every prompt you draft realises the operator\'s ORIGINAL fictional universe and its locked recurring characters; never lean on copyrighted franchises, brands, trademarks, or named third-party characters.',
    '',
    canonBlock,
    '',
    'You operate a multi-step tool-use loop. The plan below is the recommended shape — feel free to skip steps when they are not needed, but always end with a final assistant text containing the prompt the user will use.',
    '',
    plan,
    '',
    'Rules:',
    '- Every tool call MUST match the JSON schema declared by the tool (the AI SDK enforces this; the route will surface a 4xx if you slip).',
    '- critique_prompt is the quality gate. If score < 0.7, regenerate the draft at most twice — do not loop forever.',
    '- When the draft renders the active canon character, embed the identity lock below verbatim into the image prompt — keep the SAME man (face + bone structure + features), carry the Anchor element token so the look never drifts:',
    lockBlock,
    '- The final assistant text is what the user sees. It MUST be the prompt draft (40-150 words), not a summary, not JSON, not a markdown fence.',
    '- If a tool returns an error part, you may try once more with adjusted input. If it still fails AND you cannot produce a usable prompt, finalize with exactly "DIRECTOR_FAILED: <one short sentence naming the issue>" — never a free-form apology. (The pipeline detects this sentinel and falls back to the verbatim concept; an undetected explanation would be sent to the image model as the prompt.)',
  ].join('\n');
}

/**
 * The single user-message the loop is started with. Kept
 * short on purpose — the system prompt carries the plan, the
 * user message carries the brief.
 *
 * PIPELINE PATH ONLY. This is the one-shot beat-generator turn used by the
 * old `handleDirectorMode` pipeline: it forces EVERY message into "Beat: …
 * Execute the director plan", so the loop always runs the full generate flow.
 * The LIVE CHAT path (`handleDirectorStream`) must NOT use this — see
 * `buildChatUserTurn` for the conversational turn that lets the model decide
 * converse-vs-generate. Leave this unchanged: the pipeline is cut later and
 * its tests pin this exact wording.
 */
export function buildUserPrompt(context: PlanContext): string {
  return [
    // M1 CANON-NATIVE: "Beat" (not "Angle") is the canon framing; pillars and
    // styles ride the legacy niches/genres keys for settings back-compat.
    `Beat: ${context.ideaConcept}`,
    '',
    `Content pillars: ${context.niches.join(', ') || '(none)'}`,
    `Styles: ${context.genres.join(', ') || '(none)'}`,
    '',
    'Execute the director plan and return the final on-canon prompt as your terminal assistant text.',
  ].join('\n');
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

/**
 * Build the initial `plan` step that goes at idx 0 of the log.
 * The step is *not* generated by the model — it's a pre-baked
 * record so the Replay UI has the plan to render even when the
 * model is mocked.
 */
export function buildInitialPlanStep(
  context: PlanContext,
  opts: { timestamp?: number; clock?: () => number } = {},
): { type: 'plan'; reasoning: string; cost: number; timestamp: number } {
  const clock = opts.clock ?? (() => Date.now());
  return {
    type: 'plan',
    reasoning: buildDirectorPlan(context),
    cost: 0,
    timestamp: opts.timestamp ?? clock(),
  };
}
