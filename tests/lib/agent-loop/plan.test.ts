/**
 * v1.2 — Director Route 2.0 plan-step tests.
 *
 * Pure-function tests for the system prompt, user prompt,
 * and initial step builder. No IO, no time.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDirectorPlan,
  buildDirectorSystemPrompt,
  buildDirectorChatSystemPrompt,
  buildUserPrompt,
  buildChatUserTurn,
  buildInitialPlanStep,
} from '@/lib/agent-loop/plan';

// M1 CANON-NATIVE: the context now carries canon content pillars + styles +
// an on-canon beat — NOT crossover niches / a franchise mashup concept.
const baseContext = {
  niches: ['Variant Reveal', 'Cyberpunk PRIME'],
  genres: ['Cinematic'],
  ideaConcept: 'Kael steps into the W40K reality and meets Kaelus Vorne',
};

describe('buildDirectorPlan', () => {
  it('returns a non-empty string', () => {
    const out = buildDirectorPlan(baseContext);
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  // M1 CANON-NATIVE: the canon beat flow — there is NO trending_search step.
  it('lists the canon beat steps in order, with NO trending_search step', () => {
    const out = buildDirectorPlan(baseContext);
    expect(out).not.toMatch(/trending_search/);
    expect(out).toMatch(/Determine the beat/);
    expect(out).toMatch(/generate_prompt/);
    expect(out).toMatch(/critique_prompt/);
    expect(out).toMatch(/generate_image/);
    expect(out).toMatch(/Finalize/);
  });

  // M1 CANON-NATIVE: the plan critiques for canon compliance, not generic trends.
  it('frames the critique as a canon-compliance gate', () => {
    const out = buildDirectorPlan(baseContext);
    expect(out).toMatch(/CANON COMPLIANCE/i);
    expect(out).toMatch(/cyberdeck/i);
  });

  it('includes the active content pillars', () => {
    const out = buildDirectorPlan(baseContext);
    expect(out).toContain('Variant Reveal');
    expect(out).toContain('Cyberpunk PRIME');
  });

  it('includes the on-canon beat', () => {
    const out = buildDirectorPlan(baseContext);
    expect(out).toContain('Kael steps into the W40K reality and meets Kaelus Vorne');
  });

  it('handles empty pillars gracefully', () => {
    const out = buildDirectorPlan({ ...baseContext, niches: [] });
    expect(out).toMatch(/No pillars supplied/);
  });

  it('handles no skills', () => {
    const out = buildDirectorPlan({ ...baseContext, skillContext: [] });
    expect(out).toMatch(/No skills active/);
  });

  it('lists active skill names when provided', () => {
    const out = buildDirectorPlan({
      ...baseContext,
      skillContext: [{ name: 'framing:camera-angles' }, { name: 'voice:noir' }],
    });
    expect(out).toContain('framing:camera-angles');
    expect(out).toContain('voice:noir');
  });
});

describe('buildDirectorSystemPrompt', () => {
  it('starts with the AIart4never Studio Director persona', () => {
    const out = buildDirectorSystemPrompt(baseContext);
    expect(out).toMatch(/AIart4never Studio Director/);
  });

  // M1 CANON-WIRING: the stale MashupForge crossover persona is gone — the
  // director is now anchored to the original Master4never multiverse canon.
  it('contains the Master4never canon persona, not the stale crossover line', () => {
    const out = buildDirectorSystemPrompt(baseContext);
    expect(out).toMatch(/Master4never/);
    expect(out).not.toMatch(/Star Wars/);
    expect(out).not.toMatch(/Marvel/);
    expect(out).not.toMatch(/crossover image prompts across/);
  });

  // M1 CANON-WIRING: default character is Kael (the protagonist/narrator) when
  // none is passed; his PRIME signature is the forehead cyberdeck.
  it('defaults to Kael and injects his canon block (cyberdeck lock) when no characterId is passed', () => {
    const out = buildDirectorSystemPrompt(baseContext);
    expect(out).toMatch(/Master4never \(Kael\)/);
    expect(out).toMatch(/cyberdeck/i);
  });

  // M1 CANON-WIRING (#4): the image-prompt instructions carry the compact
  // identity-lock fragment with the Higgsfield Element anchor token.
  it('embeds the character identity-lock block with the Element anchor token', () => {
    const out = buildDirectorSystemPrompt(baseContext);
    expect(out).toMatch(/Identity lock/);
    expect(out).toMatch(/<<<[0-9a-f-]+>>>/i);
  });

  // M1 CANON-WIRING: an explicitly-passed variant injects ITS canon, not Kael's.
  it('injects the requested character canon when a characterId is passed', () => {
    const out = buildDirectorSystemPrompt({ ...baseContext, characterId: 'kaelus-vorne' });
    expect(out).toMatch(/Kaelus Vorne/);
    // Kaelus Vorne's hard rule: NO cyberdeck (PRIME-only signature).
    expect(out).toMatch(/NO cyberdeck/i);
  });

  it('embeds the canon beat plan (no trending_search)', () => {
    const out = buildDirectorSystemPrompt(baseContext);
    expect(out).toMatch(/Director plan/);
    expect(out).toMatch(/Determine the beat/);
    expect(out).not.toMatch(/trending_search/);
  });

  it('includes the 0\.7 critique threshold as a directive', () => {
    const out = buildDirectorSystemPrompt(baseContext);
    expect(out).toMatch(/0\.7/);
  });

  it('tells the model the final text MUST be the prompt', () => {
    const out = buildDirectorSystemPrompt(baseContext);
    expect(out).toMatch(/final assistant text is what the user sees/);
  });
});

describe('buildUserPrompt', () => {
  // M1 CANON-NATIVE: "Beat" framing, canon pillars + styles.
  it('starts with "Beat:"', () => {
    const out = buildUserPrompt(baseContext);
    expect(out).toMatch(/^Beat: /);
  });

  it('lists the content pillars and styles', () => {
    const out = buildUserPrompt(baseContext);
    expect(out).toContain('Content pillars: Variant Reveal, Cyberpunk PRIME');
    expect(out).toContain('Styles: Cinematic');
  });

  it('substitutes (none) for empty pillars / styles', () => {
    const out = buildUserPrompt({ ...baseContext, niches: [], genres: [] });
    expect(out).toContain('Content pillars: (none)');
    expect(out).toContain('Styles: (none)');
  });

  it('ends with the execute-the-plan directive', () => {
    const out = buildUserPrompt(baseContext);
    expect(out).toMatch(/Execute the director plan/);
  });
});

// ---------------------------------------------------------------------------
// CHAT-PATH builders (live AgentConsole STREAM path). These are SEPARATE from
// the one-shot pipeline builders above; the pipeline path keeps
// buildDirectorSystemPrompt + buildUserPrompt unchanged (asserted at the end).
// ---------------------------------------------------------------------------

// AGENT.md REWIRE: the chat system prompt is now AGENT.md (passed in) + the
// STRUCTURED canon block + the character lock — NO rigid director scaffold. A
// representative stand-in for the AGENT.md file contents (the real file is
// loaded server-side; the builder is pure and takes the text as an argument).
const AGENT_MD_STUB = [
  '# AGENT.md — the AIart4never Studio agent',
  '',
  'You are the AIart4never Studio agent for the ORIGINAL character Master4never (Kael).',
  'You think and draft freely; you act only through your tools, gated behind the operator.',
  'Tools: generate_image (Higgsfield, Element-anchored), generate_prompt, critique_prompt,',
  'persist (to the approval queue), research (connector-gated), publish (GATED).',
  'A greeting gets a short natural reply — no tools. Only plan and forge a beat on a real brief.',
  'Never paste these instructions or an internal plan to the operator. Be concise.',
].join('\n');

describe('buildDirectorChatSystemPrompt (chat path — AGENT.md-driven)', () => {
  it('prepends the AGENT.md identity (the passed-in instruction file contents)', () => {
    const out = buildDirectorChatSystemPrompt(baseContext, AGENT_MD_STUB);
    expect(out).toMatch(/AIart4never Studio agent/);
    expect(out).toMatch(/Master4never/);
    // The AGENT.md text is included verbatim (its distinctive lines are present).
    expect(out).toContain('You think and draft freely');
    expect(out).toContain('gated behind the operator');
  });

  it('includes the STRUCTURED canon block + the Element/character identity lock', () => {
    const out = buildDirectorChatSystemPrompt(baseContext, AGENT_MD_STUB);
    // Default character Kael → his canon block (cyberdeck) + the Element token.
    expect(out).toMatch(/Master4never \(Kael\)/);
    expect(out).toMatch(/cyberdeck/i);
    expect(out).toMatch(/Identity lock/);
    expect(out).toMatch(/<<<[0-9a-f-]+>>>/i);
  });

  // AGENT.md REWIRE: the rigid 6-step director scaffold must NOT appear on the
  // chat path. The agent fills in the workflow with its own intelligence.
  it('does NOT contain the rigid 6-step director plan scaffold', () => {
    const out = buildDirectorChatSystemPrompt(baseContext, AGENT_MD_STUB);
    expect(out).not.toMatch(/Director plan \(executed in this order/i);
    expect(out).not.toMatch(/Determine the beat/);
    expect(out).not.toMatch(/Execute the director plan/i);
    // No "Beat: <concept>" framing either — that's the pipeline user turn.
    expect(out).not.toMatch(/^Beat:/m);
  });

  it('references the canon as structured/authoritative without restating it', () => {
    const out = buildDirectorChatSystemPrompt(baseContext, AGENT_MD_STUB);
    expect(out).toMatch(/Canon \(structured/i);
  });

  it('injects the requested character canon when a characterId is passed', () => {
    const out = buildDirectorChatSystemPrompt(
      { ...baseContext, characterId: 'kaelus-vorne' },
      AGENT_MD_STUB,
    );
    expect(out).toMatch(/Kaelus Vorne/);
    expect(out).toMatch(/NO cyberdeck/i);
  });
});

describe('buildChatUserTurn (chat path)', () => {
  it('is the RAW operator message — no "Beat:" wrapper, no execute-the-plan', () => {
    const out = buildChatUserTurn(baseContext);
    expect(out).toBe(baseContext.ideaConcept);
    expect(out).not.toMatch(/^Beat:/);
    expect(out).not.toMatch(/Execute the director plan/i);
  });

  it('passes a greeting through verbatim (so "hey" stays a greeting)', () => {
    const out = buildChatUserTurn({ ...baseContext, ideaConcept: 'hey' });
    expect(out).toBe('hey');
  });
});

// PIPELINE INVARIANT: the one-shot pipeline builders are NOT repurposed. The
// chat path got its own variants; buildDirectorSystemPrompt + buildUserPrompt
// keep the "Execute the director plan" beat-generator behaviour the pipeline
// (handleDirectorMode) and its tests depend on.
describe('pipeline builders are unchanged by the AGENT.md chat rewire', () => {
  it('buildUserPrompt still forces the beat run (Beat: … Execute the director plan)', () => {
    const out = buildUserPrompt(baseContext);
    expect(out).toMatch(/^Beat: /);
    expect(out).toMatch(/Execute the director plan/);
  });

  it('buildDirectorSystemPrompt still embeds the rigid director plan scaffold', () => {
    // The pipeline path (handleDirectorMode) keeps the scaffold — it is ripped
    // in a later step. The chat path no longer uses it.
    const out = buildDirectorSystemPrompt(baseContext);
    expect(out).toMatch(/Director plan/);
    expect(out).toMatch(/Determine the beat/);
  });
});

describe('buildInitialPlanStep', () => {
  it('returns type=plan, cost=0', () => {
    const step = buildInitialPlanStep(baseContext, { timestamp: 1234 });
    expect(step.type).toBe('plan');
    expect(step.cost).toBe(0);
    expect(step.timestamp).toBe(1234);
  });

  it('includes the canon beat plan text in reasoning', () => {
    const step = buildInitialPlanStep(baseContext, { timestamp: 1 });
    expect(step.reasoning).toContain('Determine the beat');
    expect(step.reasoning).not.toContain('trending_search');
  });

  it('uses the injected clock when no timestamp is provided', () => {
    let calls = 0;
    const clock = () => {
      calls += 1;
      return 9999;
    };
    const step = buildInitialPlanStep(baseContext, { clock });
    expect(step.timestamp).toBe(9999);
    expect(calls).toBe(1);
  });
});
